use crate::scan::{Band, Snapshot};
use flate2::read::GzDecoder;
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::LazyLock,
};

#[derive(Deserialize)]
pub struct Catalog {
    pub build: String,
    profession_ranks: BTreeMap<String, Vec<(u64, u64)>>,
    pub disenchant_seconds: f64,
    pub snapshot: Snapshot,
    pub overrides: BTreeMap<u32, BTreeMap<u32, f64>>,
}
pub static FOREVER: LazyLock<Catalog> = LazyLock::new(|| {
    serde_json::from_reader(GzDecoder::new(&include_bytes!("data/forever.json.gz")[..]))
        .expect("invalid bundled Forever catalog")
});

impl Catalog {
    pub fn rank_level(&self, profession: &str, skill: u64) -> Option<u64> {
        self.profession_ranks
            .get(profession)?
            .iter()
            .find(|(cap, _)| (1..=*cap).contains(&skill))
            .map(|(_, level)| *level)
    }

    pub fn for_player(&self, player: &Snapshot) -> Snapshot {
        let mut result = self.snapshot.clone();
        result.professions.clone_from(&player.professions);
        result.character_levels.clone_from(&player.character_levels);
        result.complete_rosters.clone_from(&player.complete_rosters);
        if !player.disenchant.is_empty() && player.non_disenchantable.is_some() {
            result.disenchant.clone_from(&player.disenchant);
        }
        if let Some(excluded) = &player.non_disenchantable {
            result
                .non_disenchantable
                .get_or_insert_with(BTreeSet::new)
                .extend(excluded);
        }
        for (&id, live) in &player.items {
            let item = result.items.entry(id).or_default();
            if !live.name.is_empty() {
                item.name.clone_from(&live.name)
            }
            item.vendor_sell = live.vendor_sell.or(item.vendor_sell);
            item.vendor_buy = live.vendor_buy.or(item.vendor_buy);
            item.max_stack = live.max_stack.or(item.max_stack);
            item.no_disenchant |= live.no_disenchant;
            if !live.binding.is_empty() {
                item.binding.clone_from(&live.binding)
            }
            if live.class.is_some() {
                item.class = live.class;
                item.quality = live.quality;
            }
            if live.level > 0 {
                item.level = live.level
            }
            if !live.inventory_type.is_empty() {
                item.inventory_type.clone_from(&live.inventory_type)
            }
            item.inventory_slot = live.inventory_slot.or(item.inventory_slot);
        }
        let mut indexes: BTreeMap<_, _> = result
            .recipes
            .iter()
            .enumerate()
            .map(|(n, r)| (r.id.clone(), n))
            .collect();
        for r in &player.recipes {
            let req = player.recipe_requirements.get(&r.id);
            let matched = indexes.get(&r.id).copied().or_else(|| {
                if r.id.parse::<u32>().is_ok() {
                    return None;
                }
                // The classic profession API may supply a name in place of a spell ID.
                let mut matches = result.recipes.iter().enumerate().filter(|(_, old)| {
                    old.output == r.output
                        && (old.quantity == r.quantity
                            || r.quantity_max
                                .is_some_and(|max| (r.quantity..=max).contains(&old.quantity)))
                        && old.name == r.name
                        && old.mats == r.mats
                        && req.and_then(|v| v.get("profession")).is_some_and(|prof| {
                            result
                                .recipe_requirements
                                .get(&old.id)
                                .and_then(|v| v.get("profession"))
                                == Some(prof)
                        })
                });
                let first = matches.next()?.0;
                matches.next().is_none().then_some(first)
            });
            let id = if let Some(n) = matched {
                let old = &result.recipes[n];
                let id = old.id.clone();
                let mut live = r.clone();
                if live.quantity_max.is_none()
                    && old.quantity == live.quantity
                    && old.output == live.output
                {
                    live.quantity_min = live.quantity_min.or(old.quantity_min);
                    live.quantity_max = old.quantity_max;
                }
                result.recipes[n] = live;
                result.recipes[n].id = id.clone();
                id
            } else {
                indexes.insert(r.id.clone(), result.recipes.len());
                result.recipes.push(r.clone());
                r.id.clone()
            };
            if let Some(fields) = req.and_then(|v| v.as_object()) {
                let merged = result
                    .recipe_requirements
                    .entry(id)
                    .or_insert_with(|| serde_json::json!({}));
                for (k, v) in fields {
                    if !v.is_null() {
                        merged[k] = v.clone()
                    }
                }
            }
        }
        result
    }
}
pub fn item_band(band: &Band, id: u32, bundled: bool) -> Band {
    let mut resolved = band.clone();
    if let Some(mats) = bundled.then(|| FOREVER.overrides.get(&id)).flatten() {
        resolved.mats.clone_from(mats)
    }
    resolved
}
