//! Quantity-weighted nearest-rank purchase estimates. A tier ends at its cumulative unit count.
use super::blizzard;
use crate::{
    fresh,
    scan::{MarketChecks, MAX},
};
use serde::Serialize;
use serde_json::{json, Value};
use std::cmp::Ordering;

#[derive(Serialize)]
pub(super) struct Depth {
    source: &'static str,
    observed_at: u64,
    available: u64,
    /// [cumulative quantity, stack buyout, stack size]. Keep fractional copper exact.
    levels: Vec<[u64; 3]>,
}

fn compare_price(a: &[u64; 3], b: &[u64; 3]) -> Ordering {
    (u128::from(a[1]) * u128::from(b[0])).cmp(&(u128::from(b[1]) * u128::from(a[0])))
}

pub(super) fn levels(lots: &[[u64; 3]]) -> Vec<[u64; 3]> {
    let mut sorted = lots.to_vec();
    sorted.sort_unstable_by(compare_price);
    let mut levels = Vec::new();
    let mut available = 0;
    let mut rows = sorted.iter().peekable();
    while let Some(row) = rows.next() {
        available += row[0] * row[2]; // Both snapshot readers validate the aggregate quantity.
        if rows
            .peek()
            .is_none_or(|next| compare_price(row, next) != Ordering::Equal)
        {
            levels.push([available, row[1], row[0]]);
        }
    }
    levels
}

#[derive(Serialize)]
pub(super) struct ListingSnapshot<'a> {
    source: &'static str,
    observed_at: u64,
    available: u64,
    lots: &'a [[u64; 3]],
}

impl<'a> ListingSnapshot<'a> {
    pub fn for_item(
        id: u32,
        checks: &MarketChecks<'a>,
        blizzard: &'a blizzard::Book,
        now: u64,
        age: u64,
    ) -> Option<Self> {
        let local = checks.get(id);
        let api = blizzard.listings(id).filter(|(at, _)| fresh(*at, now, age));
        let (source, observed_at, lots, available) = match (local, api) {
            (Some((at, p, source)), api) if api.is_none_or(|(t, _)| at >= t) => (
                source,
                at,
                p.map_or(&[][..], |p| p.lots.as_slice()),
                p.map_or(0, |p| p.units),
            ),
            (_, Some((at, lots))) => (
                "Blizzard Auction House",
                at,
                lots,
                lots.iter().map(|&[size, _, count]| size * count).sum(),
            ),
            _ => return None,
        };
        Some(Self {
            source,
            observed_at,
            lots,
            available,
        })
    }
}

impl Depth {
    pub fn for_item(
        id: u32,
        checks: &MarketChecks,
        blizzard: &blizzard::Book,
        now: u64,
        age: u64,
    ) -> Option<Self> {
        let snapshot = ListingSnapshot::for_item(id, checks, blizzard, now, age)?;
        Some(Self {
            source: snapshot.source,
            observed_at: snapshot.observed_at,
            available: snapshot.available,
            levels: levels(snapshot.lots),
        })
    }

    pub fn lowest(&self) -> Option<(u64, u64)> {
        self.levels.first().map(|&[_, total, size]| (total, size))
    }

    fn quote(&self, quantity: u64, floor: u64) -> Value {
        let rank =
            quantity.max((u128::from(self.available) * u128::from(floor)).div_ceil(100) as u64);
        let mut result = json!({"source":self.source,"observed_at":self.observed_at,"available":self.available,
            "rank":rank,"percentile":null,"unit_price":null,"budget":null});
        result["status"] = if quantity > self.available {
            "insufficient"
        } else if let Some(&[_, total, units]) = self
            .levels
            .get(self.levels.partition_point(|tier| tier[0] < rank))
        {
            result["percentile"] = json!(100.0 * rank as f64 / self.available as f64);
            result["unit_price"] = json!(total as f64 / units as f64);
            let cost = (u128::from(total) * u128::from(quantity)).div_ceil(u128::from(units));
            if cost <= u128::from(MAX) {
                result["budget"] = json!(cost as u64);
                "priced"
            } else {
                "budget_overflow"
            }
        } else {
            "no_price_levels"
        }
        .into();
        result
    }
}

pub(super) struct Request {
    pub item: u32,
    quantity: u64,
    floor: u64,
}
impl Request {
    pub fn parse(query: &str) -> Option<Self> {
        let (mut item, mut quantity, mut floor) = (None, None, None);
        for arg in query.split('&') {
            let (key, value) = arg.split_once('=')?;
            match key {
                "item" if item.is_none() => item = Some(value.parse::<u32>().ok()?),
                "quantity" if quantity.is_none() => quantity = Some(value.parse::<u64>().ok()?),
                "floor" if floor.is_none() => floor = Some(value.parse::<u64>().ok()?),
                _ => return None,
            }
        }
        let q = Self {
            item: item?,
            quantity: quantity?,
            floor: floor.unwrap_or(0),
        };
        (q.item > 0 && (1..=MAX).contains(&q.quantity) && q.floor <= 100).then_some(q)
    }
    pub fn result(&self, depth: Option<&Depth>) -> Value {
        let mut quote = depth.map_or_else(
            || json!({"status":"no_depth","available":null,"unit_price":null,"budget":null,"rank":null,"percentile":null,"source":null,"observed_at":null}),
            |d| d.quote(self.quantity, self.floor));
        quote["item"] = self.item.into();
        quote["quantity"] = self.quantity.into();
        quote["floor"] = self.floor.into();
        quote
    }
}
