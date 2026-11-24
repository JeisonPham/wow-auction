mod blizzard;
mod broker_poll;
mod depth;
mod history;
use crate::{
    feed::{self, BrokerBook, Feed},
    fresh, now, planner,
    prices::Prices,
    scan::{self, Bundle},
    Result,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tiny_http::{Header, Request, Response, Server};
struct Config {
    region: String,
    market: String,
    age: u64,
    public: bool,
    blizzard_enabled: bool,
    broker_urls: Vec<String>,
    broker_delay: u64,
    dir: PathBuf,
    token: String,
}
fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.into())
}
fn config() -> Result<Config> {
    let token = match env::var("WOW_UPLOAD_TOKEN_FILE") {
        Ok(p) => fs::read_to_string(p)
            .map_err(|e| e.to_string())?
            .trim_end_matches(['\r', '\n'])
            .into(),
        Err(_) => env_or("WOW_UPLOAD_TOKEN", ""),
    };
    if !(32..=512).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("set WOW_UPLOAD_TOKEN to 32–512 printable non-space ASCII characters".into());
    }
    let id_set = !env_or("WOW_BLIZZARD_CLIENT_ID", "").trim().is_empty();
    let secret_set = !env_or("WOW_BLIZZARD_CLIENT_SECRET", "").trim().is_empty();
    let c = Config {
        blizzard_enabled: id_set || secret_set,
        token,
        region: env_or("WOW_REGION", "Forever-US"),
        market: env_or("WOW_MARKET", "Normal-Alliance"),
        age: env_or("WOW_MAX_AGE_SECONDS", "21600")
            .parse()
            .map_err(|_| "invalid max age")?,
        public: match env_or("WOW_TSM_PUBLIC", "1").as_str() {
            "1" | "true" => true,
            "0" | "false" => false,
            _ => return Err("invalid public feed setting".into()),
        },
        dir: env_or("WOW_DATA_DIR", ".").into(),
        broker_urls: broker_poll::targets(&env_or("WOW_BROKER_URLS", ""))?,
        broker_delay: env_or("WOW_BROKER_DELAY_SECONDS", "5")
            .parse()
            .map_err(|_| "invalid Broker request delay")?,
    };
    if !c.broker_urls.is_empty() && c.broker_delay == 0 {
        return Err("Broker request delay must be positive".into());
    }
    feed::url(&c.region, &c.market)?;
    if !(1..=31536000).contains(&c.age) {
        return Err("max age out of range".into());
    }
    Ok(c)
}
fn save(dir: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let op = || -> std::io::Result<()> {
        let mut f = tempfile::NamedTempFile::new_in(dir)?;
        f.write_all(bytes)?;
        f.as_file().sync_all()?;
        f.persist(dir.join(name))?;
        #[cfg(unix)]
        File::open(dir)?.sync_all()?;
        Ok(())
    };
    op().map_err(|e| e.to_string())
}
struct State {
    bundle: Option<Bundle>,
    uploaded_at: Option<u64>,
    feed: Feed,
    prior_upload_prices: Prices,
    broker: BrokerBook,
    blizzard: blizzard::Book,
    blizzard_checked_at: Option<u64>,
    blizzard_error: Option<String>,
    broker_checked_at: Option<u64>,
    broker_error: Option<String>,
    checked: u64,
    error: Option<String>,
    depths: HashMap<u32, depth::Depth>,
    views: HashMap<&'static str, Arc<[u8]>>,
    next: u64,
    generation: u64,
    epoch: u128,
}
impl State {
    fn refresh(&mut self, c: &Config, t: u64) {
        if !self.views.is_empty() && t < self.next {
            return;
        }
        let mut prices =
            self.prior_upload_prices
                .resolve(self.bundle.as_ref(), &self.feed, &self.broker);
        self.blizzard.add_to(&mut prices);
        let checks = scan::MarketChecks::new(self.bundle.as_ref(), t, c.age);
        self.depths.clear();
        // Item IDs are positive; the zero entry represents market-wide empty coverage.
        if let Some(empty) = depth::Depth::for_item(0, &checks, &self.blizzard, t, c.age) {
            self.depths.insert(0, empty);
        }
        let mut r = planner::market_report_with_prices(
            &c.region,
            &c.market,
            self.bundle.as_ref(),
            &self.feed,
            &self.broker,
            &prices,
            c.age,
            t,
            |id| {
                let d = depth::Depth::for_item(id, &checks, &self.blizzard, t, c.age)?;
                let lowest = d.lowest();
                self.depths.insert(id, d);
                lowest
            },
        );
        for item in r["items"].as_array_mut().expect("planner item list") {
            let id = item["id"].as_u64().expect("planner item ID") as u32;
            if let Some(d) = self.depths.get(&id) {
                item["purchase_depth"] = json!(d);
            }
        }
        r["depth_max_age"] = c.age.into();
        if let Some(port) = env::var("WOW_TSM_DESKTOP_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .filter(|p| *p > 0)
        {
            r["desktop_port"] = json!(port);
        }
        r["booty_bay_broker"]["configured_items"] = json!(c.broker_urls.len());
        r["booty_bay_broker"]["last_pull_at"] = json!(self.broker_checked_at);
        r["booty_bay_broker"]["pull_error"] = json!(self.broker_error);
        r["blizzard"] = json!({"enabled":c.blizzard_enabled,"total":self.blizzard.items.len(),
            "latest_at":self.blizzard.modified.iter().copied().max().filter(|t| *t > 0),
            "last_pull_at":self.blizzard_checked_at,"error":self.blizzard_error});
        r["uploaded_at"] = json!(self.uploaded_at);
        r["tsm"]["error"] = json!(self.error);
        let status = json!({"responsive":true,"region":c.region,"market":c.market,"upload_revision":r["upload_revision"],"generated_at":t,"tsm":r["tsm"],"booty_bay_broker":r["booty_bay_broker"],"blizzard":r["blizzard"],"uploaded_at":self.uploaded_at,"public_enabled":c.public,"public_checked_at":self.checked});
        let queue = json!({"region":c.region,"market":c.market,"items":r["scan_queue"],"estimate_at":r["queue_estimate_at"],"expires_at":r["queue_estimate_at"].as_u64().filter(|n|*n>0).map_or(0,|n|n+c.age),"upload_revision":r["upload_revision"]});
        let candidates =
            json!({"items":r["scan_queue"],"tsm":r["tsm"],"upload_revision":r["upload_revision"]});
        let mut times = vec![self.feed.at];
        times.extend(self.feed.observed.values().copied());
        times.extend(self.prior_upload_prices.0.values().map(|p| p.at));
        times.extend(self.blizzard.modified);
        times.extend(self.blizzard.items.values().map(|p| p.at));
        times.extend(self.broker.items.values().map(|p| p.observed_at));
        if let Some(b) = &self.bundle {
            times.extend(b.times());
            times.extend(b.targeted.iter().flat_map(scan::Capture::times))
        }
        self.next = times
            .into_iter()
            .filter(|n| fresh(*n, t, c.age))
            .map(|n| n + c.age + 1)
            .min()
            .unwrap_or(u64::MAX);
        for (path, data) in [
            ("/api/report", r),
            ("/api/status", status),
            ("/api/candidates", candidates),
            ("/api/scan-queue", queue),
        ] {
            self.views
                .insert(path, serde_json::to_vec(&data).unwrap().into());
        }
        self.generation += 1
    }
}
fn header(r: &Request, key: &str) -> Vec<String> {
    r.headers()
        .iter()
        .filter(|h| h.field.as_str().as_str().eq_ignore_ascii_case(key))
        .map(|h| h.value.to_string())
        .collect()
}
fn respond(r: Request, code: u16, mime: &str, data: Arc<[u8]>, etag: Option<String>) {
    let size = data.len();
    let mut res = Response::new(
        tiny_http::StatusCode(code),
        vec![
            Header::from_bytes("Content-Type", mime).unwrap(),
            Header::from_bytes("Cache-Control", "no-cache").unwrap(),
        ],
        std::io::Cursor::new(data),
        Some(size),
        None,
    );
    if let Some(tag) = etag {
        res.add_header(Header::from_bytes("ETag", tag).unwrap())
    }
    let _ = r.respond(res);
}
fn reply(r: Request, code: u16, data: Value) {
    respond(
        r,
        code,
        "application/json",
        serde_json::to_vec(&data).unwrap().into(),
        None,
    )
}
fn fail(r: Request, code: u16, msg: &str) {
    reply(r, code, json!({"error":msg}))
}
fn accept_upload(
    c: &Config,
    state: &Mutex<State>,
    buf: &[u8],
    t: u64,
) -> std::result::Result<Value, (u16, String)> {
    let mut b = scan::decode(buf, &c.region, &c.market, t).map_err(|e| (422, e))?;
    let revision = b.revision;
    let mut s = state.lock().unwrap();
    // A client can submit its AH observations without observing a new desktop book.
    if b.snapshot.estimate_at == 0 && b.snapshot.estimate_prices.is_empty() {
        if let Some(old) = &s.bundle {
            b.snapshot.estimate_at = old.snapshot.estimate_at;
            b.snapshot
                .estimate_prices
                .clone_from(&old.snapshot.estimate_prices);
        }
    }
    let normalized = scan::encode(&b).map_err(|e| (503, e))?;
    if let Some(old) = &s.bundle {
        if revision == old.revision && scan::encode(old).map_err(|e| (503, e))? == normalized {
            return Ok(json!({"revision":revision,"status":"unchanged"}));
        }
        if revision <= old.revision
            || old
                .times()
                .into_iter()
                .zip(b.times())
                .any(|(o, n)| n < o && (n > 0 || fresh(o, t, c.age)))
        {
            return Err((
                409,
                "revision or observation would move backwards or conflict".into(),
            ));
        }
        // Preserve prices from the already accepted upload before replacing it.
        // A failure between writes leaves both files describing accepted observations.
        let mut history = s.prior_upload_prices.clone();
        history.include_upload(old);
        if history.0 != s.prior_upload_prices.0 {
            let data = serde_json::to_vec(&(&c.region, &c.market, &history))
                .map_err(|e| (503, e.to_string()))?;
            save(&c.dir, "scan-price-history.json", &data).map_err(|e| (503, e))?;
            s.prior_upload_prices = history;
        }
    }
    save(&c.dir, "scan-upload.json.gz", &normalized).map_err(|e| (503, e))?;
    history::upload(c, &b).map_err(|e| (503, e))?;
    s.bundle = Some(b);
    s.uploaded_at = Some(t);
    s.views.clear();
    Ok(json!({"revision":revision,"status":"accepted"}))
}
fn accept_broker(
    c: &Config,
    state: &Mutex<State>,
    body: &[u8],
    t: u64,
) -> std::result::Result<Value, (u16, String)> {
    let incoming = BrokerBook::parse(body, &c.region, &c.market, t).map_err(|e| (422, e))?;
    let mut state = state.lock().unwrap();
    let mut book = state.broker.clone();
    let mut updated = 0;
    for (&id, &price) in &incoming.items {
        if let Some(old) = book.items.get(&id) {
            if old.observed_at > price.observed_at || *old == price {
                continue;
            }
            if old.observed_at == price.observed_at {
                return Err((
                    409,
                    format!("conflicting Booty Bay Broker price for item {id}"),
                ));
            }
        }
        book.items.insert(id, price);
        updated += 1;
    }
    if book.items.len() > 250000 {
        return Err((422, "too many Booty Bay Broker items".into()));
    }
    if updated > 0 {
        book.region.clone_from(&incoming.region);
        book.market.clone_from(&incoming.market);
        save(
            &c.dir,
            "bootybay-prices.json",
            &serde_json::to_vec(&book).map_err(|e| (503, e.to_string()))?,
        )
        .map_err(|e| (503, e))?;
        history::broker(c, &incoming).map_err(|e| (503, e))?;
        state.broker = book;
        state.views.clear();
    }
    Ok(json!({"updated":updated,"total":state.broker.items.len()}))
}
fn handle(mut r: Request, c: &Config, state: &Mutex<State>) {
    let path = r.url().split('?').next().unwrap_or("").to_owned();
    let method = r.method().as_str().to_owned();
    let broker = path == "/api/bootybay/prices";
    if broker || matches!(path.as_str(), "/api/scans" | "/api/scan-queue") {
        let auth = header(&r, "Authorization");
        if auth.len() != 1
            || !bool::from(
                auth[0]
                    .as_bytes()
                    .ct_eq(format!("Bearer {}", c.token).as_bytes()),
            )
        {
            return fail(r, 401, "invalid bearer token");
        }
    }
    if (broker || path == "/api/scans") && method == "POST" {
        let mime = if broker {
            "application/json"
        } else {
            "application/gzip"
        };
        let limit = if broker { 16 << 20 } else { scan::COMPRESSED };
        if header(&r, "Content-Type") != [mime] {
            return fail(r, 415, &format!("expected {mime}"));
        }
        if r.body_length().unwrap_or(0) > limit {
            return fail(r, 413, "upload limit exceeded");
        }
        let mut buf = vec![];
        if r.as_reader()
            .take(limit as u64 + 1)
            .read_to_end(&mut buf)
            .is_err()
        {
            return fail(r, 422, "unreadable upload");
        }
        if buf.len() > limit {
            return fail(r, 413, "upload limit exceeded");
        }
        let response = if broker {
            accept_broker(c, state, &buf, now())
        } else {
            accept_upload(c, state, &buf, now())
        };
        return match response {
            Ok(value) => reply(r, 202, value),
            Err((code, e)) => fail(r, code, &e),
        };
    }
    if method != "GET" && method != "HEAD" {
        return fail(r, 405, "unsupported method");
    }
    if path == "/auction.wasm" {
        static MODULE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/auction.wasm"));
        return respond(r, 200, "application/wasm", Arc::from(MODULE), None);
    }
    let asset = match path.as_str() {
        "/calculations.js" => Some(("text/javascript", include_str!("../web/calculations.js"))),
        "/" | "/route" => Some((
            "text/html; charset=utf-8",
            include_str!("../web/index.html"),
        )),
        "/app.css" => Some(("text/css", include_str!("../web/app.css"))),
        "/app.js" => Some(("text/javascript", include_str!("../web/app.js"))),
        "/route.js" => Some(("text/javascript", include_str!("../web/route.js"))),
        "/craft-order.js" => Some(("text/javascript", include_str!("../web/craft-order.js"))),
        "/history.js" => Some(("text/javascript", include_str!("../web/history.js"))),
        "/shopping.js" => Some(("text/javascript", include_str!("../web/shopping.js"))),
        "/price-simulation.js" => Some((
            "text/javascript",
            include_str!("../web/price-simulation.js"),
        )),
        "/healthz" => Some(("text/plain", "ok\n")),
        _ => None,
    };
    if let Some((mime, text)) = asset {
        return respond(r, 200, mime, text.as_bytes().into(), None);
    }
    if path == "/api/price-history" {
        let Some(args) = r.url().split_once('?').and_then(|(_, q)| history::parse(q)) else {
            return fail(
                r,
                400,
                "Expected items=ID:quantity,ID:quantity and optional floor from 0 to 100",
            );
        };
        return match history::query(c, &args) {
            Ok(data) => respond(r, 200, "application/json", data.into(), None),
            Err(e) => {
                eprintln!("{e}");
                fail(r, 503, "Hourly price history unavailable")
            }
        };
    }
    let mut s = state.lock().unwrap();
    if matches!(
        path.as_str(),
        "/api/reagent-listings" | "/api/simulation-listings"
    ) {
        let simulation = path == "/api/simulation-listings";
        let ids = r
            .url()
            .split_once('?')
            .and_then(|(_, q)| q.strip_prefix("items="))
            .and_then(|v| {
                v.split(',')
                    .take(129)
                    .map(|id| id.parse::<u32>().ok())
                    .collect::<Option<Vec<_>>>()
            })
            .filter(|v| v.len() <= 128 && !v.contains(&0));
        let Some(ids) = ids else {
            drop(s);
            return fail(
                r,
                400,
                "Expected items=ID,ID with up to 128 positive item IDs",
            );
        };
        let t = now();
        let horizon = if simulation { u64::MAX } else { c.age };
        let checks = scan::MarketChecks::new(s.bundle.as_ref(), t, horizon);
        let mut items = serde_json::Map::new();
        for id in ids {
            items.entry(id.to_string()).or_insert_with(|| {
                let Some(snapshot) =
                    depth::ListingSnapshot::for_item(id, &checks, &s.blizzard, t, horizon)
                else {
                    return Value::Null;
                };
                let mut entry = json!(snapshot);
                if simulation {
                    entry["stale"] = json!(!crate::fresh(snapshot.observed_at, t, c.age));
                }
                entry
            });
        }
        drop(s);
        return reply(r, 200, json!({ "items": items }));
    }
    if path == "/api/scan-queue" && s.bundle.is_none() {
        return fail(r, 503, "awaiting first upload");
    }
    s.refresh(c, now());
    if path == "/api/purchase-quote" {
        let Some(q) = r
            .url()
            .split_once('?')
            .and_then(|(_, args)| depth::Request::parse(args))
        else {
            drop(s);
            return fail(
                r,
                400,
                "Expected positive item and quantity, and optional floor from 0 to 100",
            );
        };
        let quote = q.result(s.depths.get(&q.item).or_else(|| s.depths.get(&0)));
        drop(s);
        return reply(r, 200, quote);
    }
    let Some(data) = s.views.get(path.as_str()).cloned() else {
        return fail(r, 404, "unknown route");
    };
    let tag = format!("\"{:x}-{}\"", s.epoch, s.generation);
    drop(s);
    if header(&r, "If-None-Match")
        .iter()
        .any(|v| v.split(',').any(|t| t.trim() == tag || t.trim() == "*"))
    {
        respond(r, 304, "application/json", Arc::from([]), Some(tag))
    } else {
        respond(r, 200, "application/json", data, Some(tag))
    }
}
fn restore(c: &Config) -> Result<State> {
    let bundle = match fs::read(c.dir.join("scan-upload.json.gz")) {
        Ok(buf) => Some(scan::decode(&buf, &c.region, &c.market, now())?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let prior_upload_prices = match fs::read(c.dir.join("scan-price-history.json")) {
        Ok(raw) => {
            let (region, market, prices): (String, String, Prices) =
                serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
            if region != c.region || market != c.market || !prices.valid_upload_history(now()) {
                return Err("invalid saved scan price history or market".into());
            }
            prices
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Prices::default(),
        Err(e) => return Err(e.to_string()),
    };
    let broker = match fs::read(c.dir.join("bootybay-prices.json")) {
        Ok(raw) => BrokerBook::parse(&raw, &c.region, &c.market, now())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BrokerBook::default(),
        Err(e) => return Err(e.to_string()),
    };
    let feed = if c.public {
        fs::read(c.dir.join("tsm-public.json"))
            .ok()
            .and_then(|v| serde_json::from_slice::<Feed>(&v).ok())
            .filter(|f| {
                f.region == c.region
                    && f.market == c.market
                    && f.at > 0
                    && f.at <= now() + 300
                    && !f.items.is_empty()
                    && f.observed
                        .iter()
                        .all(|(id, at)| f.items.contains_key(id) && (1..=f.at).contains(at))
                    && f.items
                        .iter()
                        .all(|(id, (_, p))| *id > 0 && (1..=scan::MAX).contains(p))
            })
            .unwrap_or_default()
    } else {
        Feed::default()
    };
    let uploaded_at = bundle.as_ref().and_then(|_| {
        fs::metadata(c.dir.join("scan-upload.json.gz"))
            .ok()?
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs())
    });
    let blizzard = blizzard::restore(c)?;
    if let Some(b) = &bundle {
        history::upload(c, b)?;
    }
    history::broker(c, &broker)?;
    history::feed(c, &feed)?;
    blizzard.record_history(c)?;
    Ok(State {
        bundle,
        prior_upload_prices,
        blizzard,
        blizzard_checked_at: None,
        blizzard_error: None,
        uploaded_at,
        feed,
        broker,
        broker_checked_at: None,
        broker_error: None,
        checked: 0,
        error: None,
        views: HashMap::new(),
        depths: HashMap::new(),
        next: 0,
        generation: 0,
        epoch: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    })
}
pub fn run() -> Result<()> {
    let c = Arc::new(config()?);
    fs::create_dir_all(&c.dir).map_err(|e| e.to_string())?;
    let lock = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(c.dir.join("dashboard.lock"))
        .map_err(|e| e.to_string())?;
    fs4::FileExt::try_lock_exclusive(&lock).map_err(|e| format!("data directory lock: {e}"))?;
    let state = Arc::new(Mutex::new(restore(&c)?));
    let server =
        Arc::new(Server::http(env_or("WOW_BIND", "0.0.0.0:8765")).map_err(|e| e.to_string())?);
    eprintln!("WoW Auction Monitor listening on {}", server.server_addr());
    if c.blizzard_enabled {
        let c = c.clone();
        let state = state.clone();
        thread::spawn(move || blizzard::run(&c, &state));
    }
    if !c.broker_urls.is_empty() {
        let c = c.clone();
        let state = state.clone();
        thread::spawn(move || broker_poll::run(&c, &state));
    }
    if c.public {
        let c = c.clone();
        let state = state.clone();
        thread::spawn(move || loop {
            let result = feed::fetch(&c.region, &c.market);
            let mut s = state.lock().unwrap();
            s.checked = now();
            let result = result.and_then(|mut f| {
                f.retain_prices_from(&s.feed);
                save(
                    &c.dir,
                    "tsm-public.json",
                    &serde_json::to_vec(&f).map_err(|e| e.to_string())?,
                )?;
                history::feed(&c, &f)?;
                s.feed = f;
                Ok(())
            });
            s.error = result.err();
            let delay = if let Some(e) = &s.error {
                eprintln!("Public feed: {e}");
                120
            } else {
                1800
            };
            s.views.clear();
            drop(s);
            thread::sleep(Duration::from_secs(delay))
        });
    }
    thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                for req in server.incoming_requests() {
                    handle(req, &c, &state)
                }
            });
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config_at(dir: &Path) -> Config {
        Config {
            region: "Forever-US".into(),
            market: "Normal-Alliance".into(),
            age: 21600,
            public: true,
            blizzard_enabled: false,
            broker_urls: vec![],
            broker_delay: 5,
            dir: dir.to_owned(),
            token: "x".repeat(32),
        }
    }
    fn upload(revision: u64, t: u64, p: u64) -> Vec<u8> {
        let b:Bundle=serde_json::from_value(json!({"version":1,"region":"Forever-US","market":"Normal-Alliance","revision":revision,"snapshot":{"estimate_at":t,"estimate_prices":{"1":{"observed_at":t,"total_buyout":p,"units":1,"auctions":1}}}})).unwrap();
        scan::encode(&b).unwrap()
    }
    #[test]
    fn persistence_conflict_and_failure() {
        let dir = tempfile::tempdir().unwrap();
        let c = config_at(dir.path());
        let t = now();
        let data = upload(1, t, 100);
        let s = Mutex::new(restore(&c).unwrap());
        assert_eq!(
            accept_upload(&c, &s, &data, t).unwrap()["status"],
            "accepted"
        );
        drop(s);
        let s = Mutex::new(restore(&c).unwrap());
        assert_eq!(
            accept_upload(&c, &s, &data, t).unwrap()["status"],
            "unchanged"
        );
        assert_eq!(
            accept_upload(&c, &s, &upload(1, t, 200), t).unwrap_err().0,
            409
        );
        assert_eq!(
            accept_upload(&c, &s, &upload(2, t - 1, 200), t)
                .unwrap_err()
                .0,
            409
        );
        let broken = config_at(&dir.path().join("missing"));
        assert_eq!(
            accept_upload(&broken, &s, &upload(2, t, 101), t)
                .unwrap_err()
                .0,
            503
        );
        assert_eq!(s.lock().unwrap().bundle.as_ref().unwrap().revision, 1);
        let mut other = config_at(dir.path());
        other.market = "PvP-Horde".into();
        assert!(restore(&other).is_err())
    }
    #[test]
    fn auction_scan_can_follow_a_desktop_upload() {
        let dir = tempfile::tempdir().unwrap();
        let c = config_at(dir.path());
        let state = Mutex::new(restore(&c).unwrap());
        let t = now();
        accept_upload(&c, &state, &upload(1, t - 10, 100), t).unwrap();
        let data: Bundle =
            serde_json::from_value(json!({"version":1,"region":c.region,"market":c.market,
            "revision":2,"snapshot":{"newest_price_at":t,"prices":{"1":{
                "total_buyout":24,"units":4,"auctions":2,"observed_at":t,"lots":[[2,12,2]]}}}}))
            .unwrap();
        let body = scan::encode(&data).unwrap();
        assert_eq!(
            accept_upload(&c, &state, &body, t).unwrap()["status"],
            "accepted"
        );
        assert_eq!(
            accept_upload(&c, &state, &body, t).unwrap()["status"],
            "unchanged"
        );
        let stored = restore(&c).unwrap().bundle.unwrap().snapshot;
        assert_eq!(stored.estimate_at, t - 10);
        assert_eq!(stored.estimate_prices[&1].total_buyout, 100);
        assert_eq!(stored.prices[&1].lots, vec![[2, 12, 2]]);
    }
    #[test]
    fn cached_views_expire_without_upload() {
        let dir = tempfile::tempdir().unwrap();
        let c = config_at(dir.path());
        let f = feed::parse(
            b"itemId,name,recent,updatedAt\n1,Ore,7,1970-01-01T00:01:40Z\n",
            &c.region,
            &c.market,
            100,
        )
        .unwrap();
        save(&c.dir, "tsm-public.json", &serde_json::to_vec(&f).unwrap()).unwrap();
        let mut s = restore(&c).unwrap();
        s.refresh(&c, 100);
        let r: Value = serde_json::from_slice(&s.views["/api/report"]).unwrap();
        assert!(r["items"][0]["listed_units"].is_null());
        assert_eq!(r["items"][0]["estimate"], 7);
        s.refresh(&c, 101);
        assert_eq!(s.generation, 1);
        s.refresh(&c, 101 + c.age);
        let r: Value = serde_json::from_slice(&s.views["/api/report"]).unwrap();
        assert_eq!(r["items"][0]["estimate"], 7);
        assert_eq!(r["items"][0]["estimate_stale"], true);
        assert_eq!(r["items"][0]["estimate_at"], 100);
        assert_eq!(r["tsm"]["state"], "stale")
    }
}
