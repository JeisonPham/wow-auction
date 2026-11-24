//! Archive actual observations on ingestion, independently of dashboard requests.
use super::{depth, Config};
use crate::{
    feed::{BrokerBook, Feed},
    prices::Source,
    scan::Bundle,
    Result,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufWriter, Write},
    process::{Command, Stdio},
};

const SCRIPT: &str = include_str!("history.py");
// Item zero marks a complete market check. Other rows give positive prices and/or known stock.
pub(super) type Sample = (u32, u64, u8, u64, u64, Option<u64>, Vec<[u64; 3]>);

fn run(c: &Config, mode: &str, data: &impl Serialize) -> Result<Vec<u8>> {
    let db = c.dir.join(format!(
        "hourly-{}-{}.sqlite3",
        c.region,
        c.market.replace(' ', "_")
    ));
    let mut child = Command::new(if cfg!(windows) { "python" } else { "python3" })
        .args(["-c", SCRIPT, mode])
        .arg(db)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Cannot start price history: {e}"))?;
    let write = {
        let mut input = BufWriter::new(child.stdin.take().unwrap());
        serde_json::to_writer(&mut input, data)
            .and_then(|_| input.flush().map_err(serde_json::Error::io))
    };
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Price history: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    write.map_err(|e| e.to_string())?;
    Ok(output.stdout)
}
pub(super) fn record(c: &Config, samples: &[Sample]) -> Result<()> {
    if !samples.is_empty() {
        run(c, "record", &samples)?;
    }
    Ok(())
}
pub(super) fn upload(c: &Config, b: &Bundle) -> Result<()> {
    let s = &b.snapshot;
    let mut rows = Vec::new();
    if s.newest_price_at > 0 {
        rows.push((
            0,
            s.newest_price_at,
            Source::Full as u8,
            0,
            0,
            Some(0),
            vec![],
        ));
    }
    for (book, src) in [
        (&s.estimate_prices, Source::Desktop),
        (&s.prices, Source::Full),
    ] {
        for (&id, p) in book {
            rows.push((
                id,
                p.observed_at,
                src as u8,
                p.total_buyout,
                p.units,
                (src == Source::Full).then_some(p.units),
                depth::levels(&p.lots),
            ));
        }
    }
    for check in b.targeted.iter().rev() {
        for (&id, &available) in &check.listed_units {
            let p = check.prices.get(&id);
            rows.push((
                id,
                check.time_for(id),
                Source::Targeted as u8,
                p.map_or(0, |p| p.total_buyout),
                p.map_or(0, |p| p.units),
                Some(available),
                p.map_or_else(Vec::new, |p| depth::levels(&p.lots)),
            ));
        }
    }
    record(c, &rows)
}
pub(super) fn broker(c: &Config, book: &BrokerBook) -> Result<()> {
    record(
        c,
        &book
            .items
            .iter()
            .map(|(&id, p)| {
                (
                    id,
                    p.observed_at,
                    Source::Broker as u8,
                    p.price,
                    1,
                    None,
                    vec![],
                )
            })
            .collect::<Vec<_>>(),
    )
}
pub(super) fn feed(c: &Config, f: &Feed) -> Result<()> {
    record(
        c,
        &f.items
            .iter()
            .map(|(&id, (_, p))| {
                (
                    id,
                    f.observed_at(id),
                    Source::Public as u8,
                    *p,
                    1,
                    None,
                    vec![],
                )
            })
            .collect::<Vec<_>>(),
    )
}
pub(super) fn parse(query: &str) -> Option<Value> {
    let (mut items, mut floor) = (BTreeMap::new(), None);
    let mut seen_items = false;
    for arg in query.split('&') {
        let (key, value) = arg.split_once('=')?;
        match key {
            "items" if !seen_items => {
                seen_items = true;
                for pair in value.split(',') {
                    let (id, n) = pair.split_once(':').unwrap_or((pair, "1"));
                    let (id, n) = (id.parse::<u32>().ok()?, n.parse::<u64>().ok()?);
                    if id == 0
                        || !(1..=crate::scan::MAX).contains(&n)
                        || items.len() >= 128
                        || items.insert(id, n).is_some()
                    {
                        return None;
                    }
                }
            }
            "floor" if floor.is_none() => {
                floor = Some(value.parse::<u8>().ok().filter(|n| *n <= 100)?);
            }
            _ => return None,
        }
    }
    seen_items.then(|| json!({"items":items.into_iter().collect::<Vec<_>>(),"floor":floor}))
}
pub(super) fn query(c: &Config, args: &Value) -> Result<Vec<u8>> {
    run(c, "query", args)
}
