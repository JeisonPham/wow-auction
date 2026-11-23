use crate::{scan::MAX, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    process::Command,
};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BrokerPrice {
    pub price: u64,
    pub observed_at: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerBook {
    pub region: String,
    pub market: String,
    pub items: BTreeMap<u32, BrokerPrice>,
}

impl BrokerBook {
    pub fn parse(raw: &[u8], region: &str, market: &str, now: u64) -> Result<Self> {
        let data = crate::scan::unique_json(raw)?;
        crate::scan::canonical_ids(&data["items"])?;
        let book: Self = serde_json::from_value(data).map_err(|e| e.to_string())?;
        if book.region != region || book.market != market {
            return Err("Booty Bay Broker market mismatch".into());
        }
        if book.items.is_empty()
            || book.items.len() > 250000
            || book.items.values().any(|p| {
                !(1..=MAX).contains(&p.price)
                    || !(1..=now.saturating_add(300)).contains(&p.observed_at)
            })
        {
            return Err("invalid Booty Bay Broker price, timestamp or item count".into());
        }
        Ok(book)
    }
}
#[derive(Default, Serialize, Deserialize)]
pub struct Feed {
    pub region: String,
    pub market: String,
    pub at: u64,
    pub items: BTreeMap<u32, (String, u64)>,
    // Older caches and uniform books share a single timestamp.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub observed: BTreeMap<u32, u64>,
}
impl Feed {
    pub fn observed_at(&self, id: u32) -> u64 {
        self.observed.get(&id).copied().unwrap_or(self.at)
    }
    pub fn retain_prices_from(&mut self, previous: &Self) {
        if self.at < previous.at {
            for &id in self.items.keys() {
                self.observed.entry(id).or_insert(self.at);
            }
            self.at = previous.at;
        }
        for (&id, item) in &previous.items {
            let at = previous.observed_at(id);
            if !self.items.contains_key(&id) || self.observed_at(id) < at {
                self.items.insert(id, item.clone());
                self.observed.insert(id, at);
            }
        }
        self.observed.retain(|_, at| *at != self.at);
    }
}
pub fn url(region: &str, market: &str) -> Result<String> {
    let region = region
        .strip_prefix("Forever-")
        .ok_or("region must begin with Forever-")?;
    let market = market.replace(' ', "-");
    if !region.bytes().all(|b| b.is_ascii_alphanumeric())
        || region.is_empty()
        || !market.contains('-')
        || !market
            .split('-')
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric()))
    {
        return Err("invalid market or region".into());
    }
    Ok(format!(
        "https://public-data.tradeskillmaster.com/forever/{}/realm/{}/items.csv",
        region.to_lowercase(),
        market.to_lowercase()
    ))
}
pub fn fetch(region: &str, market: &str) -> Result<Feed> {
    let result = Command::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "90",
            "--max-filesize",
            "16777216",
            &url(region, market)?,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).trim().to_owned());
    }
    parse(&result.stdout, region, market, crate::now())
}
pub fn parse(data: &[u8], region: &str, market: &str, now: u64) -> Result<Feed> {
    if data.len() > 16 << 20 {
        return Err("public feed exceeds 16 MiB".into());
    }
    let mut csv = csv::Reader::from_reader(data);
    let h = csv.headers().map_err(|e| e.to_string())?;
    let mut cols = vec![];
    for key in ["itemId", "name", "recent", "updatedAt"] {
        let matches: Vec<_> = h.iter().enumerate().filter(|(_, v)| *v == key).collect();
        if matches.len() != 1 {
            return Err(format!("missing or repeated {key}"));
        }
        cols.push(matches[0].0)
    }
    let mut feed = Feed {
        region: region.into(),
        market: market.into(),
        ..Default::default()
    };
    let mut seen = BTreeSet::new();
    let mut last_stamp = (String::new(), 0);
    for record in csv.records() {
        let r = record.map_err(|e| e.to_string())?;
        let id = r[cols[0]].parse::<u32>().map_err(|_| "invalid item ID")?;
        if id == 0 || !seen.insert(id) || seen.len() > 250000 {
            return Err("invalid public feed IDs or size".into());
        }
        let ts = &r[cols[3]];
        if ts != last_stamp.0 || last_stamp.1 == 0 {
            let at = chrono::DateTime::parse_from_rfc3339(ts)
                .map_err(|e| e.to_string())?
                .timestamp()
                .try_into()
                .map_err(|_| "invalid time")?;
            if at == 0 || at > now + 300 {
                return Err("invalid public feed time".into());
            }
            last_stamp = (ts.into(), at);
        }
        feed.at = feed.at.max(last_stamp.1);
        if r[cols[2]].is_empty() {
            continue;
        }
        let p = r[cols[2]]
            .parse::<u64>()
            .map_err(|_| "invalid recent price")?;
        if p > MAX {
            return Err("price out of range".into());
        }
        if p > 0 {
            feed.items.insert(id, (r[cols[1]].to_owned(), p));
            feed.observed.insert(id, last_stamp.1);
        }
    }
    if feed.items.is_empty() {
        return Err("empty public estimate book".into());
    }
    feed.observed.retain(|_, at| *at != feed.at);
    Ok(feed)
}
