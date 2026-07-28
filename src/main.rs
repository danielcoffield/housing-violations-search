use chrono::{Duration, Local, Utc};
use indicatif;
use reqwest;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

mod bbl;

#[derive(Deserialize)]
struct Config {
    api_token: String,
}

const DAYS_BACK: i64 = 365;
const OUTPUT_PATH: &str = "data/violations.json";

#[derive(Debug, Deserialize, Serialize, Clone)]
struct Violation {
    #[serde(rename = "violationid")]
    violation_id: String,
    apartment: Option<String>,
    class: ViolationClass,
    #[serde(rename = "approveddate")]
    approved_date: String,
    #[serde(rename = "housenumber")]
    house_number: String,
    #[serde(rename = "streetname")]
    street_name: String,
    boro: String,
    block: String,
    lot: String,
    #[serde(rename = "novdescription")]
    description: Option<String>,
    bin: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "UPPERCASE")]
enum ViolationClass {
    A,
    B,
    C,
    #[serde(other)]
    Other,
}

impl ViolationClass {
    fn as_str(&self) -> &'static str {
        match self {
            ViolationClass::A => "A",
            ViolationClass::B => "B",
            ViolationClass::C => "C",
            ViolationClass::Other => "Other",
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config_str = std::fs::read_to_string("config.toml").expect("Config.toml not found!");
    let config: Config = toml::from_str(&config_str).expect("Invalid config.toml");

    let violations = fetch_violations(&config.api_token)?;
    let by_building = group_by_building(&violations);

    let bbls: Vec<String> = by_building.keys().cloned().collect();
    let unit_counts = get_units_per_building(bbls, &config.api_token)?;

    let buildings = build_output(by_building, &unit_counts);

    let site_data = SiteData {
        generated_at: Utc::now().to_rfc3339(),
        snapshot_description: "all currently open HPD violations".to_string(),
        buildings,
    };

    let json = serde_json::to_string_pretty(&site_data)?;
    if let Some(parent) = std::path::Path::new(OUTPUT_PATH).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(OUTPUT_PATH, json)?;

    Ok(())
}

fn fetch_violations(api_token: &str) -> Result<Vec<Violation>, Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()?;

    let local = Local::now();
    let cutoff = local - Duration::days(DAYS_BACK);
    let date_string = cutoff.format("%Y-%m-%d").to_string();

    let mut all_violations = Vec::new();
    let mut offset = 0;

    let spinner = indicatif::ProgressBar::new_spinner();
    spinner.enable_steady_tick(std::time::Duration::from_millis(100));
    spinner.set_message("Fetching violations...");

    loop {
        let where_clause = format!(
            "approveddate > '{}' AND violationstatus='Open'",
            date_string
        );
        let response = client
            .get("https://data.cityofnewyork.us/resource/wvxf-dwi5.json")
            .header("X-App-Token", api_token)
            .query(&[
                ("$where", where_clause.as_str()),
                ("$limit", "1000"),
                ("$offset", &offset.to_string()),
            ])
            .send()?;

        let text = response.text()?;
        if text.starts_with('<') {
            return Err(
                format!("API returned HTML error: {}", &text[..200.min(text.len())]).into(),
            );
        }
        let batch: Vec<Violation> = serde_json::from_str(&text)?;
        let count = batch.len();

        all_violations.extend(batch);
        spinner.set_message(format!("Fetched {} violations...", all_violations.len()));

        if count < 1000 {
            break;
        }
        offset += 1000;
    }

    spinner.finish_and_clear();

    all_violations.retain(|v| v.apartment.is_some());

    Ok(all_violations)
}

struct BuildingAccumulator {
    address: String,
    boro: String,
    // Not every violation record carries a BIN (older/ungeocoded entries
    // sometimes lack one) even when other violations for the same building
    // do — so this is filled in opportunistically as records are grouped,
    // rather than assumed from just the first violation seen.
    bin: Option<String>,
    apartments: HashMap<String, Vec<Violation>>,
}

fn group_by_building(violations: &[Violation]) -> HashMap<String, BuildingAccumulator> {
    let mut buildings: HashMap<String, BuildingAccumulator> = HashMap::new();

    for v in violations {
        let bbl = bbl::construct_bbl(&v.boro, &v.block, &v.lot);
        let address = format!("{} {}", v.house_number, capitalize(&v.street_name));
        let apartment = v.apartment.clone().unwrap();

        let entry = buildings
            .entry(bbl.clone())
            .or_insert_with(|| BuildingAccumulator {
                address,
                boro: v.boro.clone(),
                bin: v.bin.clone(),
                apartments: HashMap::new(),
            });

        if entry.bin.is_none() {
            entry.bin = v.bin.clone();
        }

        entry
            .apartments
            .entry(apartment)
            .or_insert_with(Vec::new)
            .push(v.clone());
    }

    buildings
}

#[derive(Serialize)]
struct SiteData {
    generated_at: String,
    snapshot_description: String,
    buildings: Vec<BuildingOutput>,
}

#[derive(Serialize)]
struct BuildingOutput {
    bbl: String,
    address: String,
    boro: String,
    unit_count: Option<u32>,
    apartment_count: usize,
    density_score: Option<f32>,
    apartments: Vec<ApartmentOutput>,
    // None when no violation for this building had a BIN. The frontend
    // falls back to plain (non-linked) text in that case rather than
    // building a broken HPD Online link.
    bin: Option<String>,
}

#[derive(Serialize)]
struct ApartmentOutput {
    apartment: String,
    violations: Vec<ViolationOutput>,
}

#[derive(Serialize)]
struct ViolationOutput {
    violation_id: String,
    class: String,
    approved_date: String,
    description: String,
}

fn build_output(
    by_building: HashMap<String, BuildingAccumulator>,
    unit_counts: &HashMap<String, u32>,
) -> Vec<BuildingOutput> {
    let mut buildings: Vec<BuildingOutput> = by_building
        .into_iter()
        .map(|(bbl, acc)| {
            let unit_count = unit_counts.get(&bbl).copied();
            let apartment_count = acc.apartments.len();

            let density_score = unit_count.and_then(|units| {
                if units == 0 {
                    None
                } else {
                    Some(apartment_count as f32 / units as f32)
                }
            });

            let apartments = acc
                .apartments
                .into_iter()
                .map(|(apartment, mut viols)| {
                    viols.sort_by(|a, b| b.approved_date.cmp(&a.approved_date));
                    let violations = viols
                        .into_iter()
                        .map(|v| ViolationOutput {
                            violation_id: v.violation_id,
                            class: v.class.as_str().to_string(),
                            approved_date: v.approved_date,
                            description: v.description.unwrap_or_default(),
                        })
                        .collect();
                    ApartmentOutput {
                        apartment,
                        violations,
                    }
                })
                .collect();

            BuildingOutput {
                bbl,
                address: acc.address,
                boro: acc.boro,
                unit_count,
                apartment_count,
                density_score,
                apartments,
                bin: acc.bin,
            }
        })
        .collect();

    buildings.sort_by(|a, b| match (a.density_score, b.density_score) {
        (Some(x), Some(y)) => y.partial_cmp(&x).unwrap(),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => b.apartment_count.cmp(&a.apartment_count),
    });

    buildings
}

fn capitalize(s: &str) -> String {
    s.split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().to_string() + &chars.as_str().to_lowercase(),
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}

fn get_units_per_building(
    bbls: Vec<String>,
    api_token: &str,
) -> Result<HashMap<String, u32>, Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    let mut map = HashMap::new();

    for chunk in bbls.chunks(20) {
        let bbl_list = chunk
            .iter()
            .map(|b| format!("{}.0", b))
            .collect::<Vec<_>>()
            .join(",");

        let where_clause = format!("bbl in({})", bbl_list);

        let response = client
            .get("https://data.cityofnewyork.us/resource/64uk-42ks.json")
            .header("X-App-Token", api_token)
            .query(&[
                ("$select", "bbl,unitsres"),
                ("$where", &where_clause),
                ("$limit", "1000"),
            ])
            .send()?;

        let text = response.text()?;
        if text.starts_with('{') {
            return Err(format!("PLUTO API error: {}", &text[..200.min(text.len())]).into());
        }
        let records: Vec<serde_json::Value> = serde_json::from_str(&text)?;

        for r in records {
            if let (Some(bbl), Some(units)) = (
                r["bbl"].as_str(),
                r["unitsres"].as_str().and_then(|u| u.parse::<u32>().ok()),
            ) {
                let clean_bbl = bbl.split('.').next().unwrap_or(bbl);
                map.insert(clean_bbl.to_string(), units);
            }
        }
    }

    Ok(map)
}
