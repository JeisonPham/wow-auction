use crate::{
    feed::{self, Feed},
    fresh, now, planner,
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
    let c = Config {
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
    };
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
    checked: u64,
    error: Option<String>,
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
        let mut r = planner::market_report(
            &c.region,
            &c.market,
            self.bundle.as_ref(),
            &self.feed,
            c.age,
            t,
        );
        if let Some(port) = env::var("WOW_TSM_DESKTOP_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .filter(|p| *p > 0)
        {
            r["desktop_port"] = json!(port);
        }
        r["uploaded_at"] = json!(self.uploaded_at);
        r["tsm"]["error"] = json!(self.error);
        let status = json!({"responsive":true,"region":c.region,"market":c.market,"upload_revision":r["upload_revision"],"generated_at":t,"tsm":r["tsm"],"uploaded_at":self.uploaded_at,"public_enabled":c.public,"public_checked_at":self.checked});
        let queue = json!({"region":c.region,"market":c.market,"items":r["scan_queue"],"estimate_at":r["queue_estimate_at"],"expires_at":r["queue_estimate_at"].as_u64().filter(|n|*n>0).map_or(0,|n|n+c.age),"upload_revision":r["upload_revision"]});
        let candidates =
            json!({"items":r["scan_queue"],"tsm":r["tsm"],"upload_revision":r["upload_revision"]});
        let mut times = vec![self.feed.at];
        if let Some(b) = &self.bundle {
            times.extend(b.times());
            times.extend(b.targeted.iter().map(|c| c.captured_at))
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
    let b = scan::decode(buf, &c.region, &c.market, t).map_err(|e| (422, e))?;
    let revision = b.revision;
    let normalized = scan::encode(&b).map_err(|e| (503, e))?;
    let mut s = state.lock().unwrap();
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
    }
    save(&c.dir, "scan-upload.json.gz", &normalized).map_err(|e| (503, e))?;
    s.bundle = Some(b);
    s.uploaded_at = Some(t);
    s.views.clear();
    Ok(json!({"revision":revision,"status":"accepted"}))
}
fn handle(mut r: Request, c: &Config, state: &Mutex<State>) {
    let path = r.url().split('?').next().unwrap_or("").to_owned();
    let method = r.method().as_str().to_owned();
    if matches!(path.as_str(), "/api/scans" | "/api/scan-queue") {
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
    if path == "/api/scans" && method == "POST" {
        if header(&r, "Content-Type") != ["application/gzip"] {
            return fail(r, 415, "expected application/gzip");
        }
        if r.body_length().unwrap_or(0) > scan::COMPRESSED {
            return fail(r, 413, "compressed limit exceeded");
        }
        let mut buf = vec![];
        if r.as_reader()
            .take(scan::COMPRESSED as u64 + 1)
            .read_to_end(&mut buf)
            .is_err()
        {
            return fail(r, 422, "unreadable upload");
        }
        if buf.len() > scan::COMPRESSED {
            return fail(r, 413, "compressed limit exceeded");
        }
        let response = accept_upload(c, state, &buf, now());
        return match response {
            Ok(value) => reply(r, 202, value),
            Err((code, e)) => fail(r, code, &e),
        };
    }
    if method != "GET" && method != "HEAD" {
        return fail(r, 405, "unsupported method");
    }
    let asset = match path.as_str() {
        "/" => Some((
            "text/html; charset=utf-8",
            include_str!("../web/index.html"),
        )),
        "/app.css" => Some(("text/css", include_str!("../web/app.css"))),
        "/app.js" => Some(("text/javascript", include_str!("../web/app.js"))),
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
    let mut s = state.lock().unwrap();
    if path == "/api/scan-queue" && s.bundle.is_none() {
        return fail(r, 503, "awaiting first upload");
    }
    s.refresh(c, now());
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
                    && f.items.len() <= 250000
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
    Ok(State {
        bundle,
        uploaded_at,
        feed,
        checked: 0,
        error: None,
        views: HashMap::new(),
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
    if c.public {
        let c = c.clone();
        let state = state.clone();
        thread::spawn(move || loop {
            let result = feed::fetch(&c.region, &c.market);
            let mut s = state.lock().unwrap();
            s.checked = now();
            let result = result.and_then(|f| {
                if f.at < s.feed.at {
                    return Err("public feed timestamp rollback".into());
                }
                save(
                    &c.dir,
                    "tsm-public.json",
                    &serde_json::to_vec(&f).map_err(|e| e.to_string())?,
                )?;
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
        assert!(r["items"][0]["estimate"].is_null());
        assert_eq!(r["tsm"]["state"], "stale")
    }
}
