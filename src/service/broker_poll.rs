use super::{accept_broker, env_or, Config, State};
use crate::{catalog::FOREVER, now, Result};
use std::{
    cmp::Reverse,
    collections::{BTreeMap, HashSet},
    env,
    path::PathBuf,
    process::Command,
    sync::Mutex,
    thread,
    time::Duration,
};

const HOUR: u64 = 3600;

pub(super) fn targets(setting: &str) -> Result<Vec<String>> {
    if !setting.trim().eq_ignore_ascii_case("auto") {
        let mut seen = HashSet::new();
        let mut urls = Vec::new();
        for url in setting.split_whitespace() {
            if url.eq_ignore_ascii_case("auto") {
                return Err("Set WOW_BROKER_URLS to auto or to a space-separated watchlist".into());
            }
            if seen.insert(url) {
                urls.push(url.to_owned());
            }
        }
        return Ok(urls);
    }

    let catalog = &*FOREVER;
    let mut uses = BTreeMap::<u32, usize>::new();
    for recipe in &catalog.snapshot.recipes {
        uses.entry(recipe.output).or_default();
        for &(id, _) in &recipe.mats {
            *uses.entry(id).or_default() += 1;
        }
    }
    for drops in catalog
        .snapshot
        .disenchant
        .iter()
        .map(|band| &band.mats)
        .chain(catalog.overrides.values())
    {
        for id in drops.keys() {
            uses.entry(*id).or_default();
        }
    }
    let mut ranked: Vec<_> = uses.into_iter().collect();
    ranked.sort_unstable_by_key(|&(id, count)| (Reverse(count), id));
    Ok(ranked
        .into_iter()
        .filter_map(|(id, _)| {
            let item = catalog.snapshot.items.get(&id);
            if item.is_some_and(|i| {
                matches!(i.binding.as_str(), "Binds when picked up" | "Quest item")
            }) {
                return None;
            }
            let mut url = format!("https://bootybaybroker.com/forever/item/{id}");
            if let Some(item) = item {
                let name = item.name.to_ascii_lowercase().replace('\'', "");
                let slug = name
                    .split(|c: char| !c.is_ascii_alphanumeric())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("-");
                if !slug.is_empty() {
                    url.push('/');
                    url.push_str(&slug);
                }
            }
            Some(url)
        })
        .collect())
}

pub(super) fn run(c: &Config, state: &Mutex<State>) {
    let helper = env::var_os("WOW_BROKER_HELPER").map_or_else(
        || PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("client/broker.py"),
        PathBuf::from,
    );
    let python = env_or(
        "WOW_BROKER_PYTHON",
        if cfg!(windows) { "python" } else { "python3" },
    );
    let mut next_page = 0;
    loop {
        let mut delay = HOUR;
        let mut error = None;
        let mut paused = false;
        let mut updated = 0;
        for attempt in 0..c.broker_urls.len() {
            let index = next_page;
            let url = &c.broker_urls[index];
            next_page = (index + 1) % c.broker_urls.len();
            if attempt > 0 {
                thread::sleep(Duration::from_secs(c.broker_delay));
            }
            // The preview returns source observations directly. No scanner credentials
            // or HTTP call to our own API are needed for a server-owned pull.
            let result = Command::new(&python)
                .arg(&helper)
                .args([
                    "--preview",
                    "--region",
                    &c.region,
                    "--market",
                    &c.market,
                    "--fetch",
                    url,
                ])
                .env_remove("WOW_BLIZZARD_CLIENT_ID")
                .env_remove("WOW_BLIZZARD_CLIENT_SECRET")
                .env_remove("WOW_UPLOAD_TOKEN")
                .env_remove("WOW_UPLOAD_TOKEN_FILE")
                .output();
            let output = match result {
                Ok(output) => output,
                Err(e) => {
                    error = Some(format!("Cannot launch Broker importer: {e}"));
                    break;
                }
            };
            match output.status.code() {
                Some(0) => match accept_broker(c, state, &output.stdout, now()) {
                    Ok(receipt) => updated += receipt["updated"].as_u64().unwrap_or(0),
                    Err((_, e)) => error = Some(e),
                },
                Some(3) => continue, // A valid page has no price for this market.
                code => {
                    let message = String::from_utf8_lossy(&output.stderr);
                    error = Some(format!("Item page {}: {}", index + 1, message.trim()));
                    if code == Some(65) {
                        continue;
                    }
                    if matches!(code, Some(77 | 78)) {
                        paused = true;
                        break;
                    }
                    if code == Some(75) {
                        next_page = index;
                        let retry = String::from_utf8_lossy(&output.stdout);
                        delay = HOUR.max(retry.trim().parse().unwrap_or(HOUR));
                        break;
                    }
                    // End the pass on a transport failure and keep previously accepted quotes.
                    break;
                }
            }
        }
        {
            let mut s = state.lock().unwrap();
            s.broker_checked_at = Some(now());
            s.broker_error = error;
            s.views.clear();
            if let Some(e) = &s.broker_error {
                eprintln!("Broker pull: {e}");
            }
            eprintln!(
                "Broker pull finished for {} / {}: {updated} prices updated",
                c.region, c.market
            );
        }
        if paused {
            eprintln!("Broker pulling is paused until server restart.");
            return;
        }
        thread::sleep(Duration::from_secs(delay));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_targets_cover_the_catalog_without_duplicate_items() {
        let urls = targets("auto").unwrap();
        let ids: HashSet<u32> = urls
            .iter()
            .map(|url| {
                url.strip_prefix("https://bootybaybroker.com/forever/item/")
                    .unwrap()
                    .split('/')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap()
            })
            .collect();
        assert_eq!(ids.len(), urls.len());
        assert!(ids.len() > 2000);
        for recipe in &FOREVER.snapshot.recipes {
            for id in std::iter::once(recipe.output).chain(recipe.mats.iter().map(|m| m.0)) {
                let bound = FOREVER.snapshot.items.get(&id).is_some_and(|i| {
                    matches!(i.binding.as_str(), "Binds when picked up" | "Quest item")
                });
                assert_eq!(ids.contains(&id), !bound);
            }
        }
        assert!(ids.contains(&10940)); // Strange Dust
        assert!(urls.iter().any(|u| u.ends_with("/14047/runecloth")));
        let one = "https://bootybaybroker.com/forever/item/2840/copper-bar";
        assert_eq!(targets(&format!("{one} {one}")).unwrap(), [one]);
        assert!(targets("").unwrap().is_empty());
        assert!(targets(&format!("auto {one}")).is_err());
    }
}
