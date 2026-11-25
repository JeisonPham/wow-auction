use super::{depth, env_or, history, save, Config, State};
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

type ListingView<'a> = (u64, &'a [[u64; 3]], Option<u64>);
type ListingBook = BTreeMap<u32, Vec<[u64; 3]>>;

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Book {
    region: String,
    market: String,
    pub modified: [u64; 2],
    pub items: BTreeMap<u32, Ask>,
    #[serde(default)]
    depth: [Option<ListingBook>; 2],
    #[serde(default)]
    commodity_counts: Option<BTreeMap<u32, u64>>,
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
        for snapshot in book.depth.iter().flatten() {
            for (&id, lots) in snapshot {
                let units = lots.iter().try_fold(0u64, |n, &[size, total, count]| {
                    if size == 0 || count == 0 || !(1..=MAX).contains(&total) {
                        return None;
                    }
                    n.checked_add(size.checked_mul(count)?)
                });
                if id == 0 || !units.is_some_and(|n| n <= MAX) {
                    return Err("Invalid Blizzard listing depth".into());
                }
            }
        }
        if let Some(counts) = &book.commodity_counts {
            for (id, count) in counts {
                let units = book.depth[1]
                    .as_ref()
                    .and_then(|b| b.get(id))
                    .map_or(0, |lots| lots.iter().map(|r| r[0] * r[2]).sum());
                if *count == 0 || *count > units {
                    return Err("Invalid commodity listing count".into());
                }
            }
        }
        Ok(book)
    }

    fn count(&self, index: usize, id: u32, lots: &[[u64; 3]]) -> Option<u64> {
        if lots.is_empty() {
            return Some(0);
        }
        if index == 0 {
            return Some(lots.iter().map(|r| r[2]).sum());
        }
        self.commodity_counts.as_ref()?.get(&id).copied()
    }
    pub(super) fn listings(&self, id: u32) -> Option<ListingView<'_>> {
        // Individually purchasable commodity units can belong to the same auction.
        self.depth
            .iter()
            .enumerate()
            .filter_map(|(i, book)| {
                let rows = book.as_ref()?.get(&id)?.as_slice();
                Some((self.modified[i], rows, self.count(i, id, rows)))
            })
            .max_by_key(|(at, lots, _)| (!lots.is_empty(), *at))
            .or_else(|| {
                self.depth
                    .iter()
                    .all(Option::is_some)
                    .then(|| (self.modified[0].min(self.modified[1]), &[][..], Some(0)))
            })
    }
    fn conditional_times(&self) -> [u64; 2] {
        std::array::from_fn(|i| {
            if self.depth[i].is_some() {
                self.modified[i]
            } else {
                0
            }
        })
    }
    pub(super) fn record_history(&self, c: &Config) -> Result<()> {
        let src = Source::Blizzard as u8;
        let mut rows: Vec<_> = self
            .items
            .iter()
            .map(|(&id, p)| (id, p.at, src, p.total, p.units, None, vec![], None))
            .collect();
        for (index, (book, at)) in self.depth.iter().zip(self.modified).enumerate() {
            for (&id, lots) in book.iter().flat_map(|b| b.iter()) {
                if lots.is_empty() {
                    if self
                        .depth
                        .iter()
                        .flatten()
                        .any(|book| book.get(&id).is_some_and(|rows| !rows.is_empty()))
                    {
                        continue;
                    }
                    rows.push((id, at, src, 0, 0, Some(0), vec![], Some(0)));
                    continue;
                }
                let levels = depth::levels(lots);
                let [_, total, size] = levels[0];
                let available = levels.last().unwrap()[0];
                rows.push((
                    id,
                    at,
                    src,
                    total,
                    size,
                    Some(available),
                    levels,
                    self.count(index, id, lots),
                ));
            }
        }
        if self.depth.iter().all(Option::is_some) {
            rows.push((
                0,
                self.modified[0].min(self.modified[1]),
                src,
                0,
                0,
                Some(0),
                vec![],
                Some(0),
            ));
        }
        history::record(c, &rows)
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
    if next.modified == state.blizzard.modified
        && next.items.is_empty()
        && next.depth.iter().all(Option::is_none)
    {
        return Ok(());
    }
    for (&id, &prior) in &state.blizzard.items {
        if next.items.get(&id).is_none_or(|p| p.at < prior.at) {
            next.items.insert(id, prior);
        }
    }
    for (i, depth) in next.depth.iter_mut().enumerate() {
        if depth.is_none() && next.modified[i] == state.blizzard.modified[i] {
            depth.clone_from(&state.blizzard.depth[i]);
            if i == 1 {
                next.commodity_counts
                    .clone_from(&state.blizzard.commodity_counts);
            }
        } else if let (Some(book), Some(prior)) = (depth, &state.blizzard.depth[i]) {
            // Keep which endpoint last checked a sold-out item. Each endpoint has its own clock.
            for id in prior.keys() {
                book.entry(*id).or_default();
            }
        }
    }
    save(
        &c.dir,
        &filename(c),
        &serde_json::to_vec(&next).map_err(|e| e.to_string())?,
    )?;
    next.record_history(c)?;
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
        let modified = state.lock().unwrap().blizzard.conditional_times();
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
