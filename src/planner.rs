mod chains;
mod timing;
use crate::{feed::Feed, fresh, scan::*};
use serde_json::{json, Value};
use std::collections::{BTreeMap as Map, BTreeSet as Set};

#[derive(Default)]
struct Quote<'a> {
    name: String,
    item: Option<&'a Item>,
    estimate: Option<u64>,
    count: Option<u64>,
    check: Option<&'a Price>,
    at: Option<u64>,
}
impl Quote<'_> {
    fn bound(&self) -> bool {
        self.item
            .is_some_and(|i| matches!(i.binding.as_str(), "Binds when picked up" | "Quest item"))
    }
    fn units(&self) -> Option<u64> {
        self.at.map(|_| self.check.map_or(0, |p| p.units))
    }
    fn price(&self, pre: bool) -> Option<(u64, u64)> {
        if !pre && self.at.is_some() {
            self.check.map(|p| (p.total_buyout, p.units))
        } else {
            self.estimate.map(|p| (p, 1))
        }
    }
    fn transferable(&self) -> bool {
        self.item.is_some_and(|i| {
            matches!(
                i.binding.as_str(),
                "Unbound" | "Binds when equipped" | "Binds when used"
            )
        })
    }
    fn purchase(&self, q: u32, craft: bool, pre: bool) -> (Option<u64>, &'static str, Option<f64>) {
        let price = if self.bound() { None } else { self.price(pre) };
        let cost = price
            .map(|(p, n)| (p as u128 * q as u128).div_ceil(n as u128))
            .and_then(|n| u64::try_from(n).ok());
        let stock = if pre { None } else { self.units() };
        let short = stock.is_some_and(|n| n < u64::from(q));
        let vendor = self.item.and_then(|i| i.vendor_buy).filter(|p| {
            craft
                && (short
                    || cost.is_none()
                    || price.is_some_and(|(total, units)| {
                        (*p as u128 * units as u128) <= total as u128
                    }))
        });
        if let Some(p) = vendor {
            (p.checked_mul(q.into()), "vendor", Some(p as f64))
        } else {
            (
                cost,
                if self.bound() {
                    "bound"
                } else if !pre && self.at.is_some() {
                    "checked"
                } else {
                    "estimate"
                },
                price.map(|(p, n)| p as f64 / n as f64),
            )
        }
    }
    fn line(&self, id: u32, q: u32, craft: bool, pre: bool) -> Value {
        let (cost, source, unit) = self.purchase(q, craft, pre);
        let stock = if pre { None } else { self.units() };
        json!({"id":id,"name":self.name,"quantity":q,"source":source,"cost":cost,"unit_cost":unit,"listed_units":stock,"max_stack":self.item.and_then(|i|i.max_stack)})
    }
}
fn total(lines: &[Value]) -> Option<u64> {
    lines
        .iter()
        .try_fold(0u64, |v, l| v.checked_add(l["cost"].as_u64()?))
}
fn profit(out: Option<u64>, cost: Option<u64>) -> Option<i64> {
    (out? as i128 - cost? as i128).try_into().ok()
}
fn finish(mut r: Value, lines: Vec<Value>, out: Option<u64>, outputs_checked: bool) -> Value {
    let cost = total(&lines);
    let short = lines.iter().any(|l| {
        l["source"] != "vendor"
            && l["listed_units"]
                .as_u64()
                .is_some_and(|n| n < l["quantity"].as_u64().unwrap_or(1))
    });
    let verified = !short
        && cost.is_some()
        && out.is_some()
        && outputs_checked
        && lines.iter().all(|l| l["source"] != "estimate");
    r["inputs"] = lines.into();
    r["cost"] = cost.into();
    r["proceeds"] = out.into();
    r["profit"] = profit(out, cost).into();
    r["stock"] = json!(if short {
        "insufficient"
    } else if verified {
        "verified"
    } else {
        "estimated"
    });
    r
}
type Candidate = (i64, u32, Set<u32>);
fn candidate(list: &mut Vec<Candidate>, id: u32, lines: &[Value], out: Option<u64>, extra: &[u32]) {
    if let Some(p) = profit(out, total(lines)).filter(|n| *n > 0) {
        let ids: Set<_> = lines
            .iter()
            .filter(|l| l["source"] != "vendor")
            .filter_map(|l| l["id"].as_u64().map(|n| n as u32))
            .chain(extra.iter().copied())
            .collect();
        if !ids.is_empty() {
            list.push((p, id, ids))
        }
    }
}
pub fn report(
    region: &str,
    market: &str,
    b: Option<&Bundle>,
    feed: &Feed,
    age: u64,
    now: u64,
) -> Value {
    let empty = Snapshot::default();
    let raw = b.map_or(&empty, |b| &b.snapshot);
    plan(region, market, b, feed, age, now, raw, false)
}
pub fn market_report(
    region: &str,
    market: &str,
    b: Option<&Bundle>,
    feed: &Feed,
    age: u64,
    now: u64,
) -> Value {
    let empty = Snapshot::default();
    let player = b.map_or(&empty, |b| &b.snapshot);
    let cat = &crate::catalog::FOREVER;
    let merged = cat.for_player(player);
    let bundled_de = player.disenchant.is_empty() || player.non_disenchantable.is_none();
    let mut r = plan(region, market, b, feed, age, now, &merged, bundled_de);
    r["catalog"] = json!({"build":cat.build,"recipes":merged.recipes.len(),"items":merged.items.len(),
        "characters":merged.professions.len(),"desktop_at":player.estimate_at,
        "disenchant_source":if bundled_de {"Forever level brackets / Classic drop estimates"} else {"Installed TSM tables"}});
    r
}
#[allow(clippy::too_many_arguments)]
fn plan(
    region: &str,
    market: &str,
    b: Option<&Bundle>,
    feed: &Feed,
    age: u64,
    now: u64,
    s: &Snapshot,
    bundled_de: bool,
) -> Value {
    let empty = Snapshot::default();
    let obs = b.map_or(&empty, |b| &b.snapshot);
    let desktop = obs.estimate_at > 0
        && !obs.estimate_prices.is_empty()
        && (fresh(obs.estimate_at, now, age) || obs.estimate_at >= feed.at);
    let est_at = if desktop { obs.estimate_at } else { feed.at };
    let active = fresh(est_at, now, age);
    let mut ids: Set<_> = s
        .items
        .keys()
        .chain(obs.prices.keys())
        .chain(obs.estimate_prices.keys())
        .chain(feed.items.keys())
        .copied()
        .collect();
    let full = fresh(obs.newest_price_at, now, age);
    let mut target = Map::new();
    if let Some(b) = b {
        for c in &b.targeted {
            ids.extend(c.listed_units.keys());
            if fresh(c.captured_at, now, age) && (!full || c.captured_at >= obs.newest_price_at) {
                for id in c.listed_units.keys() {
                    target.entry(*id).or_insert(c);
                }
            }
        }
    }
    if bundled_de {
        for drops in crate::catalog::FOREVER.overrides.values() {
            ids.extend(drops.keys())
        }
    }
    for r in &s.recipes {
        ids.insert(r.output);
        ids.extend(r.mats.iter().map(|m| m.0))
    }
    for band in &s.disenchant {
        ids.extend(band.mats.keys())
    }
    let mut quotes = Map::new();
    for id in ids {
        let item = s.items.get(&id);
        let public = feed.items.get(&id);
        let (p, count) = if desktop {
            let p = obs.estimate_prices.get(&id);
            (p.map(|p| p.total_buyout), p.map(|p| p.auctions))
        } else {
            (public.map(|v| v.1), None)
        };
        let (at, check) = if let Some(c) = target.get(&id) {
            (Some(c.captured_at), c.prices.get(&id))
        } else if full {
            (Some(obs.newest_price_at), obs.prices.get(&id))
        } else {
            (None, None)
        };
        let name = item
            .map(|i| &i.name)
            .filter(|n| !n.is_empty())
            .or_else(|| public.map(|p| &p.0))
            .cloned()
            .unwrap_or_else(|| format!("Item {id}"));
        quotes.insert(
            id,
            Quote {
                name,
                item,
                estimate: p.filter(|_| active),
                count,
                check,
                at,
            },
        );
    }
    let mut routes: Map<u32, Vec<Value>> = Map::new();
    let mut candidates = vec![];
    for (&id, q) in &quotes {
        if q.bound() {
            continue;
        }
        if let Some(out) = q.item.and_then(|i| i.vendor_sell).filter(|p| *p > 0) {
            let pre = q.line(id, 1, false, true);
            candidate(
                &mut candidates,
                id,
                std::slice::from_ref(&pre),
                Some(out),
                &[],
            );
            let r = finish(
                json!({"kind":"vendor","name":"Sell to vendor","quantity":1}),
                vec![q.line(id, 1, false, false)],
                Some(out),
                true,
            );
            if r["profit"].as_i64().unwrap_or(0) > 0
                || profit(Some(out), pre["cost"].as_u64()).unwrap_or(0) > 0
            {
                routes.entry(id).or_default().push(r)
            }
        }
        if let Some(item) = q.item {
            let Some((d, skill)) = crate::disenchant::rule(id, item, s) else {
                continue;
            };
            let band = crate::catalog::item_band(d, id, bundled_de);
            let d = &band;
            let chars: Vec<_> = s
                .professions
                .iter()
                .filter(|(_, p)| p.get("Enchanting").is_some_and(|n| *n >= skill))
                .map(|(c, _)| c)
                .collect();
            let (ready, advice) = crate::professions::disenchanter(s, skill);
            let outputs = |pre| crate::disenchant::proceeds(d, |id| quotes[&id].price(pre));
            let extra: Vec<_> = d.mats.keys().copied().collect();
            candidate(
                &mut candidates,
                id,
                &[q.line(id, 1, false, true)],
                outputs(true),
                &extra,
            );
            let drops:Vec<_>=d.mats.iter().map(|(id,n)|{let o=&quotes[id];json!({"id":id,"name":o.name,"quantity":n,"unit_cost":o.price(false).map(|(p,u)|p as f64/u as f64),"source":if o.check.is_some(){"checked"}else{"estimate"}})}).collect();
            let r = finish(
                json!({"kind":"disenchant","quantity":1,"name":"Disenchant","ready":ready,"advice":advice,"profession":"Enchanting","requirements":{"skill":skill},"characters":chars,"outputs":drops}),
                vec![q.line(id, 1, false, false)],
                outputs(false),
                extra.iter().all(|id| quotes[id].check.is_some()),
            );
            if r["profit"].as_i64().unwrap_or(0) > 0 && r["stock"] != "insufficient" {
                routes.entry(id).or_default().push(r)
            }
        }
    }
    let sourcing = chains::Search::new(s, &quotes, market, bundled_de);
    for (index, recipe) in s.recipes.iter().enumerate() {
        let req = s
            .recipe_requirements
            .get(&recipe.id)
            .unwrap_or(&Value::Null);
        if req["faction"]
            .as_str()
            .is_some_and(|f| market.rsplit_once('-').is_some_and(|(_, side)| side != f))
        {
            continue;
        }
        let item = quotes[&recipe.output].item;
        let transferable = quotes[&recipe.output].transferable();
        let first_route = routes.get(&recipe.output).map_or(0, Vec::len);
        let lines = |pre| {
            recipe
                .mats
                .iter()
                .map(|(id, q)| quotes[id].line(*id, *q, true, pre))
                .collect::<Vec<_>>()
        };
        let current = lines(false);
        let preliminary = lines(true);
        let (ready, advice) = crate::professions::access(s, recipe, req, None, transferable);
        let base = json!({"kind":"craft","name":recipe.name,"recipe_id":recipe.id,"quantity":recipe.quantity,"quantity_min":recipe.quantity_min.unwrap_or(recipe.quantity),"quantity_max":recipe.quantity_max.unwrap_or(recipe.quantity),"net_unit_value":item.and_then(|i|i.vendor_sell),"characters":recipe.characters,
            "profession":req["profession"],"requirements":req,"ready":ready,"advice":advice});
        let out = item
            .and_then(|i| i.vendor_sell)
            .and_then(|p| p.checked_mul(recipe.quantity.into()));
        candidate(&mut candidates, recipe.output, &preliminary, out, &[]);
        routes.entry(recipe.output).or_default().push(finish(
            base.clone(),
            current.clone(),
            out,
            true,
        ));

        if transferable {
            // One AH cut and the same sale reserve used for auctioned DE materials.
            let sell = |pre| -> Option<u64> {
                let (p, u) = quotes[&recipe.output].price(pre)?;
                (p as u128 * recipe.quantity as u128 * 323 / (u as u128 * 400))
                    .try_into()
                    .ok()
            };
            candidate(
                &mut candidates,
                recipe.output,
                &preliminary,
                sell(true),
                &[recipe.output],
            );
            if let Some(net) = sell(false) {
                let mut meta = base.clone();
                meta["kind"] = "craft_auction".into();
                meta["net_unit_value"] = quotes[&recipe.output]
                    .price(false)
                    .map(|(p, u)| p as f64 / u as f64 * 323.0 / 400.0)
                    .into();
                routes.entry(recipe.output).or_default().push(finish(
                    meta,
                    current.clone(),
                    Some(net),
                    quotes[&recipe.output].check.is_some(),
                ));
            }
        }
        if let Some((band, skill)) = item.and_then(|i| crate::disenchant::rule(recipe.output, i, s))
        {
            let band = crate::catalog::item_band(band, recipe.output, bundled_de);
            let sell = |pre| {
                crate::disenchant::proceeds_for(&band, recipe.quantity, |id| quotes[&id].price(pre))
            };
            let extra: Vec<_> = band.mats.keys().copied().collect();
            candidate(
                &mut candidates,
                recipe.output,
                &preliminary,
                sell(true),
                &extra,
            );
            let drops:Vec<_>=band.mats.iter().map(|(id,n)|{let q=&quotes[id];json!({"id":id,"name":q.name,"quantity":n*f64::from(recipe.quantity),"unit_cost":q.price(false).map(|(p,u)|p as f64/u as f64),"source":if q.check.is_some(){"checked"}else{"estimate"}})}).collect();
            let (ready, advice) =
                crate::professions::access(s, recipe, req, Some(skill), transferable);
            let mut meta = base;
            meta["kind"] = "craft_disenchant".into();
            meta["net_unit_value"] =
                crate::disenchant::net_per_piece(&band, |id| quotes[&id].price(false))
                    .and_then(|n| num_traits::ToPrimitive::to_f64(&n))
                    .into();
            meta["ready"] = ready.into();
            meta["advice"] = advice.into();
            meta["enchanting_rank"] = skill.into();
            meta["outputs"] = drops.into();
            routes.entry(recipe.output).or_default().push(finish(
                meta,
                current,
                sell(false),
                extra.iter().all(|id| quotes[id].check.is_some()),
            ));
        }
        if let Some(path) = sourcing.plan(index) {
            let group = routes.get_mut(&recipe.output).expect("craft route");
            let mut chained = vec![];
            for direct in &group[first_route..] {
                if direct["stock"] != "insufficient"
                    && direct["cost"].as_u64().is_some_and(|n| n <= path.cost)
                {
                    continue;
                }
                let extra = match direct["kind"].as_str() {
                    Some("craft_auction") => vec![recipe.output],
                    Some("craft_disenchant") => direct["outputs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v["id"].as_u64().map(|id| id as u32))
                        .collect(),
                    _ => vec![],
                };
                let mut variant = finish(
                    direct.clone(),
                    path.inputs.clone(),
                    direct["proceeds"].as_u64(),
                    extra.iter().all(|id| quotes[id].check.is_some()),
                );
                variant["stages"] = json!(path.stages);
                variant["expected_inputs"] = json!(path.expected);
                let joint_de = if direct["kind"] == "craft_disenchant" {
                    let Some(check) = path.final_de_access.as_ref() else {
                        continue;
                    };
                    Some(check)
                } else {
                    None
                };
                variant["ready"] = json!(
                    direct["ready"] == true
                        && path.ready
                        && joint_de.is_none_or(|(ready, _)| *ready)
                );
                variant["final_inputs"] = json!(recipe
                    .mats
                    .iter()
                    .map(|(id, n)| json!({"id":id,"name":quotes[id].name,"quantity":n}))
                    .collect::<Vec<_>>());
                let mut skills: Set<&str> = path.skills.iter().map(String::as_str).collect();
                skills.extend(req["profession"].as_str());
                if direct["kind"] == "craft_disenchant" {
                    skills.insert("Enchanting");
                }
                let slots = crate::professions::slot_advice(s, &skills);
                let notes = [
                    slots.as_str(),
                    direct["advice"].as_str().unwrap_or(""),
                    &path.advice,
                    joint_de.map_or("", |(_, msg)| msg.as_str()),
                ];
                variant["advice"] = json!(notes
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" "));
                if path.expected && variant["stock"] == "verified" {
                    variant["stock"] = "estimated".into();
                }
                if active {
                    candidate(
                        &mut candidates,
                        recipe.output,
                        &path.inputs,
                        direct["proceeds"].as_u64(),
                        &extra,
                    );
                }
                chained.push(variant);
            }
            group.extend(chained);
        }
    }
    for route in routes.values_mut().flatten() {
        if let Some(timing) = timing::estimate(route) {
            route["timing"] = timing;
        }
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut queue = Set::new();
    for (_, _, ids) in candidates {
        if queue.len() + ids.difference(&queue).count() <= 250 {
            queue.extend(ids)
        }
    }
    let items:Vec<_>=quotes.into_iter().map(|(id,q)|json!({"id":id,"name":q.name,"estimate":q.estimate,"estimated_auctions":q.count,"checked_price":q.check.map(|p|p.total_buyout as f64/p.units as f64),"checked_at":q.at,"listed_units":q.units(),"checked_auctions":q.at.map(|_|q.check.map_or(0,|p|p.auctions)),"vendor_sell":q.item.and_then(|i|i.vendor_sell),"max_stack":q.item.and_then(|i|i.max_stack),"routes":routes.remove(&id).unwrap_or_default()})).collect();
    let tsm = json!({"source":if desktop{"Desktop AppHelper"}else if est_at>0{"Public DBRecent"}else{"None"},"state":if active{"fresh"}else if est_at>0{"stale"}else{"waiting"},"count":if desktop{obs.estimate_prices.len()}else{feed.items.len()},"observed_at":est_at});
    json!({"region":region,"market":market,"generated_at":now,"upload_revision":b.map(|b|b.revision),"status":"responsive","tsm":tsm,"items":items,"scan_queue":queue,"queue_estimate_at":if queue.is_empty(){0}else{est_at}})
}
