use super::*;
use crate::stacks::{self, Pricer};
use std::collections::HashMap;

#[derive(Default)]
struct Book {
    entries: HashMap<u64, V>,
    observed: [Vec<u64>; 2],
    prices: HashMap<u64, Pricer>,
    quotes: HashMap<(u64, u64), Option<(f64, u64)>>,
}
thread_local! {static BOOK:RefCell<Book>=RefCell::new(Book::default());}
pub fn register(items: &V) -> Result<V> {
    let mut book = Book::default();
    for mut item in rows(items).iter().cloned() {
        let id = uint(&item["id"]);
        let lots = item
            .as_object_mut()
            .and_then(|o| o.remove("lots"))
            .unwrap_or_default();
        if !lots.is_null() {
            book.prices.insert(id, Pricer::new(stacks::lots(&lots)?));
        }
        for (times, at) in book
            .observed
            .iter_mut()
            .zip([&item["checked_at"], &item["purchase_depth"]["observed_at"]])
        {
            if let Some(t) = at.as_u64() {
                times.push(t);
            }
        }
        book.entries.insert(id, item);
    }
    for times in &mut book.observed {
        times.sort_unstable();
        times.dedup();
    }
    BOOK.with(|b| b.replace(book));
    Ok(V::Null)
}
pub fn percentile(d: &V, need: u64, floor: u64) -> V {
    if d.is_null() {
        return json!({"status":"no_depth"});
    }
    let available = uint(&d["available"]);
    if need > available {
        return json!({"status":"insufficient"});
    }
    let rank = (need as u128).max((u128::from(available) * u128::from(floor)).div_ceil(100));
    let levels = rows(&d["levels"]);
    let Some(l) = levels.get(levels.partition_point(|l| u128::from(uint(&l[0])) < rank)) else {
        return json!({"status":"no_price_levels"});
    };
    let (price, size) = (uint(&l[1]), uint(&l[2]));
    if size == 0 {
        return json!({"status":"no_price_levels"});
    }
    let cost = (u128::from(price) * u128::from(need)).div_ceil(u128::from(size));
    if cost > MAX as u128 {
        return json!({"status":"budget_overflow"});
    }
    json!({"status":"priced","unit":price as f64/size as f64,"budget":cost as u64,"percentile":100.*rank as f64/available as f64})
}
fn vendor(line: &V, entry: &V, craft: bool) -> Option<f64> {
    craft.then(|| {
        entry["vendor_buy"].as_f64().or_else(|| {
            (line["source"] == "vendor")
                .then(|| line["unit_cost"].as_f64())
                .flatten()
        })
    })?
}
fn update(mut base: V, patch: V) -> V {
    if let (Some(obj), V::Object(fields)) = (base.as_object_mut(), patch) {
        obj.extend(fields)
    }
    base
}
pub fn input(line: &V, entry: &V, batch: u64, floor: u64, cutoff: u64, craft: bool) -> V {
    let need = uint(&line["quantity"]) * batch;
    let d = &entry["purchase_depth"];
    let d = if d["observed_at"].as_u64().is_some_and(|at| at >= cutoff) {
        d
    } else {
        &V::Null
    };
    let quote = percentile(d, need, floor);
    let bound = line["source"] == "bound" || entry["auctionable"] == false;
    let fallback = matches!(
        quote["status"].as_str(),
        Some("no_depth" | "no_price_levels")
    );
    let mut unit = if bound {
        None
    } else {
        quote["unit"]
            .as_f64()
            .or_else(|| fallback.then(|| entry["estimate"].as_f64()).flatten())
    };
    let mut budget = unit.map(|p| {
        quote["budget"]
            .as_f64()
            .unwrap_or_else(|| (p * need as f64).ceil())
    });
    let mut source = if quote["status"] == "priced" {
        "percentile"
    } else {
        "estimate"
    };
    if let Some(v) =
        vendor(line, entry, craft).filter(|v| budget.is_none_or(|n| v * need as f64 <= n))
    {
        unit = Some(v);
        budget = Some(v * need as f64);
        source = "vendor";
    } else if unit.is_none() {
        source = if bound { "bound" } else { "unpriced" };
    }
    let budget = budget.filter(|n| safe(*n));
    update(
        line.clone(),
        json!({"source":source,"unit_cost":unit,"cost":budget.map(|n|n/batch as f64),"purchase_budget":budget,
        "listed_units":d["available"],"depth":if d.is_null(){V::Null}else{json!({"source":d["source"],"available":d["available"],"observed_at":d["observed_at"]})},
        "percentile":quote["percentile"],"quote_status":quote["status"]}),
    )
}
pub fn shopping(a: &V) -> V {
    BOOK.with_borrow_mut(|book| shopping_with(book, a))
}
fn shopping_with(book: &mut Book, a: &V) -> V {
    if book.quotes.len() >= 16384 {
        book.quotes.clear();
    }
    let (item, r, c, post, cutoff) = (&a[0], &a[1], &a[2], num(&a[3]), uint(&a[4]));
    let batch = num(&c["batch"]);
    let kind = r["kind"].as_str().unwrap_or("");
    let mut oldest = None;
    let mut observe = |at: u64| oldest = Some(oldest.map_or(at, |t: u64| t.min(at)));
    let mut ask = |id: u64| {
        let at = uint(&book.entries.get(&id)?["checked_at"]);
        let &[size, price, _] = book.prices.get(&id)?.lots.first()?;
        if at == 0 || at < cutoff {
            return None;
        }
        observe(at);
        Some(price as f64 / size as f64)
    };
    let mut outputs = r["outputs"].clone();
    let qty = num(&r["quantity"]);
    let unit = match kind {
        "craft_auction" => ask(uint(&item["id"])).map(|p| p * 323. / 400.),
        "craft_disenchant" | "disenchant" => {
            let mut gross = (!rows(&outputs).is_empty()).then_some(0.);
            for o in outputs.as_array_mut().into_iter().flatten() {
                let p = ask(uint(&o["id"]));
                gross = gross.zip(p).map(|(g, p)| g + p * num(&o["quantity"]));
                o["unit_cost"] = json!(p);
                o["source"] = json!(if p.is_some() { "checked" } else { "unpriced" });
            }
            gross.map(|g| g * 323. / (400. * qty))
        }
        _ => item["vendor_sell"].as_f64(),
    };
    let out = unit.map(|p| (p * qty * batch).floor());
    let (mut fixed, mut auction, mut issue, mut short) = (post, 0., String::new(), false);
    let mut orders = vec![];
    let mut inputs = vec![];
    for line in rows(&r["inputs"]) {
        let id = uint(&line["id"]);
        let entry = book.entries.get(&id).unwrap_or(&V::Null);
        let at = uint(&entry["checked_at"]);
        let fresh = at > 0 && at >= cutoff;
        let need = uint(&line["quantity"]) * batch as u64;
        let v = vendor(line, entry, kind.starts_with("craft"));
        let buy = if fresh && line["source"] != "bound" {
            *book.quotes.entry((id, need)).or_insert_with(|| {
                book.prices
                    .get_mut(&id)?
                    .buy(need, 1., 1., None, 250000)
                    .filter(|(v, _)| safe(*v))
            })
        } else {
            None
        };
        let (source, cost) = if let Some(v) =
            v.filter(|v| buy.is_none_or(|(n, _)| v * need as f64 <= n))
        {
            let cost = v * need as f64;
            fixed += cost;
            ("vendor", Some(cost))
        } else if let Some((cost, units)) = buy {
            auction += cost;
            observe(at);
            orders.push(json!({"id":id,"name":line["name"],"vendor":v,"cost":cost,"units":units}));
            ("checked", Some(cost))
        } else {
            let insufficient = fresh && uint(&entry["listed_units"]) < need;
            short |= insufficient;
            if issue.is_empty() {
                issue = format!(
                    "{} for {}.",
                    if insufficient {
                        "Insufficient listed quantity"
                    } else {
                        "A fresh listing scan is needed"
                    },
                    line["name"].as_str().unwrap_or("item")
                )
            }
            ("unpriced", None)
        };
        inputs.push(update(line.clone(),json!({"source":source,"cost":cost.map(|x|x/batch),"unit_cost":cost.map(|x|x/need as f64),"listed_units":if fresh{&entry["listed_units"]}else{&V::Null}})));
    }
    let cost = issue.is_empty().then_some(fixed + auction);
    if issue.is_empty() && !out.is_some_and(safe) {
        issue = "A current sale value is needed for the output.".into()
    }
    if issue.is_empty() && cost.is_some_and(|v| !safe(v)) {
        issue = "Batch cost exceeds the supported copper range.".into()
    }
    let profit = if issue.is_empty() {
        out.zip(cost).map(|(o, c)| o - c)
    } else {
        None
    };
    let budget = if issue.is_empty() {
        out.unwrap() - fixed - num(&c["minProfit"])
    } else {
        0.
    };
    if budget > 0. && auction > 0. {
        let budget = budget as u128;
        let auction = auction as u128;
        let units: u128 = orders.iter().map(|o| u128::from(uint(&o["units"]))).sum();
        let floor = u128::from(
            units <= budget
                && orders.iter().any(|o| {
                    budget * (uint(&o["cost"]) as u128) < auction * uint(&o["units"]) as u128
                }),
        );
        for o in &mut orders {
            let cap = (floor
                + (budget - floor * units) * uint(&o["cost"]) as u128
                    / (auction * uint(&o["units"]) as u128)) as u64;
            let cap = o["vendor"].as_f64().map_or(cap, |v| cap.min(v as u64));
            o["cap"] = json!(cap);
            let available: u64 = book.prices[&uint(&o["id"])]
                .lots
                .iter()
                .filter(|&&[s, p, _]| p as u128 <= cap as u128 * s as u128)
                .map(|&[s, _, n]| s * n)
                .sum();
            o["available"] = json!(available);
        }
    }
    let ready =
        issue.is_empty() && !orders.is_empty() && orders.iter().all(|o| uint(&o["cap"]) > 0);
    json!({"inputs":inputs,"outputs":outputs,"netUnit":unit,"out":out,"cost":cost,"profit":profit,"orders":orders,"capsReady":ready,"issue":issue,"short":short,"oldest":oldest})
}
pub fn summary(i: &V, r: &V, c: &V) -> V {
    let batch = num(&c["batch"]);
    let timing = &r["timing"];
    let stack = |n: &V| {
        n.as_f64()
            .filter(|n| *n > 0.)
            .unwrap_or_else(|| num(&c["stack"]).max(1.))
    };
    let stacks: f64 = rows(&r["inputs"])
        .iter()
        .map(|l| (num(&l["quantity"]) * batch / stack(&l["max_stack"])).ceil())
        .sum();
    let back = if c["back"] != true {
        0.
    } else {
        match r["kind"].as_str() {
            Some("craft" | "craft_auction") => {
                (num(&r["quantity"]) * batch / stack(&i["max_stack"])).ceil()
            }
            Some("craft_disenchant" | "disenchant") => num(&c["returns"]),
            _ => 0.,
        }
    };
    let postage = if c["mail"] == true {
        (stacks + back) * num(&c["post"])
    } else {
        0.
    };
    let (cost, out) = if !r["shopping"].is_null() {
        (
            r["shopping"]["cost"].as_f64(),
            r["shopping"]["out"].as_f64(),
        )
    } else {
        (
            r["cost"]
                .as_f64()
                .map(|x| r["purchaseBudget"].as_f64().unwrap_or(x * batch) + postage),
            r["proceeds"].as_f64().map(|p| p * batch),
        )
    };
    let net = out.zip(cost).map(|(o, c)| o - c);
    let seconds = timing["elapsed_seconds"]
        .as_f64()
        .map(|t| t + (batch - 1.) * num(&timing["repeat_seconds"]));
    let active = timing["active_seconds"].as_f64().map(|t| t * batch);
    let shortages: Vec<_> = rows(&r["inputs"])
        .iter()
        .filter_map(|l| {
            let need = num(&l["quantity"]) * batch;
            let listed = l["listed_units"].as_f64()?;
            (l["source"] != "vendor" && need > listed).then(|| {
                format!(
                    "{} needs {need}, {} {listed}",
                    l["name"].as_str().unwrap_or("item"),
                    if r["percentileMode"] == true {
                        "listed"
                    } else {
                        "checked"
                    }
                )
            })
        })
        .collect();
    json!({"postage":postage,"net":net,"cost":cost,"out":out,"active":active,"seconds":seconds,"wait":seconds.zip(active).map(|(s,a)|((s-a)*10.).round().max(0.)/10.),"goldPerHour":net.zip(seconds).and_then(|(n,s)|ratio(n*0.36,s)),"shortages":shortages})
}
pub fn price_route(a: &V) -> V {
    let (i, r, c) = (&a[0], &a[1], &a[2]);
    let batch = num(&c["batch"]);
    let post = summary(i, r, c)["postage"].clone();
    let mut patch = if a[3] == "percentile" {
        let inputs: Vec<_> = BOOK.with_borrow(|book| {
            rows(&r["inputs"])
                .iter()
                .map(|l| {
                    input(
                        l,
                        book.entries.get(&uint(&l["id"])).unwrap_or(&V::Null),
                        batch as u64,
                        uint(&a[4]),
                        uint(&a[5]),
                        r["kind"].as_str().is_some_and(|s| s.starts_with("craft")),
                    )
                })
                .collect()
        });
        let budget = inputs
            .iter()
            .map(|l| l["purchase_budget"].as_f64())
            .sum::<Option<f64>>()
            .filter(|v| safe(*v));
        let profit = budget
            .zip(r["proceeds"].as_f64())
            .map(|(b, p)| p * batch - b - num(&post))
            .filter(|v| safe(*v))
            .map(|v| v / batch);
        let short = inputs
            .iter()
            .any(|l| l["source"] != "vendor" && l["quote_status"] == "insufficient");
        json!({"percentileMode":true,"inputs":inputs,"purchaseBudget":budget,"cost":budget.map(|v|v/batch),"profit":profit,"stock":if short{"insufficient"}else if profit.is_none(){"unknown"}else{"estimated"}})
    } else {
        let q = shopping(&json!([i, r, c, post, a[5]]));
        json!({"shopping":q,"inputs":q["inputs"],"outputs":q["outputs"],"cost":q["cost"].as_f64().map(|v|(v-num(&post))/batch),"proceeds":q["out"].as_f64().map(|v|v/batch),"net_unit_value":q["netUnit"],"profit":q["profit"].as_f64().map(|v|v/batch),"stock":if q["short"]==true{"insufficient"}else if q["issue"]!=""{"unknown"}else{"verified"}})
    };
    if !r["timing"].is_null() {
        let mut timing = r["timing"].clone();
        timing["gold_per_hour"] = json!(patch["profit"]
            .as_f64()
            .and_then(|v| ratio(v * 0.36, num(&timing["repeat_seconds"]))));
        patch["timing"] = timing
    }
    patch
}
pub fn breakdown(inputs: &V, batch: f64) -> V {
    let amounts: Vec<_> = rows(inputs)
        .iter()
        .map(|l| {
            l["cost"]
                .as_f64()
                .map(|v| l["purchase_budget"].as_f64().unwrap_or(v * batch))
        })
        .collect();
    let total = amounts.iter().copied().sum::<Option<f64>>();
    json!(amounts
        .into_iter()
        .map(|a| json!({"cost":a,"share":total.zip(a).and_then(|(t,a)|ratio(a*100.,t))}))
        .collect::<Vec<_>>())
}

#[no_mangle]
pub extern "C" fn freshness_epoch(cutoff: f64, percentile: bool) -> usize {
    BOOK.with_borrow(|b| {
        b.observed[usize::from(percentile)].partition_point(|&t| t < (cutoff as u64))
    })
}

pub fn training(data: &V) -> V {
    let mut picks = HashMap::new();
    for (index, r) in rows(data).iter().enumerate() {
        if r["ready"] != false
            || !r["kind"].as_str().is_some_and(|s| s.starts_with("craft"))
            || num(&r["profit"]) <= 0.
            || r["stock"] == "insufficient"
        {
            continue;
        }
        let Some(score) = r["score"].as_f64() else {
            continue;
        };
        let key = r["profession"].as_str().unwrap_or("");
        let candidate = picks.entry(key).or_insert((index, score));
        if score > candidate.1 {
            *candidate = (index, score)
        }
    }
    let mut picks: Vec<_> = picks.into_values().collect();
    picks.sort_unstable_by(|(ai, a), (bi, b)| b.total_cmp(a).then(ai.cmp(bi)));
    json!(picks.into_iter().map(|(i, _)| i).collect::<Vec<_>>())
}
