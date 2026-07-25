use chrono::{Duration, Local};
use comfy_table::{Attribute, Cell, Color, Table};
use indicatif;
use inquire::{CustomType, MultiSelect, Select};
use reqwest;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

mod bbl;

#[derive(Deserialize)]
struct Config {
    api_token: String,
}

#[derive(Debug, Deserialize, Serialize)]
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
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
enum ViolationClass {
    A,
    B,
    C,
    #[serde(other)]
    Other,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config_str = std::fs::read_to_string("config.toml").expect("Config.toml not found!");
    let config: Config = toml::from_str(&config_str).expect("Invalid config.toml");

    let violation_classes = MultiSelect::new(
        "Search violation classes:",
        vec![
            "A, Non-Hazardous",
            "B, Hazardous",
            "C, Immediately Hazardous",
        ],
    )
    .prompt()?;

    let num_buildings: usize = CustomType::new("Return how many buildings?:").prompt()?;
    let days_back: i64 = CustomType::new("Search how many days back?:").prompt()?;
    let violations = fetch_violations(violation_classes, days_back, &config.api_token)?;
    let selected_address = make_summary(&violations, num_buildings, &config.api_token)?;

    get_details(&selected_address, &violations)?;

    Ok(())
}

fn make_summary(
    violations: &[Violation],
    num_buildings: usize,
    api_token: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let output = sum_apartments(&violations);
    let mut output: Vec<_> = output.iter().collect();

    output.sort_by(|a, b| b.1.2.len().cmp(&a.1.2.len()));
    output.truncate(num_buildings * 3);

    let bbls: Vec<String> = output.iter().map(|(bbl, _)| bbl.to_string()).collect();
    let unit_counts = get_units_per_building(bbls, api_token)?;

    output.sort_by(|a, b| {
        let units_a = *unit_counts.get(a.0).unwrap_or(&1) as f32;
        let units_b = *unit_counts.get(b.0).unwrap_or(&1) as f32;
        let score_a = a.1.2.len() as f32 / units_a;
        let score_b = b.1.2.len() as f32 / units_b;
        score_b.partial_cmp(&score_a).unwrap()
    });

    output.truncate(num_buildings);

    let options: Vec<String> = output
        .iter()
        .map(|(bbl, (_bbl, address, apartments))| {
            let units = *unit_counts.get(*bbl).unwrap_or(&1);
            let pct = (apartments.len() as f32 / units as f32 * 100.0).round() as u32;
            format!("{} ({}, {}%)", address, apartments.len(), pct)
        })
        .collect();

    let selection = Select::new("Select a building for details:", options).prompt()?;
    let selected_address = selection.split(" (").next().unwrap();
    Ok(selected_address.to_string())
}

fn fetch_violations(
    violation_classes: Vec<&str>,
    days_back: i64,
    api_token: &str,
) -> Result<Vec<Violation>, Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()?;

    let local = Local::now();
    let cutoff = local - Duration::days(days_back);
    let date_string = cutoff.format("%Y-%m-%d").to_string();

    let mut all_violations = Vec::new();
    let mut offset = 0;

    let spinner = indicatif::ProgressBar::new_spinner();
    spinner.enable_steady_tick(std::time::Duration::from_millis(100));
    spinner.set_message("Fetching violations...");

    loop {
        let response = client
            .get("https://data.cityofnewyork.us/resource/wvxf-dwi5.json")
            .header("X-App-Token", api_token)
            .query(&[
                (
                    "$where",
                    format!("approveddate > '{}'", date_string).as_str(),
                ),
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

    let mut filtered_violations = all_violations;

    filtered_violations.retain(|v| {
        v.apartment.is_some() && {
            let class_str = match v.class {
                ViolationClass::A => "A, Non-Hazardous",
                ViolationClass::B => "B, Hazardous",
                ViolationClass::C => "C, Immediately Hazardous",
                ViolationClass::Other => "",
            };
            violation_classes.contains(&class_str)
        }
    });

    spinner.finish_and_clear();

    Ok(filtered_violations)
}

fn get_details(address: &str, violations: &[Violation]) -> Result<(), Box<dyn std::error::Error>> {
    let details: Vec<&Violation> = violations
        .iter()
        .filter(|v| format!("{} {}", v.house_number, capitalize(&v.street_name)) == address)
        .collect();

    let mut by_apartment: HashMap<String, Vec<&Violation>> = HashMap::new();
    for v in &details {
        by_apartment
            .entry(v.apartment.clone().unwrap())
            .or_insert_with(Vec::new)
            .push(v);
    }

    let mut apts: Vec<_> = by_apartment.iter().collect();

    apts.sort_by(|a, b| b.1.len().cmp(&a.1.len()));

    let max_violations = apts.first().map(|(_, v)| v.len()).unwrap_or(1);
    let top_third = max_violations * 2 / 3;
    let mid_third = max_violations / 3;

    let mut table = Table::new();
    table.set_header(vec![
        Cell::new("Apartment").add_attribute(Attribute::Bold),
        Cell::new("Violations").add_attribute(Attribute::Bold),
        Cell::new("Classes").add_attribute(Attribute::Bold),
    ]);

    for (apt, viols) in &apts {
        let mut class_counts: HashMap<String, usize> = HashMap::new();
        for v in *viols {
            *class_counts.entry(format!("{:?}", v.class)).or_insert(0) += 1;
        }
        let mut counts: Vec<String> = class_counts
            .iter()
            .map(|(class, count)| format!("{}{}", count, class))
            .collect();
        counts.sort();

        let color = if viols.len() >= top_third {
            Color::Red
        } else if viols.len() >= mid_third {
            Color::AnsiValue(208)
        } else {
            Color::Yellow
        };

        table.add_row(vec![
            Cell::new(format!("{}", apt))
                .fg(color)
                .add_attribute(Attribute::Bold),
            Cell::new(viols.len()).fg(color),
            Cell::new(counts.join(", ")).fg(color),
        ]);
    }

    println!("{table}");
    Ok(())
}

fn sum_apartments(violations: &[Violation]) -> HashMap<String, (String, String, HashSet<String>)> {
    let mut distinct_buildings = HashMap::new();
    for violation in violations {
        let address = format!(
            "{} {}",
            violation.house_number,
            capitalize(&violation.street_name)
        );
        let bbl = bbl::construct_bbl(&violation.boro, &violation.block, &violation.lot);
        distinct_buildings
            .entry(bbl.clone())
            .or_insert_with(|| (bbl.clone(), address, HashSet::new()))
            .2
            .insert(violation.apartment.clone().unwrap());
    }
    distinct_buildings
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
