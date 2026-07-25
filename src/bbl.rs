fn boro_name_to_num(boro: &str) -> &str {
    match boro {
        "MANHATTAN" => "1",
        "BRONX" => "2",
        "BROOKLYN" => "3",
        "QUEENS" => "4",
        "STATEN ISLAND" => "5",
        _ => "0",
    }
}

pub fn construct_bbl(boro: &str, block: &str, lot: &str) -> String {
    format!("{}{:0>5}{:0>4}", boro_name_to_num(boro), block, lot)
}
