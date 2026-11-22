use crate::catalog::FOREVER;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Default)]
struct Schedule<'a> {
    active: f64,
    elapsed: f64,
    assumed: bool,
    // First start and next availability of each recipe with a cooldown.
    cooldowns: BTreeMap<&'a str, (f64, f64)>,
}

impl<'a> Schedule<'a> {
    fn craft(&mut self, step: &'a Value, runs: u64) {
        let req = &step["requirements"];
        let seconds = req["cast_seconds"].as_f64().filter(|&n| n >= 0.0);
        self.assumed |= seconds.is_none();
        let seconds = seconds.unwrap_or(3.0);
        let cooldown = req["cooldown_seconds"].as_f64().unwrap_or_default();
        self.active += seconds * runs as f64;
        if cooldown > 0.0 && runs > 0 {
            let id = step["recipe_id"].as_str().expect("planner recipe ID");
            let entry = self.cooldowns.entry(id).or_insert((self.elapsed, 0.0));
            let start = self.elapsed.max(entry.1);
            self.elapsed = start + seconds * runs as f64 + cooldown * (runs - 1) as f64;
            entry.1 = self.elapsed + cooldown;
        } else {
            self.elapsed += seconds * runs as f64;
        }
    }

    fn disenchant(&mut self, pieces: u64) {
        let seconds = FOREVER.disenchant_seconds * pieces as f64;
        self.elapsed += seconds;
        self.active += seconds;
    }
}

pub(super) fn estimate(route: &Value) -> Option<Value> {
    let kind = route["kind"].as_str()?;
    if kind == "vendor" {
        return None;
    }
    let mut schedule = Schedule::default();
    for step in route["stages"].as_array().into_iter().flatten() {
        match step["action"].as_str()? {
            "craft" => schedule.craft(step, step["runs"].as_u64()?),
            "disenchant" => schedule.disenchant(step["quantity"].as_u64()?),
            _ => return None,
        }
    }
    if kind != "disenchant" {
        schedule.craft(route, 1);
    }
    if matches!(kind, "disenchant" | "craft_disenchant") {
        schedule.disenchant(route["quantity"].as_u64()?);
    }
    // Keep the same action offsets on each successive run. A cooldown may
    // overlap another craft, including work at the start of the next run.
    let cooldown_span = schedule
        .cooldowns
        .values()
        .fold(0.0_f64, |period, (first, next)| period.max(next - first));
    let period = schedule.elapsed.max(cooldown_span);
    let gold_per_hour = route["profit"]
        .as_f64()
        .filter(|_| period > 0.0)
        .map(|copper| copper / 10_000.0 * 3600.0 / period);
    Some(
        json!({"active_seconds": schedule.active, "elapsed_seconds": schedule.elapsed,
        "repeat_seconds": period, "cooldown_span":cooldown_span,
        "end_de_seconds":if kind == "craft_disenchant" { FOREVER.disenchant_seconds } else {0.0}, "assumed_cast": schedule.assumed, "gold_per_hour": gold_per_hour}),
    )
}
