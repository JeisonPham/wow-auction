//! Shared numeric model for published dashboard views and custom browser quantities.
use super::*;
use std::collections::{BTreeMap, HashMap};

// Archive rows: UTC timestamp, unit price, available units, auction count, cumulative price levels.
// Complete market scans share their empty hours instead of repeating them for every catalog item.
pub fn series(data: &V, coverage: &V, need: u64, floor: Option<u64>, books: &V) -> V {
    let mut result: BTreeMap<_, _> = rows(coverage)
        .iter()
        .map(|t| (uint(t), json!([t, null, null])))
        .collect();
    for r in rows(data) {
        let unit = r[1].as_f64();
        let mut budget = unit.map(|p| (p * need as f64).ceil()).filter(|v| safe(*v));
        if let Some(f) = floor {
            let ladder = r[4].as_u64().map_or(&r[4], |index| &books[index as usize]);
            if r[2].as_u64().is_some_and(|stock| stock < need) {
                budget = None;
            } else if !rows(ladder).is_empty() {
                let available = uint(&r[2]);
                let rank = need.max((u128::from(available) * u128::from(f)).div_ceil(100) as u64);
                let levels = rows(ladder);
                budget = levels
                    .get(levels.partition_point(|l| uint(&l[0]) < rank))
                    .and_then(|l| {
                        let copper = (u128::from(need) * u128::from(uint(&l[1])))
                            .div_ceil(u128::from(uint(&l[2])));
                        (copper <= MAX as u128).then_some(copper as f64)
                    });
            }
        }
        result.insert(uint(&r[0]), json!([r[0], unit, budget]));
    }
    V::Array(result.into_values().collect())
}

fn week_slot(t: u64) -> usize {
    (((t / 86400 + 3) % 7) * 24 + (t / 3600) % 24) as usize
}

fn calendar(data: &V, coverage: &V) -> V {
    let mut bins: BTreeMap<usize, [Vec<f64>; 3]> = BTreeMap::new();
    let explicit: std::collections::HashSet<_> = rows(data).iter().map(|r| uint(&r[0])).collect();
    for t in rows(coverage)
        .iter()
        .map(uint)
        .filter(|t| !explicit.contains(t))
    {
        let bin = bins.entry(week_slot(t)).or_default();
        bin[1].push(0.);
        bin[2].push(0.);
    }
    for r in rows(data) {
        let b = bins.entry(week_slot(uint(&r[0]))).or_default();
        for (i, group) in b.iter_mut().enumerate() {
            if let Some(v) = r[i + 1].as_f64() {
                group.push(v);
            }
        }
    }
    V::Object(
        bins.into_iter()
            .map(|(slot, mut groups)| {
                let stats = groups.each_mut().map(|s| {
                    let count = s.len();
                    let value = (count > 0).then(|| history::median(s));
                    (value, count)
                });
                (
                    slot.to_string(),
                    json!([stats[0].0, stats[1].0, stats[2].0, stats[0].1, stats[1].1, stats[2].1]),
                )
            })
            .collect(),
    )
}

fn listing_detail(snapshot: &V) -> V {
    let mut lots = stacks::lots(&snapshot["lots"]).unwrap_or_default();
    stacks::sort(&mut lots);
    let mut units = 0;
    let listings = snapshot["count"].as_u64();
    let whole_stacks = listings == Some(lots.iter().map(|r| r[2]).sum());
    let single_tier = lots.len() == 1;
    let mut value = 0.;
    let tiers: Vec<_> = lots
        .into_iter()
        .map(|[size, buyout, n]| {
            let qty = size * n;
            units += qty;
            let count = if whole_stacks {
                Some(n)
            } else if single_tier {
                listings
            } else {
                None
            };
            value += buyout as f64 * n as f64;
            json!([size, buyout, count, buyout as f64 / size as f64, qty, units])
        })
        .collect();
    json!({"tiers":tiers, "count":listings,"mean":ratio(value,units as f64), "lowest":tiers.first().map(|r| &r[3])})
}

fn forecast(id: u64, estimate: &V, r: &V) -> V {
    let qty = &r["quantity"];
    let default_qty = |key: &str| if r[key].is_null() { qty } else { &r[key] };
    let unit = r["net_unit_value"]
        .as_f64()
        .or_else(|| ratio(r["proceeds"].as_f64()?, num(qty)));
    let sale = r["kind"] == "craft_auction";
    let outputs = if sale {
        json!([{"id":id,"quantity":qty,"unit_cost":estimate}])
    } else {
        json!(rows(&r["outputs"]))
    };
    let model = json!({"batch":1,"lines":r["inputs"],"proceeds":r["proceeds"],"yield":{
        "min":default_qty("quantity_min"),"max":default_qty("quantity_max"),"base":qty,"netPerUnit":unit,"timing":r["timing"],
        "marketSale":sale || r["kind"] == "craft_disenchant" || r["kind"] == "disenchant","saleItems":outputs}});
    simulation::simulate(&json!([model,512,10,id]),true).unwrap_or_else(|_| json!({"cost":null,"profit":null,"proceeds":null,"winPercent":null,"repeatGoldPerHour":null}))
}

pub fn dashboard(report: &mut V, mut archive: V) {
    let covered = archive["coverage"].take();
    let covered_depth = supply_demand::coverage(&archive["coverage_depth"]);
    let mut data = archive["items"].take();
    let mut books = archive["level_books"].take();
    let blank_calendar = calendar(&V::Null, &covered);
    let day = num(&report["prepared_at"]) * 1000.;
    let mut quotes = HashMap::new();
    let items = report["items"].as_array_mut().unwrap();
    let vendors: HashMap<_, _> = items
        .iter()
        .map(|i| {
            (
                uint(&i["id"]),
                json!({"vendor_buy":i["vendor_buy"],"auctionable":i["auctionable"]}),
            )
        })
        .collect();
    for item in items.iter_mut() {
        let id = uint(&item["id"]);
        let raw = &data[id.to_string()];
        let activity = supply_demand::profile(
            &item["listing_snapshot"],
            raw,
            &books[id.to_string()],
            &covered_depth,
        );
        if !activity.is_null() {
            item["supply_demand"] = activity;
        }
        let prices = history::samples(raw);
        if !rows(raw).is_empty() {
            let mut week = calendar(raw, &covered);
            week.as_object_mut()
                .unwrap()
                .retain(|k, v| blank_calendar[k] != *v);
            item["calendar"] = week;
        }
        if !prices.is_empty() {
            item["charts"] = json!({"low":history::best(&prices,false),"high":history::best(&prices,true),
                "daily":history::daily(&json!([raw,day]))});
        }
        if !item["listing_snapshot"].is_null() {
            item["listing_detail"] = listing_detail(&item["listing_snapshot"]);
        }
        let estimate = item["estimate"].clone();
        for r in item["routes"].as_array_mut().into_iter().flatten() {
            r["screening"] = forecast(id, &estimate, r);
            let mut history = serde_json::Map::new();
            let mut book = serde_json::Map::new();
            let mut add = |item_id: u64, need: u64| {
                let key = item_id.to_string();
                history.insert(
                    key.clone(),
                    quotes
                        .entry((item_id, need))
                        .or_insert_with(|| {
                            let raw = &data[&key];
                            let empty = !rows(raw).iter().any(|r| !r[1].is_null());
                            if empty {
                                return json!([]);
                            }
                            series(
                                raw,
                                if vendors
                                    .get(&item_id)
                                    .is_some_and(|v| !v["vendor_buy"].is_null())
                                {
                                    &covered
                                } else {
                                    &V::Null
                                },
                                need,
                                None,
                                &V::Null,
                            )
                        })
                        .clone(),
                );
                if let Some(v) = vendors.get(&item_id) {
                    book.insert(key, v.clone());
                }
            };
            add(id, 1);
            for l in rows(&r["outputs"]) {
                add(uint(&l["id"]), 1);
            }
            for l in rows(&r["inputs"]) {
                add(uint(&l["id"]), uint(&l["quantity"]));
            }
            let meta = json!({"kind":r["kind"],"inputs":r["inputs"],"outputs":r["outputs"],"quantity":r["quantity"],"proceeds":r["proceeds"]});
            r["hourly_profile"] =
                history::profile(&json!([{"id":id},meta,1,{"items":history},book,0]));
        }
    }
    for item in items {
        let key = uint(&item["id"]).to_string();
        if let Some(mut raw) = data.as_object_mut().and_then(|map| map.remove(&key)) {
            if !rows(&raw).is_empty() {
                // Exact scan times and sources are only needed to compare books on the server.
                for row in raw.as_array_mut().into_iter().flatten() {
                    row.as_array_mut().unwrap().truncate(5);
                }
                item["hours"] = raw;
            }
        }
        if let Some(ladders) = books.as_object_mut().and_then(|map| map.remove(&key)) {
            item["level_books"] = ladders;
        }
    }
    report["empty_calendar"] = blank_calendar;
    report["covered_hours"] = covered;
}
