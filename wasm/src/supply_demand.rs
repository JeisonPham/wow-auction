//! Current sell-side depth and historical removals from the same unit ask.
use super::{json, rows, uint, V};
use std::collections::BTreeMap;

// Positive IEEE-754 values sort in numeric order by their bits. This gives the
// graph the same unit prices as the dashboard, including fractional copper.
type PriceBook = BTreeMap<u64, u64>;

fn ask(total: u64, stack: u64) -> u64 {
    (total as f64 / stack as f64).to_bits()
}

fn archived_book(levels: &V) -> PriceBook {
    let mut book = PriceBook::new();
    let mut previous = 0;
    for level in rows(levels) {
        let cumulative = uint(&level[0]);
        *book
            .entry(ask(uint(&level[1]), uint(&level[2])))
            .or_default() += cumulative - previous;
        previous = cumulative;
    }
    book
}

pub(super) type Coverage = BTreeMap<u64, (u64, u64)>;
pub(super) fn coverage(data: &V) -> Coverage {
    rows(data)
        .iter()
        .map(|r| (uint(&r[0]), (uint(&r[1]), uint(&r[2]))))
        .collect()
}

pub(super) fn profile(snapshot: &V, data: &V, ladders: &V, covered: &Coverage) -> V {
    let mut supply = PriceBook::new();
    let mut listed = 0;
    for lot in rows(&snapshot["lots"]) {
        let (size, total, n) = (uint(&lot[0]), uint(&lot[1]), uint(&lot[2]));
        *supply.entry(ask(total, size)).or_default() += size * n;
        listed += size * n;
    }
    let supply_known = snapshot["available"].as_u64() == Some(listed);
    let books: Vec<_> = rows(ladders).iter().map(archived_book).collect();
    let observations: BTreeMap<_, _> = rows(data).iter().map(|row| (uint(&row[0]), row)).collect();
    let empty = PriceBook::new();
    let observation = |hour: u64| {
        if let Some(&r) = observations.get(&hour) {
            let book = if r[2].as_u64()? == 0 {
                &empty
            } else {
                books.get(r[4].as_u64()? as usize)?
            };
            Some((r[5].as_u64()?, r[6].as_u64()?, book))
        } else {
            covered.get(&hour).map(|&(at, source)| (at, source, &empty))
        }
    };
    let mut removed: BTreeMap<u64, u128> = BTreeMap::new();
    let mut seconds = 0;
    let mut pairs = 0;
    for &hour in observations.keys() {
        let Some((before_at, source, before)) = observation(hour) else {
            continue;
        };
        if before.is_empty() {
            continue;
        }
        let Some((after_at, next_source, after)) = observation(hour + 3600) else {
            continue;
        };
        let elapsed = after_at.saturating_sub(before_at);
        if source != next_source || !(1800..=5400).contains(&elapsed) {
            continue;
        }
        pairs += 1;
        seconds += elapsed;
        for (&price, &units) in before {
            let drop = units.saturating_sub(*after.get(&price).unwrap_or(&0));
            *removed.entry(price).or_default() += u128::from(drop);
        }
    }
    // A blank stock-only or price-only item can share the dashboard's default empty state.
    if supply.is_empty() && pairs == 0 {
        return V::Null;
    }
    let mut levels: BTreeMap<_, _> = removed
        .into_iter()
        .map(|(price, n)| (price, (0, n)))
        .collect();
    if supply_known {
        for (price, units) in supply {
            levels.entry(price).or_default().0 = units;
        }
    }
    let mut remaining: u128 = levels.values().map(|v| v.1).sum();
    let mut cumulative = 0;
    let mut points = Vec::with_capacity(levels.len());
    for (price, (units, drop)) in levels {
        cumulative += units;
        let hourly = (seconds > 0).then(|| remaining as f64 * 3600. / seconds as f64);
        points.push(json!([
            f64::from_bits(price),
            supply_known.then_some(cumulative),
            hourly
        ]));
        remaining -= drop;
    }
    json!({"points":points, "pairs":pairs, "seconds":seconds})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supply_and_removals_include_the_selected_price() {
        let book = json!({"available":10,"lots":[[2,7,2],[1,8,6]]});
        let ladders = json!([[[6, 7, 2], [10, 8, 1]], [[2, 7, 2], [9, 8, 1]]]);
        let data = json!([[3600, 9, 10, 3, 0, 3620, 4], [7200, 8, 9, 3, 1, 7220, 4]]);
        let empty = coverage(&json!([[10800, 10820, 4]]));
        let p = profile(&book, &data, &ladders, &empty);
        assert_eq!(p["points"], json!([[3.5, 4, 6.5], [8., 10, 3.5]]));
        assert_eq!(p["pairs"], 2);
        assert_eq!(p["seconds"], 7200);
    }

    #[test]
    fn gaps_different_sources_and_unknown_depth_are_excluded() {
        let ladders = json!([[[4, 7, 2]]]);
        let data = json!([
            [0, 8, 4, 2, 0, 60, 4],
            [3600, 8, 4, 2, 0, 3660, 3],
            [7200, 8, 4, 2, null, 7260, 3],
            [14400, 8, 4, 2, 0, 14410, 3],
            [18000, 8, 4, 2, 0, 21400, 3]
        ]);
        let book = json!({"available":4,"lots":[[2,7,2]]});
        let p = profile(&book, &data, &ladders, &Coverage::new());
        assert_eq!(p["points"], json!([[3.5, 4, null]]));
        assert_eq!(p["pairs"], 0);
        let data = json!([[3600, 7, 4, 2, 0, 3900, 4], [7200, 7, 4, 2, 0, 7200, 4]]);
        let p = profile(&V::Null, &data, &ladders, &Coverage::new());
        assert_eq!(p["points"], json!([[3.5, null, 0.]]));
        assert_eq!(p["seconds"], 3300);
    }
}
