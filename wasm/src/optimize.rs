//! Compare every permitted whole-craft count against the same listing snapshot.
use super::*;
use crate::stacks::{self, Lot};
use std::collections::VecDeque;

// For each residue modulo stack size, the bounded knapsack recurrence is a sliding
// minimum. The final bin includes oversized finishing stacks. One curve prices all orders.
fn mixed_costs(lots: &[Lot], max: usize, vendor: Option<f64>) -> Result<Vec<f64>> {
    if max > 2_000_000 || max.saturating_mul(lots.len()) > 80_000_000 {
        return Err("Too many mixed-stack combinations for this craft limit. Lower Maximum crafts and retry.".into());
    }
    let mut prev = vec![f64::INFINITY; max + 1];
    prev[0] = 0.;
    for &[size, ask, count] in lots {
        let mut next = prev.clone();
        let step = size.min(max as u64 + 1) as usize;
        for start in 0..step.min(max) {
            let mut queue: VecDeque<(u64, i128)> = VecDeque::new();
            for (k, n) in (start..max).step_by(step).enumerate() {
                let k = k as u64;
                while queue.front().is_some_and(|p| p.0.saturating_add(count) < k) {
                    queue.pop_front();
                }
                if prev[n].is_finite() {
                    let adjusted = prev[n] as i128 - i128::from(k) * i128::from(ask);
                    while queue.back().is_some_and(|p| p.1 >= adjusted) {
                        queue.pop_back();
                    }
                    queue.push_back((k, adjusted));
                    let finish = ((max - n) as u64).div_ceil(size);
                    if finish <= count {
                        next[max] = next[max].min(prev[n] + finish as f64 * ask as f64)
                    }
                }
                if let Some(&(from, _)) = queue.front() {
                    next[n] = next[n]
                        .min(prev[start + from as usize * step] + (k - from) as f64 * ask as f64)
                }
            }
        }
        prev = next;
    }
    if let Some(price) = vendor {
        for n in 1..=max {
            prev[n] = prev[n].min(prev[n - 1] + price)
        }
    }
    for n in (0..max).rev() {
        prev[n] = prev[n].min(prev[n + 1])
    }
    Ok(prev)
}
// Equal-size stacks admit a cheaper exact solution: prefix sums of stack counts and buyouts.
enum Costs {
    Uniform {
        size: u64,
        tiers: Vec<(u64, f64, u64)>,
        vendor: Option<f64>,
    },
    Mixed(Vec<f64>),
}
impl Costs {
    fn new(mut lots: Vec<Lot>, need: u64, vendor: Option<f64>) -> Result<Self> {
        stacks::sort(&mut lots);
        lots.retain(|&[size, p, count]| {
            count > 0 && vendor.is_none_or(|v| (p as f64) < v * size as f64)
        });
        let size = lots.first().map_or(1, |l| l[0]);
        if lots.iter().all(|l| l[0] == size) {
            let (mut count, mut cash) = (0, 0.);
            let tiers = lots
                .iter()
                .map(|&[_, ask, n]| {
                    count += n;
                    cash += n as f64 * ask as f64;
                    (count, cash, ask)
                })
                .collect();
            Ok(Self::Uniform {
                size,
                tiers,
                vendor,
            })
        } else {
            Ok(Self::Mixed(mixed_costs(
                &lots,
                usize::try_from(need).map_err(|_| "Lower the craft limit for this reagent.")?,
                vendor,
            )?))
        }
    }
    fn quote(&self, need: u64) -> Option<f64> {
        match self {
            Self::Mixed(costs) => costs.get(need as usize).copied().filter(|c| c.is_finite()),
            Self::Uniform {
                size,
                tiers,
                vendor,
            } => {
                let total = tiers.last().map_or(0, |v| v.0);
                let buy = |count: u64| {
                    if count == 0 {
                        0.
                    } else {
                        let i = tiers.partition_point(|&(end, _, _)| end < count);
                        let (before, spent, _) = i.checked_sub(1).map_or((0, 0., 0), |p| tiers[p]);
                        spent + (count - before) as f64 * tiers[i].2 as f64
                    }
                };
                let whole = (need / size).min(total);
                let full = need.div_ceil(*size);
                let auction = (full <= total).then(|| buy(full));
                let top_up = vendor.map(|v| buy(whole) + (need - whole * size) as f64 * v);
                auction.into_iter().chain(top_up).reduce(f64::min)
            }
        }
    }
}
pub fn optimize(m: &V) -> Result<V> {
    let limit = uint(&m["limit"]);
    if !(1..=10000).contains(&limit) {
        return Err("Maximum crafts must be between 1 and 10,000.".into());
    }
    let y = &m["yield"];
    let min = uint(&y["min"]);
    let max = uint(&y["max"]);
    if min == 0 || max < min || max > u32::MAX as u64 {
        return Err("Invalid craft yield bounds.".into());
    }
    let unit = y["netPerUnit"]
        .as_f64()
        .filter(|v| *v >= 0.)
        .ok_or("A projected sale value is required for this route.")?;
    let bank = m["bankroll"].as_f64();
    if bank.is_some_and(|v| !safe(v) || v < 0.) {
        return Err("Invalid gold budget.".into());
    }
    let mean = (min + max) as f64 / 2.;
    let mut inputs = vec![];
    let mut feasible_limit = limit;
    for l in rows(&m["lines"]) {
        let qty = uint(&l["quantity"]);
        if qty == 0 {
            return Err("Missing reagent quantity.".into());
        }
        let lots = stacks::lots(&l["lots"])?;
        let vendor = l["vendor"].as_f64();
        if vendor.is_none() {
            let units: u64 = lots.iter().map(|&[s, _, n]| s * n).sum();
            feasible_limit = feasible_limit.min(units / qty)
        }
        inputs.push((l, qty, lots, vendor));
    }
    let c = &m["settings"];
    let mut curves = vec![];
    for (l, q, lots, v) in inputs {
        let need = q
            .checked_mul(feasible_limit)
            .filter(|v| *v <= MAX as u64)
            .ok_or("Order quantity exceeds the supported range.")?;
        let stack = uint(&l["max_stack"]).max(1);
        curves.push((q, stack, Costs::new(lots, need, v)?));
    }
    let mut best = json!({"casts":0,"pieces":0,"minPieces":0,"maxPieces":0,"cost":0,"postage":0,"out":0,"profit":0});
    let mut feasible = 0;
    let mut budget_limited = false;
    for n in 1..=feasible_limit {
        let mut reagent = 0.;
        let mut stacks = 0;
        for (q, size, curve) in &curves {
            let need = q * n;
            reagent += curve.quote(need).ok_or("Insufficient reagent stock.")?;
            stacks += need.div_ceil(*size);
        }
        let pieces = n as f64 * mean;
        if c["back"] == true {
            if let Some(size) = y["returnStack"].as_u64().filter(|s| *s > 0) {
                stacks += (pieces / size as f64).ceil() as u64
            } else if m["destroys"] == true {
                stacks += uint(&c["returns"])
            }
        }
        let postage = if c["mail"] == true {
            stacks as f64 * num(&c["post"])
        } else {
            0.
        };
        let cost = reagent + postage;
        let out = (pieces * unit).floor();
        if !safe(cost) || !safe(out) {
            return Err("Order exceeds the supported copper range.".into());
        }
        if bank.is_some_and(|v| cost > v) {
            budget_limited = true;
            break;
        }
        feasible = n;
        let profit = out - cost;
        if profit > num(&best["profit"]) {
            best = json!({"casts":n,"pieces":pieces,"minPieces":n*min,"maxPieces":n*max,"cost":cost,"postage":postage,"out":out,"profit":profit})
        }
    }
    best["feasible"] = json!(feasible);
    best["limit"] = json!(limit);
    best["constraint"] = json!(if budget_limited {
        "Gold budget"
    } else if feasible_limit < limit {
        "Reagent stock"
    } else {
        "Maximum crafts"
    });
    Ok(best)
}
