//! Choose one order before observing the market. Use common market and yield draws across sizes.
use super::*;
use crate::simulation::{distribution, quantile, MarketDraws, Random, SaleItem, SaleMarket};
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
struct Input {
    id: Option<u64>,
    qty: u64,
    stack: u64,
    lots: Vec<Lot>,
    vendor: Option<f64>,
}
struct Order {
    inputs: Vec<Input>,
    sale: SaleMarket,
    unit: f64,
    min: u32,
    max: u32,
    post: f64,
    return_stack: Option<u64>,
    return_count: u64,
    budget: Option<f64>,
    sigma: f64,
    spread: f64,
}
#[derive(Default, Clone, Copy)]
struct Trade {
    pieces: u64,
    out: f64,
    cost: f64,
    postage: f64,
}
impl Trade {
    fn profit(&self) -> f64 {
        self.out - self.cost
    }
}
impl Order {
    fn postage(&self, input_stacks: u64, pieces: u64) -> f64 {
        let back = self
            .return_stack
            .map_or(self.return_count, |s| pieces.div_ceil(s));
        self.post * (input_stacks + back) as f64
    }

    // Replaying the same seeds for the chosen size gives its distribution in O(trials + limit)
    // memory. A smaller cap for the replay preserves draws and exact overbuy costs.
    fn trial(
        &self,
        seed: u64,
        cap: u64,
        selected_only: bool,
        work: &mut u64,
        mut record: impl FnMut(u64, Trade),
    ) -> Result<()> {
        let mut rng = Random::new(seed);
        let mut draws = MarketDraws::default();
        let mut feasible = cap;
        let mut books = Vec::with_capacity(self.inputs.len());
        for input in &self.inputs {
            let mut lots = Vec::with_capacity(input.lots.len());
            if !input.lots.is_empty() {
                let price = draws.price(input.id, &mut rng, self.sigma);
                let stock = rng.stock(self.spread);
                for &[size, ask, count] in &input.lots {
                    let sampled_price = (ask as f64 * price).round().max(1.);
                    if !safe(sampled_price) {
                        return Err("Sampled buyout exceeds the supported copper range.".into());
                    }
                    let count = (count as f64 * stock).round() as u64;
                    if count > 0 {
                        lots.push([size, sampled_price as u64, count]);
                    }
                }
            }
            if input.vendor.is_none() {
                let units = lots.iter().fold(0u64, |acc, &[s, _, n]| {
                    acc.saturating_add(s.saturating_mul(n))
                });
                feasible = feasible.min(units / input.qty);
            }
            books.push(lots);
        }
        if feasible == 0 || (selected_only && feasible < cap) {
            return Ok(());
        }
        let unit = self.unit * self.sale.factor(&mut draws, &mut rng, self.sigma);
        let mut curves = Vec::with_capacity(books.len());
        for (lots, input) in books.into_iter().zip(&self.inputs) {
            let need = feasible
                .checked_mul(input.qty)
                .filter(|&v| v <= MAX as u64)
                .ok_or("Order quantity exceeds the supported range.")?;
            // Bound exact mixed-stack work across trials, not just per individual market.
            let mixed = lots.iter().any(|l| l[0] != lots[0][0]);
            let ops = if mixed {
                need.saturating_mul(lots.len() as u64)
            } else {
                lots.len() as u64
            };
            *work = work.saturating_add(ops.saturating_add(feasible));
            if *work > 300_000_000 {
                return Err("This comparison is too large. Lower Trials or Maximum crafts and run it again.".into());
            }
            curves.push(Costs::new(lots, need, input.vendor)?);
        }
        let mut pieces = 0;
        for n in 1..=feasible {
            pieces += rng.pieces(self.min, self.max);
            if selected_only && n != cap {
                continue;
            }
            let mut reagent = 0.;
            let mut stacks = 0u64;
            for (input, curve) in self.inputs.iter().zip(&curves) {
                let need = n * input.qty;
                reagent += curve.quote(need).ok_or("Insufficient reagent stock.")?;
                stacks += need.div_ceil(input.stack);
            }
            // Reserve maximum return postage before rolling the actual craft yield.
            if self
                .budget
                .is_some_and(|b| reagent + self.postage(stacks, n * u64::from(self.max)) > b)
            {
                break;
            }
            let postage = self.postage(stacks, pieces);
            let trade = Trade {
                pieces,
                out: (unit * pieces as f64).floor(),
                cost: reagent + postage,
                postage,
            };
            if !safe(trade.cost) || !safe(trade.out) {
                return Err("Order exceeds the supported copper range.".into());
            }
            record(n, trade);
        }
        Ok(())
    }
}

pub fn optimize(args: &V) -> Result<V> {
    let m = &args[0];
    let limit = m["limit"]
        .as_u64()
        .filter(|n| (1..=10000).contains(n))
        .ok_or("Maximum crafts must be between 1 and 10,000.")?;
    let trials = args[1]
        .as_u64()
        .filter(|n| (100..=50000).contains(n))
        .ok_or("Use 100–50,000 trials.")?;
    let sigma = args[2]
        .as_f64()
        .filter(|v| (0. ..=100.).contains(v))
        .ok_or("Invalid price deviation.")?;
    let spread = m["stockSpread"].as_f64().unwrap_or(0.);
    if !(0. ..=100.).contains(&spread) {
        return Err("Invalid stock deviation.".into());
    }
    let y = &m["yield"];
    let min = y["min"].as_u64().unwrap_or(0);
    let max = y["max"].as_u64().unwrap_or(0);
    if min == 0 || max < min || max > u32::MAX as u64 {
        return Err("Invalid craft yield bounds.".into());
    }
    let sale_items: Vec<SaleItem> = if y["saleItems"].is_null() {
        vec![]
    } else {
        serde_json::from_value(y["saleItems"].clone()).map_err(|e| e.to_string())?
    };
    // All refreshed auction output prices use the route's normal auction cut and sale reserve.
    let gross: Option<f64> = sale_items
        .iter()
        .map(|i| Some(i.quantity * i.unit_cost?))
        .sum();
    let refreshed = (y["refreshSale"] == true && !sale_items.is_empty() && uint(&y["base"]) > 0)
        .then(|| gross.map(|g| g / num(&y["base"]) * 323. / 400.))
        .flatten();
    let unit = refreshed
        .or_else(|| y["netPerUnit"].as_f64())
        .filter(|v| v.is_finite() && *v >= 0.)
        .ok_or("A projected sale value is required for this route.")?;
    let budget = m["bankroll"].as_f64();
    if budget.is_some_and(|v| !safe(v) || v < 0.) {
        return Err("Invalid gold budget.".into());
    }
    let mut inputs = vec![];
    for l in rows(&m["lines"]) {
        let qty = uint(&l["quantity"]);
        if qty == 0 {
            return Err("Missing reagent quantity.".into());
        }
        inputs.push(Input {
            id: l["id"].as_u64(),
            qty,
            stack: uint(&l["max_stack"]).max(1),
            lots: stacks::lots(&l["lots"])?,
            vendor: l["vendor"].as_f64(),
        });
    }
    let c = &m["settings"];
    let order = Order {
        inputs,
        min: min as u32,
        max: max as u32,
        unit,
        sigma,
        spread,
        budget,
        sale: SaleMarket::new(y["marketSale"] == true, &sale_items),
        post: if c["mail"] == true {
            num(&c["post"])
        } else {
            0.
        },
        return_stack: y["returnStack"]
            .as_u64()
            .filter(|s| *s > 0 && c["back"] == true),
        return_count: if c["back"] == true && m["destroys"] == true {
            uint(&c["returns"])
        } else {
            0
        },
    };
    let stochastic = min != max
        || (sigma > 0. && y["marketSale"] == true)
        || ((sigma > 0. || spread > 0.) && order.inputs.iter().any(|i| !i.lots.is_empty()));
    let runs = if stochastic { trials } else { 1 };
    let mut rng = Random::new(uint(&args[3]));
    let seeds: Vec<u64> = (0..runs).map(|_| rng.next_seed()).collect();
    let mut work = 0;
    let mut sums = vec![0i128; limit as usize + 1];
    let mut largest = 0;
    for &seed in &seeds {
        order.trial(seed, limit, false, &mut work, |n, t| {
            sums[n as usize] += t.profit() as i128;
            largest = largest.max(n);
        })?;
    }
    let mut best = 0;
    for n in 1..sums.len() {
        if sums[n] > sums[best] {
            best = n;
        }
    }
    let mut profits = Vec::with_capacity(trials as usize);
    let (mut filled, mut wins) = (0, 0);
    let mut totals = Trade::default();
    for &seed in &seeds {
        let mut profit = 0.;
        if best != 0 {
            order.trial(seed, best as u64, true, &mut work, |_, t| {
                filled += 1;
                wins += u64::from(t.profit() > 0.);
                profit = t.profit();
                totals.pieces += t.pieces;
                totals.out += t.out;
                totals.cost += t.cost;
                totals.postage += t.postage;
            })?;
        }
        profits.push(profit);
    }
    if runs == 1 {
        profits.resize(trials as usize, profits[0]);
    }
    profits.sort_unstable_by(f64::total_cmp);
    let count = (filled as f64).max(1.);
    let mut result = json!({"casts":best, "pieces":totals.pieces as f64/count,
        "minPieces":best as u64*min, "maxPieces":best as u64*max,
        "cost":totals.cost/count,"postage":totals.postage/count,"out":totals.out/count,
        "profit":sums[best] as f64/runs as f64, "p5":quantile(&profits,0.05),"p95":quantile(&profits,0.95),
        "fillPercent":100.*filled as f64/runs as f64,"winPercent":100.*wins as f64/runs as f64,
        "feasible":largest,"trials":trials});
    distribution(&profits, &mut result, "Net profit");
    Ok(result)
}
