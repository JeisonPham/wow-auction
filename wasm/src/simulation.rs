use crate::{
    stacks::{Lot, Pricer},
    *,
};
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Model {
    unit_only: bool,
    order: bool,
    batch: u64,
    postage: f64,
    proceeds: Option<f64>,
    bankroll: Option<f64>,
    #[serde(rename = "yield")]
    output: Option<Yield>,
    lines: Vec<Line>,
    target: u64,
    stock_spread: f64,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct Line {
    quantity: u64,
    source: String,
    unit_cost: Option<f64>,
    cost: Option<f64>,
    vendor: Option<f64>,
    lots: Vec<Lot>,
    listed_units: Option<u64>,
}
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Yield {
    min: u32,
    max: u32,
    base: u32,
    net_per_unit: Option<f64>,
    timing: Option<Timing>,
    return_stack: Option<u64>,
    post: f64,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct Timing {
    elapsed_seconds: f64,
    repeat_seconds: f64,
    end_de_seconds: f64,
    cooldown_span: f64,
}

// SplitMix64 uses a seed supplied once by the browser. No host calls within a trial.
struct Random {
    state: u64,
    spare: Option<f64>,
}
impl Random {
    fn uniform(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }
    fn normal(&mut self) -> f64 {
        if let Some(n) = self.spare.take() {
            return n;
        }
        let radius = (-2. * (-self.uniform()).ln_1p()).sqrt();
        let (sin, cos) = (std::f64::consts::TAU * self.uniform()).sin_cos();
        self.spare = Some(radius * sin);
        radius * cos
    }
    fn price(&mut self, sigma: f64) -> f64 {
        if sigma == 0. {
            return 1.;
        }
        loop {
            let f = 1. + self.normal() * sigma / 100.;
            if f > 0. {
                return f;
            }
        }
    }
    fn pieces(&mut self, y: &Yield) -> u64 {
        if y.min == y.max {
            return u64::from(y.min);
        }
        u64::from(y.min) + (self.uniform() * ((y.max - y.min) as f64 + 1.)) as u64
    }
}
fn quantile(s: &[f64], f: f64) -> f64 {
    let i = (s.len() - 1) as f64 * f;
    s[i.floor() as usize] + (s[i.ceil() as usize] - s[i.floor() as usize]) * i.fract()
}
fn mean(s: &[f64]) -> f64 {
    s.iter().sum::<f64>() / s.len() as f64
}
fn distribution(s: &[f64], result: &mut V, metric: &str) {
    let (low, high) = (s[0], s[s.len() - 1]);
    let n = if low == high { 1 } else { 20 };
    let mut bins = vec![0; n];
    for v in s {
        let i = if n == 1 {
            0
        } else {
            (((v - low) / (high - low) * n as f64) as usize).min(n - 1)
        };
        bins[i] += 1
    }
    let peak = *bins.iter().max().unwrap() as f64;
    let width = (high - low) / n as f64;
    result["bars"] = json!(bins
        .iter()
        .enumerate()
        .map(|(i, &count)| json!({
            "count":count, "height":100. * f64::from(count) / peak,
            "from":low + i as f64 * width, "to":low + (i + 1) as f64 * width
        }))
        .collect::<Vec<_>>());
    result["low"] = json!(low);
    result["high"] = json!(high);
    result["bins"] = json!(bins);
    result["chartMetric"] = json!(metric);
}
fn stats(s: &mut [f64]) -> V {
    s.sort_unstable_by(f64::total_cmp);
    json!({"average":mean(s),"p5":quantile(s,0.05),"median":quantile(s,0.5),"p95":quantile(s,0.95)})
}
fn copper(v: f64) -> Result<f64> {
    if safe(v) {
        Ok(v)
    } else {
        Err("Cost exceeds the supported copper range.".into())
    }
}
pub fn kelly(returns: &[f64]) -> f64 {
    let slope = |f: f64| returns.iter().map(|r| r / (1. + f * r)).sum::<f64>();
    if slope(0.) <= 0. {
        return 0.;
    }
    if slope(1.) >= 0. {
        return 1.;
    }
    let (mut lo, mut hi) = (0., 1.);
    for _ in 0..54 {
        let mid = (lo + hi) / 2.;
        if slope(mid) > 0. {
            lo = mid
        } else {
            hi = mid
        }
    }
    (lo + hi) / 2.
}
pub fn size(model: &V, returns: &[f64]) -> V {
    let batch = num(&model["batch"]);
    let bank = num(&model["bankroll"]);
    if returns.iter().any(|r| !r.is_finite()) {
        return json!({"unavailable":"Kelly sizing requires a positive batch cost in every trial."});
    }
    let mut quote = rows(&model["lines"])
        .iter()
        .map(|l| num(&l["cost"]))
        .sum::<f64>()
        * batch
        + num(&model["postage"]);
    let y = &model["yield"];
    if let Some(stack) = y["returnStack"].as_f64().filter(|s| *s > 0.) {
        quote += ((batch * num(&y["max"]) / stack).ceil()
            - (batch * num(&y["base"]) / stack).ceil())
            * num(&y["post"]);
    }
    if !safe(quote) || quote <= 0. {
        return json!({"unavailable":"Kelly sizing needs a positive quoted batch cost within the supported copper range."});
    }
    let affordable = (bank / quote).floor();
    let available = rows(&model["lines"])
        .iter()
        .filter(|l| l["source"] != "vendor")
        .filter_map(|l| Some((l["listed_units"].as_f64()? / (batch * num(&l["quantity"]))).floor()))
        .fold(f64::INFINITY, f64::min);
    let fraction = kelly(returns);
    let target = fraction * bank;
    let limit = affordable.min(available);
    let mut batches = limit.min((target / quote).floor());
    if batches < limit && target > batches * quote {
        let gain: f64 = returns
            .iter()
            .map(|r| {
                if (batches + 1.) * quote == bank && *r == -1. {
                    f64::NEG_INFINITY
                } else {
                    ((quote / bank * r) / (1. + batches * quote / bank * r)).ln_1p()
                }
            })
            .sum();
        if gain > 0. {
            batches += 1.
        }
    }
    let spend = batches * quote;
    json!({"fraction":fraction,"target":target.round(),"batches":batches,"quote":quote,"spend":spend,"remaining":bank-spend,"stockLimited":available<affordable && available*quote<target})
}
fn order(m: &mut Model, trials: usize, sigma: f64, rng: &mut Random) -> Result<V> {
    let y = m.output.as_ref().ok_or("Missing recipe yield")?;
    if !(1..=10000).contains(&m.target) || !(0. ..=100.).contains(&m.stock_spread) {
        return Err("Invalid target or stock deviation.".into());
    }
    let planned = m.target.div_ceil(y.base.clamp(y.min, y.max) as u64);
    let mut prices: Vec<_> = m
        .lines
        .iter_mut()
        .map(|l| Pricer::new(std::mem::take(&mut l.lots)))
        .collect();
    let price = |p: &mut Pricer, l: &Line, n: u64, f, s| -> Result<Option<f64>> {
        let need = l
            .quantity
            .checked_mul(n)
            .filter(|q| *q <= MAX as u64)
            .ok_or("Reagent quantity exceeds the supported range.")?;
        p.buy(need, f, s, l.vendor, 10000)
            .map(|v| copper(v.0.ceil()))
            .transpose()
    };
    let current = prices
        .iter_mut()
        .zip(&m.lines)
        .map(|(p, l)| price(p, l, planned, 1., 1.))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .sum::<Option<f64>>()
        .map(copper)
        .transpose()?;
    let mut costs = vec![];
    let mut shortages = vec![0; prices.len()];
    let mut run_total = 0;
    for _ in 0..trials {
        let n = if y.min == y.max {
            m.target.div_ceil(y.min as u64)
        } else {
            let (mut made, mut n) = (0, 0);
            while made < m.target {
                made += rng.pieces(y);
                n += 1
            }
            n
        };
        run_total += n;
        let mut total = Some(0.);
        for (i, (p, l)) in prices.iter_mut().zip(&m.lines).enumerate() {
            let auction = !p.lots.is_empty();
            let stock = if auction && m.stock_spread > 0. {
                (1. + rng.normal() * m.stock_spread / 100.).max(0.)
            } else {
                1.
            };
            let f = if auction { rng.price(sigma) } else { 1. };
            let cost = price(p, l, n, f, stock)?;
            if cost.is_none() {
                shortages[i] += 1
            }
            total = total.zip(cost).map(|(a, b)| a + b);
        }
        if let Some(c) = total {
            costs.push(copper(c)?)
        }
    }
    let mut result = if costs.is_empty() {
        json!({})
    } else {
        let mut r = stats(&mut costs);
        distribution(&costs, &mut r, "Reagent cost");
        r["budget95"] = json!(num(&r["p95"]).ceil());
        r
    };
    result["filled"] = json!(costs.len());
    result["fillPercent"] = json!(100. * costs.len() as f64 / trials as f64);
    result["shortagePercent"] = json!(shortages
        .iter()
        .map(|&n| 100. * n as f64 / trials as f64)
        .collect::<Vec<_>>());
    result["shortages"] = json!(shortages);
    result["target"] = json!(m.target);
    result["current"] = json!(current);
    result["plannedRuns"] = json!(planned);
    result["runs"] = json!(run_total as f64 / trials as f64);
    Ok(result)
}
pub fn simulate(a: &V) -> Result<V> {
    let mut m: Model = serde_json::from_value(a[0].clone()).map_err(|e| e.to_string())?;
    let trials = uint(&a[1]) as usize;
    let sigma = num(&a[2]);
    if !(100..=50000).contains(&trials) || !safe(num(&a[1])) || !(0. ..=100.).contains(&sigma) {
        return Err("Use 100–50,000 trials and a deviation from 0% to 100%.".into());
    }
    if m.output
        .as_ref()
        .is_some_and(|y| y.min == 0 || y.base == 0 || y.min > y.max)
    {
        return Err("Invalid craft yield bounds.".into());
    }
    let mut rng = Random {
        state: uint(&a[3]),
        spare: None,
    };
    if m.order {
        return order(&mut m, trials, sigma, &mut rng);
    }
    if !(1..=10000).contains(&m.batch) {
        return Err("Invalid batch size.".into());
    }
    if m.bankroll.is_some_and(|v| !safe(v) || v < 0.) {
        return Err("Enter starting gold as a nonnegative amount in whole copper.".into());
    }
    let batch = m.batch as f64;
    let fixed = m
        .lines
        .iter()
        .filter(|l| l.source == "vendor")
        .map(|l| l.cost.unwrap_or(0.))
        .sum::<f64>()
        * batch
        + m.postage;
    let auction: Vec<_> = m.lines.iter().filter(|l| l.source != "vendor").collect();
    let (mut costs, mut profits, mut units, mut returns) = (vec![], vec![], vec![], vec![]);
    let (mut wins, mut timed, mut rate) = (0, 0, 0.);
    for _ in 0..trials {
        let mut cost = fixed;
        for l in &auction {
            let p = l.unit_cost.unwrap_or(0.) * rng.price(sigma);
            if m.unit_only {
                cost = p
            } else {
                cost += batch
                    * if sigma == 0. {
                        l.cost.unwrap_or(0.)
                    } else {
                        (p * l.quantity as f64).ceil()
                    }
            }
        }
        let mut sale = m.proceeds.unwrap_or(0.);
        let mut seconds = 0.;
        if let Some(y) = &m.output {
            let mut pieces = 0;
            sale = 0.;
            let timing = y.timing.as_ref();
            let de = timing.map_or(0., |t| t.end_de_seconds);
            if let Some(t) = timing {
                if de == 0. {
                    seconds = t.elapsed_seconds + (batch - 1.) * t.repeat_seconds
                }
            }
            let repeats = if y.min == y.max { 1 } else { m.batch };
            let multiplier = m.batch / repeats;
            for j in 0..repeats {
                let n = rng.pieces(y);
                pieces += n * multiplier;
                sale += multiplier as f64
                    * if n == u64::from(y.base) {
                        m.proceeds.unwrap_or(0.) / batch
                    } else {
                        (n as f64 * y.net_per_unit.unwrap_or(0.)).floor()
                    };
                if let Some(t) = timing.filter(|_| de > 0.) {
                    let elapsed = t.elapsed_seconds + (n as f64 - f64::from(y.base)) * de;
                    let repeat = elapsed.max(t.cooldown_span);
                    seconds += multiplier as f64 * repeat;
                    if j + 1 == repeats {
                        seconds += elapsed - repeat
                    }
                }
            }
            if let Some(stack) = y.return_stack.filter(|s| *s > 0) {
                cost += (pieces.div_ceil(stack) as f64
                    - (u64::from(y.base) * m.batch).div_ceil(stack) as f64)
                    * y.post
            }
            units.push(pieces as f64)
        }
        if !cost.is_finite() || cost > MAX {
            return Err("Cost exceeds the supported copper range.".into());
        }
        costs.push(cost);
        if m.proceeds.is_some() {
            copper(sale)?;
            let profit = sale - cost;
            profits.push(profit);
            wins += usize::from(profit > 0.);
            if m.bankroll.is_some() && !m.unit_only {
                returns.push(if cost > 0. { profit / cost } else { f64::NAN })
            }
            if seconds > 0. {
                timed += 1;
                rate += profit * 0.36 / seconds
            }
        }
    }
    let mut out = stats(&mut costs);
    profits.sort_unstable_by(f64::total_cmp);
    units.sort_unstable_by(f64::total_cmp);
    let varying = m.output.as_ref().is_some_and(|y| y.min != y.max) && !profits.is_empty();
    distribution(
        if varying { &profits } else { &costs },
        &mut out,
        if varying {
            "Batch profit"
        } else if m.unit_only {
            "Unit price"
        } else {
            "Batch cost"
        },
    );
    out["output"]=json!((!units.is_empty()).then(||json!({"mean":mean(&units),"p5":units[((trials-1) as f64*0.05).floor() as usize],"p95":units[((trials-1) as f64*0.95).ceil() as usize]})));
    out["profit"] = json!((!profits.is_empty()).then(
        || json!({"mean":mean(&profits),"p5":quantile(&profits,0.05),"p95":quantile(&profits,0.95)})
    ));
    out["profitChance"] = json!((!profits.is_empty()).then(|| wins as f64 / trials as f64));
    out["goldPerHour"] = json!((timed == trials).then(|| rate / trials as f64));
    out["profitPercent"] = json!((!profits.is_empty()).then(|| 100. * wins as f64 / trials as f64));
    out["kelly"] = if returns.is_empty() {
        V::Null
    } else {
        size(&a[0], &returns)
    };
    Ok(out)
}
