use crate::{Result, V};
use std::collections::VecDeque;

pub type Lot = [u64; 3];
pub fn lots(v: &V) -> Result<Vec<Lot>> {
    if v.is_null() {
        return Ok(vec![]);
    }
    let result: Vec<Lot> = serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
    if result.iter().any(|r| r[0] == 0 || r[1] == 0) {
        return Err("Invalid auction listing".into());
    }
    Ok(result)
}
pub fn sort(lots: &mut [Lot]) {
    lots.sort_unstable_by(|a, b| {
        (u128::from(a[1]) * u128::from(b[0]))
            .cmp(&(u128::from(b[1]) * u128::from(a[0])))
            .then(a[0].cmp(&b[0]))
    });
}
fn greedy(
    lots: &[Lot],
    need: u64,
    price: f64,
    stock: f64,
    vendor: Option<f64>,
) -> Option<(f64, u64)> {
    let (mut spent, mut units) = (0., 0);
    let mut best = vendor.map(|v| (v * need as f64, need));
    for &[size, ask, listed] in lots {
        let ask = ask as f64 * price;
        if vendor.is_some_and(|v| ask >= v * size as f64) {
            break;
        }
        let count = (listed as f64 * stock).round() as u64;
        let remaining = need - units;
        let fill = remaining.div_ceil(size);
        if fill <= count {
            let cost = spent + fill as f64 * ask;
            if best.is_none_or(|b| cost < b.0) {
                best = Some((cost, units + fill * size))
            }
        }
        let take = count.min(remaining / size);
        spent += take as f64 * ask;
        units += take * size;
        if let Some(v) = vendor {
            let cost = spent + (need - units) as f64 * v;
            if best.is_none_or(|b| cost < b.0) {
                best = Some((cost, need))
            }
        }
        if units == need {
            break;
        }
    }
    best
}
// At index n, store the lowest buyout for n units. The last index also accepts oversized stacks.
fn combinations(lots: &[Lot], counts: &[u64], need: usize) -> Vec<(f64, u64)> {
    let mut costs = vec![(f64::INFINITY, 0); need + 1];
    costs[0] = (0., 0);
    for (&[size, ask, _], &count) in lots.iter().zip(counts) {
        let (mut left, mut group) = (count, 1);
        while left > 0 {
            let take = left.min(group);
            left -= take;
            group *= 2;
            for n in (0..need).rev() {
                let (old, units) = costs[n];
                if !old.is_finite() {
                    continue;
                }
                let new = (old + take as f64 * ask as f64, units + take * size);
                let index = new.1.min(need as u64) as usize;
                if new < costs[index] {
                    costs[index] = new
                }
            }
        }
    }
    costs
}
type CachedCurve = (u64, Vec<u64>, Vec<(f64, u64)>);
pub struct Pricer {
    pub lots: Vec<Lot>,
    mixed: bool,
    cache: VecDeque<CachedCurve>,
}
impl Pricer {
    pub fn new(mut lots: Vec<Lot>) -> Self {
        sort(&mut lots);
        let mixed = lots.iter().any(|r| r[0] != lots[0][0]);
        Self {
            lots,
            mixed,
            cache: VecDeque::new(),
        }
    }
    pub fn buy(
        &mut self,
        need: u64,
        price: f64,
        stock: f64,
        vendor: Option<f64>,
        limit: u64,
    ) -> Option<(f64, u64)> {
        let mut best = greedy(&self.lots, need, price, stock, vendor)?;
        if !self.mixed || need > limit || (limit == 10000 && self.lots.len() as u64 * need > limit)
        {
            return Some(best);
        }
        let counts: Vec<_> = self
            .lots
            .iter()
            .map(|&[size, _, listed]| {
                need.div_ceil(size)
                    .min((listed as f64 * stock).round() as u64)
            })
            .collect();
        let work: u64 = counts
            .iter()
            .map(|&n| u64::from(u64::BITS - n.leading_zeros()))
            .sum();
        if work.saturating_mul(need) > limit {
            return Some(best);
        }
        let pos = self
            .cache
            .iter()
            .position(|(n, c, _)| *n == need && *c == counts);
        let curve = if let Some(i) = pos {
            &self.cache[i].2
        } else {
            if self.cache.len() == 32 {
                self.cache.pop_front();
            }
            let values = combinations(&self.lots, &counts, need as usize);
            self.cache.push_back((need, counts, values));
            &self.cache.back().unwrap().2
        };
        let (cost, units) = curve[need as usize];
        if (cost * price, units) < best {
            best = (cost * price, units)
        }
        if let Some(v) = vendor {
            for (n, (cost, _)) in curve.iter().enumerate().take(need as usize) {
                let total = cost * price + (need - n as u64) as f64 * v;
                if total < best.0 {
                    best = (total, need)
                }
            }
        }
        Some(best)
    }
}
pub fn quote(
    lots: &[Lot],
    need: u64,
    price: f64,
    stock: f64,
    vendor: Option<f64>,
    limit: u64,
) -> Option<(f64, u64)> {
    Pricer::new(lots.to_vec()).buy(need, price, stock, vendor, limit)
}
