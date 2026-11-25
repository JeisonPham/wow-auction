//! Publish one immutable dashboard version. Navigation serves the previous completed version
//! while the next one is prepared, including during a burst of market updates.
use super::*;
use flate2::{write::GzEncoder, Compression};
use std::sync::RwLock;

pub(super) struct Snapshot {
    tag: String,
    plain: Arc<[u8]>,
    gzip: Arc<[u8]>,
}
pub(super) type Published = RwLock<Option<Snapshot>>;

struct Captured {
    version: (u64, u64),
    report: Value,
    archive: Value,
}

fn capture(c: &Config, s: &mut State, previous: Option<(u64, u64)>) -> Result<Option<Captured>> {
    let at = now();
    s.refresh(c, at);
    let version = (s.generation, at / 3600);
    if Some(version) == previous {
        return Ok(None);
    }
    let mut report: Value =
        serde_json::from_slice(&s.views["/api/report"]).map_err(|e| e.to_string())?;
    report["prepared_at"] = json!(at);
    let checks = scan::MarketChecks::new(s.bundle.as_ref(), at, u64::MAX);
    let items = report["items"].as_array_mut().unwrap();
    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        let id = item["id"].as_u64().unwrap();
        ids.push(id);
        if let Some(book) =
            depth::ListingSnapshot::for_item(id as u32, &checks, &s.blizzard, at, u64::MAX)
        {
            let mut value = json!(book);
            value["stale"] = json!(!fresh(book.observed_at, at, c.age));
            value["count"] = json!(book.count());
            item["listing_snapshot"] = value;
        }
    }
    // Ingestion and history writes use this same state lock. Capture one consistent cut;
    // expensive pricing, chart calculation and compression happen after releasing it.
    let archive = history::archive(c, &ids)?;
    Ok(Some(Captured {
        version,
        report,
        archive,
    }))
}

pub(super) fn run(c: &Config, state: &Mutex<State>, published: &Published) {
    let epoch = state.lock().unwrap().epoch;
    let mut previous = None;
    loop {
        let captured = capture(c, &mut state.lock().unwrap(), previous);
        match captured {
            Ok(Some(Captured {
                version,
                mut report,
                archive,
            })) => {
                auction_calculations::prepared::dashboard(&mut report, archive);
                let plain = serde_json::to_vec(&report).expect("dashboard JSON");
                drop(report);
                let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
                encoder.write_all(&plain).expect("memory buffer");
                let gzip = encoder.finish().expect("memory buffer");
                *published.write().unwrap() = Some(Snapshot {
                    tag: format!("\"{epoch:x}-{}-{}\"", version.0, version.1),
                    plain: plain.into(),
                    gzip: gzip.into(),
                });
                previous = Some(version);
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("Preparing dashboard: {e}");
                thread::sleep(Duration::from_secs(4));
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
}

pub(super) fn serve(r: Request, published: &Published) {
    let accept = header(&r, "Accept-Encoding");
    let gzip = accept.iter().flat_map(|v| v.split(',')).any(|v| {
        let mut parts = v.trim().split(';');
        parts
            .next()
            .is_some_and(|s| s.trim().eq_ignore_ascii_case("gzip"))
            && parts.all(|p| {
                p.trim()
                    .strip_prefix("q=")
                    .is_none_or(|n| n.parse::<f32>().is_ok_and(|v| v > 0.))
            })
    });
    let snapshot = published.read().unwrap();
    let Some(view) = snapshot.as_ref() else {
        drop(snapshot);
        return reply(r, 202, json!({"status":"preparing"}));
    };
    let tag = format!("W/{}", view.tag);
    let matched = header(&r, "If-None-Match")
        .iter()
        .flat_map(|v| v.split(','))
        .any(|v| v.trim() == tag || v.trim() == "*");
    let data = if matched {
        Arc::from([])
    } else if gzip {
        view.gzip.clone()
    } else {
        view.plain.clone()
    };
    drop(snapshot);
    let mut response = Response::new(
        tiny_http::StatusCode(if matched { 304 } else { 200 }),
        vec![
            Header::from_bytes("Content-Type", "application/json").unwrap(),
            Header::from_bytes("ETag", tag).unwrap(),
            Header::from_bytes("Cache-Control", "no-cache").unwrap(),
            Header::from_bytes("Vary", "Accept-Encoding").unwrap(),
        ],
        std::io::Cursor::new(data.clone()),
        Some(data.len()),
        None,
    );
    if gzip && !matched {
        response.add_header(Header::from_bytes("Content-Encoding", "gzip").unwrap());
    }
    let _ = r.respond(response);
}
