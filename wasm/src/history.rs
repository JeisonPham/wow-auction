use super::*;
use std::collections::BTreeMap;

pub fn samples(v: &V) -> Vec<(u64, f64)> {
    rows(v)
        .iter()
        .filter_map(|r| Some((r[0].as_u64()?, r[1].as_f64()?)))
        .collect()
}
pub(crate) fn median(values: &mut [f64]) -> f64 {
    values.sort_unstable_by(f64::total_cmp);
    (values[(values.len() - 1) / 2] + values[values.len() / 2]) / 2.
}
pub fn best(samples: &[(u64, f64)], highest: bool) -> V {
    let mut bins: [Vec<f64>; 24] = Default::default();
    for &(t, value) in samples {
        bins[(t / 3600 % 24) as usize].push(value)
    }
    let sampled: Vec<_> = bins
        .iter_mut()
        .enumerate()
        .filter(|(_, v)| !v.is_empty())
        .map(|(hour, v)| json!({"hour":hour,"days":v.len(),"value":median(v)}))
        .collect();
    let eligible: Vec<_> = sampled.iter().filter(|b| uint(&b["days"]) >= 3).collect();
    if eligible.len() < 2 {
        return json!({"state":"collecting","compared":eligible.len(),"sampled":sampled});
    }
    let value = eligible
        .iter()
        .map(|b| num(&b["value"]))
        .reduce(if highest { f64::max } else { f64::min })
        .unwrap();
    let winners: Vec<_> = eligible
        .iter()
        .filter(|b| num(&b["value"]) == value)
        .collect();
    let days = winners.iter().map(|b| uint(&b["days"]));
    json!({"state":"ready","compared":eligible.len(),"sampled":sampled,"value":value,"winners":winners,
        "minDays":days.clone().min(),"maxDays":days.max()})
}
pub fn daily(a: &V) -> V {
    let first = (uint(&a[1]) / 86400000).saturating_sub(27);
    let mut bins: [Vec<f64>; 28] = Default::default();
    for (t, v) in samples(&a[0]) {
        if let Some(bin) = (t / 86400)
            .checked_sub(first)
            .and_then(|d| bins.get_mut(d as usize))
        {
            bin.push(v)
        }
    }
    let sampled: Vec<_> = bins
        .iter_mut()
        .enumerate()
        .filter(|(_, v)| !v.is_empty())
        .map(|(hour, v)| json!({"hour":hour,"count":v.len(),"value":median(v)}))
        .collect();
    json!({"dates":(first..first+28).map(|d|d*86400000).collect::<Vec<_>>(),"sampled":sampled})
}
pub fn profile(a: &V) -> V {
    let (item, r, batch, h, book) = (&a[0], &a[1], num(&a[2]), &a[3]["items"], &a[4]);
    let mut hours: BTreeMap<u64, BTreeMap<&str, &V>> = BTreeMap::new();
    if let Some(items) = h.as_object() {
        for (id, series) in items {
            for row in rows(series) {
                hours.entry(uint(&row[0])).or_default().insert(id, row);
            }
        }
    }
    let kind = r["kind"].as_str().unwrap_or("");
    let inputs: Vec<_> = rows(&r["inputs"])
        .iter()
        .map(|l| {
            let id = uint(&l["id"]).to_string();
            let e = &book[&id];
            let bound = e["auctionable"] == false;
            let vendor = kind
                .starts_with("craft")
                .then(|| {
                    e["vendor_buy"].as_f64().or_else(|| {
                        (l["source"] == "vendor")
                            .then(|| l["unit_cost"].as_f64())
                            .flatten()
                    })
                })
                .flatten();
            let fixed =
                vendor.is_some() && (bound || !rows(&h[&id]).iter().any(|v| !v[1].is_null()));
            (
                id,
                vendor.map(|v| v * num(&l["quantity"]) * batch),
                fixed,
                bound || l["source"] == "bound",
            )
        })
        .collect();
    let vendor_sale = matches!(kind, "craft" | "vendor");
    let outputs: Vec<_> = if kind == "craft_auction" {
        vec![(uint(&item["id"]).to_string(), num(&r["quantity"]))]
    } else {
        rows(&r["outputs"])
            .iter()
            .map(|v| (uint(&v["id"]).to_string(), num(&v["quantity"])))
            .collect()
    };
    let (mut costs, mut sales) = (vec![], vec![]);
    for (hour, quotes) in hours {
        let cost = inputs
            .iter()
            .map(|(id, vendor, fixed, bound)| {
                if *fixed {
                    return *vendor;
                }
                if *bound {
                    return None;
                }
                let row = quotes.get(id.as_str())?;
                row[2]
                    .as_f64()
                    .into_iter()
                    .chain(*vendor)
                    .reduce(f64::min)
                    .map(f64::ceil)
            })
            .sum::<Option<f64>>();
        if let Some(c) = cost.filter(|n| safe(*n)) {
            costs.push((hour, c))
        }
        if !vendor_sale && !outputs.is_empty() {
            if let Some(g) = outputs
                .iter()
                .map(|(id, qty)| Some(quotes.get(id.as_str())?[1].as_f64()? * qty))
                .sum::<Option<f64>>()
            {
                sales.push((hour, (g * 323. / 400.).floor() * batch))
            }
        }
    }
    let buy = if inputs.iter().all(|i| i.2) {
        json!({"state":"fixed","value":inputs.iter().filter_map(|i|i.1).sum::<f64>()})
    } else {
        best(&costs, false)
    };
    let sell = if vendor_sale {
        json!({"state":"fixed","value":r["proceeds"].as_f64().map(|v|v*batch)})
    } else {
        best(&sales, true)
    };
    json!({"buy":buy,"sell":sell,"margin":sell["value"].as_f64().zip(buy["value"].as_f64()).map(|(s,b)|s-b-num(&a[5]))})
}

pub fn chart_scale(values: &V) -> V {
    let peak = rows(values).iter().filter_map(V::as_f64).fold(0., f64::max);
    let peak = if peak > 0. { peak } else { 1. };
    let power = 10_f64.powf(peak.log10().floor());
    let ceiling = [1., 2., 5., 10.]
        .into_iter()
        .find(|n| n * power >= peak)
        .unwrap_or(10.)
        * power;
    let divisor = if ceiling >= 10000. {
        10000.
    } else if ceiling >= 100. {
        100.
    } else {
        1.
    };
    json!({"ceiling":ceiling,"divisor":divisor,"top":ceiling/divisor,"middle":ceiling/(2.*divisor)})
}
