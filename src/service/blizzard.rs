use super::{env_or, save, Config, State};
use crate::{
    now,
    prices::{Observation, Prices, Source},
    scan::MAX,
    Result,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap, env, fs, path::PathBuf, process::Command, sync::Mutex, thread,
    time::Duration,
};

const HOUR: u64 = 3600;

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
pub(super) struct Ask {
    total: u64,
    units: u64,
    pub at: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub(super) struct Book {
    region: String,
    market: String,
    pub modified: [u64; 2],
    pub items: BTreeMap<u32, Ask>,
}

impl Book {
    fn parse(raw: &[u8], c: &Config, now: u64) -> Result<Self> {
        let book: Self = serde_json::from_slice(raw).map_err(|_| "Invalid Blizzard price file")?;
        if book.region != c.region || book.market != c.market {
            return Err("Blizzard auction market mismatch".into());
        }
        let latest = *book.modified.iter().max().unwrap();
        if book.modified.contains(&0)
            || latest > now.saturating_add(300)
            || book.items.iter().any(|(&id, p)| {
                id == 0
                    || p.at == 0
                    || p.at > latest
                    || !(1..=MAX).contains(&p.total)
                    || !(1..=MAX).contains(&p.units)
            })
        {
            return Err("Invalid Blizzard auction price or observation time".into());
        }
        Ok(book)
    }

    pub fn add_to(&self, prices: &mut Prices) {
        for (&id, p) in &self.items {
            prices.observe(
                id,
                Observation {
                    total: p.total,
                    units: p.units,
                    at: p.at,
                    source: Source::Blizzard,
                    auctions: None,
                },
            );
        }
    }
}

fn filename(c: &Config) -> String {
    // The service validates these market/region components at startup.
    format!("blizzard-{}-{}.json", c.region, c.market.replace(' ', "_"))
}

pub(super) fn restore(c: &Config) -> Result<Book> {
    if !c.blizzard_enabled {
        return Ok(Book::default());
    }
    match fs::read(c.dir.join(filename(c))) {
        Ok(bytes) => Book::parse(&bytes, c, now()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Book::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn accept(c: &Config, state: &mut State, raw: &[u8]) -> Result<()> {
    let mut next = Book::parse(raw, c, now())?;
    if next
        .modified
        .iter()
        .zip(state.blizzard.modified)
        .any(|(new, old)| *new < old)
    {
        return Err("Blizzard snapshot would move backwards".into());
    }
    if next.items.values().any(|p| !next.modified.contains(&p.at)) {
        return Err("Blizzard price does not match either snapshot time".into());
    }
    if next.modified == state.blizzard.modified && next.items.is_empty() {
        return Ok(());
    }
    for (&id, &prior) in &state.blizzard.items {
        if next.items.get(&id).is_none_or(|p| p.at < prior.at) {
            next.items.insert(id, prior);
        }
    }
    save(
        &c.dir,
        &filename(c),
        &serde_json::to_vec(&next).map_err(|e| e.to_string())?,
    )?;
    state.blizzard = next;
    Ok(())
}

pub(super) fn run(c: &Config, state: &Mutex<State>) {
    let helper = env::var_os("WOW_BLIZZARD_HELPER").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("client/blizzard.py"),
        PathBuf::from,
    );
    let python = env_or(
        "WOW_BLIZZARD_PYTHON",
        if cfg!(windows) { "python" } else { "python3" },
    );
    loop {
        let mut delay = HOUR;
        let modified = state.lock().unwrap().blizzard.modified;
        let output = Command::new(&python)
            .arg(&helper)
            .args([&c.region, &c.market])
            .args(modified.map(|t| t.to_string()))
            .env_remove("WOW_UPLOAD_TOKEN")
            .env_remove("WOW_UPLOAD_TOKEN_FILE")
            .output();
        {
            let mut s = state.lock().unwrap();
            let result = match output {
                Ok(out) if out.status.success() => accept(c, &mut s, &out.stdout),
                Ok(out) => {
                    if out.status.code() == Some(75) {
                        let retry = String::from_utf8_lossy(&out.stdout);
                        delay = HOUR.max(retry.trim().parse().unwrap_or(0));
                    }
                    Err(String::from_utf8_lossy(&out.stderr).trim().to_owned())
                }
                Err(e) => Err(format!("Cannot start Blizzard importer: {e}")),
            };
            s.blizzard_checked_at = Some(now());
            s.blizzard_error = result.err();
            s.views.clear();
            if let Some(e) = &s.blizzard_error {
                eprintln!("Blizzard auction update: {e}");
            } else {
                eprintln!(
                    "Blizzard auction update for {} / {}: {} items with prices",
                    c.region,
                    c.market,
                    s.blizzard.items.len()
                );
            }
        }
        thread::sleep(Duration::from_secs(delay));
    }
}
