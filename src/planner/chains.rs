//! Compare direct purchases with craft and disenchant sources for intermediate reagents.
use super::{Map, Quote, Set};
use crate::{
    catalog, disenchant, professions,
    scan::{Recipe, Snapshot},
};
use serde_json::{json, Value};

// Bound the search on full market books. Ranking is only a shortlist. Every displayed
// path is subsequently costed with whole crafts, aggregated purchases and checked stock.
const DEPTH: usize = 4;
const SOURCES: usize = 8;
const PER_REAGENT_BUDGET: usize = 160;
// Expected yields are tracked in millionths of an item. Copper always stays integer.
const SCALE: u128 = 1_000_000;

#[derive(Clone, Copy)]
struct Source {
    recipe: usize,
    destroy: bool,
    per_gear: u128,
}
struct Drops {
    skill: u32,
    amounts: Vec<(u32, u128)>,
}
#[derive(Clone)]
struct Step {
    recipe: usize,
    runs: u32,
    destroyed: u32,
}
#[derive(Clone, Default)]
struct Ledger {
    purchases: Map<u32, u32>,
    spend: u64,
    steps: Vec<Step>,
    // Bind-on-pickup surplus belongs to the craft that will consume it.
    spare: Map<(u32, Option<usize>), u128>,
    same_character: Vec<(usize, usize)>,
}
pub(super) struct Path {
    pub cost: u64,
    pub inputs: Vec<Value>,
    pub stages: Vec<Value>,
    pub skills: Set<String>,
    pub ready: bool,
    pub advice: String,
    pub expected: bool,
    pub final_de_access: Option<(bool, String)>,
}
pub(super) struct Search<'a> {
    s: &'a Snapshot,
    quotes: &'a Map<u32, Quote<'a>>,
    drops: Vec<Option<Drops>>,
    choices: Vec<Map<u32, Vec<Source>>>,
}

impl<'a> Search<'a> {
    pub fn new(
        s: &'a Snapshot,
        quotes: &'a Map<u32, Quote<'a>>,
        market: &str,
        bundled: bool,
    ) -> Self {
        let wanted: Set<_> = s
            .recipes
            .iter()
            .flat_map(|r| r.mats.iter().map(|m| m.0))
            .collect();
        let mut producers = Map::<u32, Vec<Source>>::new();
        let mut drops = vec![];
        for (idx, r) in s.recipes.iter().enumerate() {
            let req = s.recipe_requirements.get(&r.id);
            if req
                .and_then(|v| v["faction"].as_str())
                .is_some_and(|side| market.rsplit_once('-').is_some_and(|(_, f)| f != side))
            {
                drops.push(None);
                continue;
            }
            if wanted.contains(&r.output) {
                producers.entry(r.output).or_default().push(Source {
                    recipe: idx,
                    destroy: false,
                    per_gear: SCALE,
                });
            }
            let band = quotes[&r.output]
                .item
                .and_then(|i| disenchant::rule(r.output, i, s))
                .map(|(band, skill)| {
                    let band = catalog::item_band(band, r.output, bundled);
                    let amounts = band
                        .mats
                        .iter()
                        .map(|(&id, &yield_)| (id, (yield_ * SCALE as f64).round() as u128))
                        .filter(|(_, n)| *n > 0)
                        .collect::<Vec<_>>();
                    for &(id, n) in &amounts {
                        if wanted.contains(&id) && !quotes[&id].bound() {
                            producers.entry(id).or_default().push(Source {
                                recipe: idx,
                                destroy: true,
                                per_gear: n,
                            });
                        }
                    }
                    Drops { skill, amounts }
                });
            drops.push(band);
        }
        let base: Map<_, _> = wanted
            .iter()
            .filter_map(|id| {
                let q = &quotes[id];
                let (_, source, unit) = q.purchase(1, true, false);
                unit.filter(|_| source == "vendor" || q.units() != Some(0))
                    .map(|v| (*id, v))
            })
            .collect();
        let mut costs = base.clone();
        let mut choices = vec![];
        for _ in 0..DEPTH {
            let mut next = base.clone();
            let mut layer = Map::new();
            for (&id, sources) in &producers {
                let mut ranked = vec![];
                for &source in sources {
                    let r = &s.recipes[source.recipe];
                    let cost = r.mats.iter().try_fold(0., |total, (m, q)| {
                        Some(total + costs.get(m)? * f64::from(*q))
                    });
                    if let Some(cost) = cost {
                        let unit =
                            cost / (f64::from(r.quantity) * source.per_gear as f64 / SCALE as f64);
                        ranked.push((unit, source));
                    }
                }
                ranked.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.recipe.cmp(&b.1.recipe)));
                if let Some((v, _)) = ranked.first() {
                    next.entry(id).and_modify(|p| *p = p.min(*v)).or_insert(*v);
                }
                if !ranked.is_empty() {
                    layer.insert(id, ranked.into_iter().take(SOURCES).map(|p| p.1).collect());
                }
            }
            choices.push(layer);
            costs = next;
        }
        Self {
            s,
            quotes,
            drops,
            choices,
        }
    }

    fn buy(&self, state: &Ledger, id: u32, count: u32) -> Option<Ledger> {
        let q = &self.quotes[&id];
        let old = state.purchases.get(&id).copied().unwrap_or(0);
        let count = count.checked_add(old)?;
        let (cost, source, _) = q.purchase(count, true, false);
        if source != "vendor" && q.units().is_some_and(|n| n < u64::from(count)) {
            return None;
        }
        let previous = if old == 0 {
            0
        } else {
            q.purchase(old, true, false).0?
        };
        let mut next = state.clone();
        next.spend = next.spend.checked_sub(previous)?.checked_add(cost?)?;
        next.purchases.insert(id, count);
        Some(next)
    }

    #[allow(clippy::too_many_arguments)]
    fn supply(
        &self,
        id: u32,
        count: u32,
        consumer: usize,
        depth: usize,
        parents: &mut Vec<u32>,
        mut state: Ledger,
        budget: &mut usize,
    ) -> Option<Ledger> {
        if parents.contains(&id) {
            return None;
        }
        let owner = (!self.quotes[&id].transferable()).then_some(consumer);
        let key = (id, owner);
        let need = u128::from(count) * SCALE;
        let spare = state.spare.remove(&key).unwrap_or(0);
        if spare >= need {
            state.spare.insert(key, spare - need);
            return Some(state);
        }
        let need = need - spare;
        let buying = u32::try_from(need.div_ceil(SCALE)).ok()?;
        let mut best = self.buy(&state, id, buying);
        // Buying a whole item can complete a fractional expected balance.
        if let Some(p) = &mut best {
            p.spare.insert(key, u128::from(buying) * SCALE - need);
        }
        let Some(options) = depth.checked_sub(1).and_then(|d| self.choices[d].get(&id)) else {
            return best;
        };
        parents.push(id);
        for &source in options {
            if *budget == 0 {
                break;
            }
            let r = &self.s.recipes[source.recipe];
            if source.destroy && parents.contains(&r.output) {
                continue;
            }
            *budget -= 1;
            let Ok(units) = u32::try_from(need.div_ceil(source.per_gear)) else {
                continue;
            };
            let runs = units.div_ceil(r.quantity);
            if source.destroy {
                parents.push(r.output);
            }
            let candidate = r.mats.iter().try_fold(state.clone(), |acc, (mat, qty)| {
                self.supply(
                    *mat,
                    qty.checked_mul(runs)?,
                    source.recipe,
                    depth - 1,
                    parents,
                    acc,
                    budget,
                )
            });
            if source.destroy {
                parents.pop();
            }
            let Some(mut plan) = candidate else {
                continue;
            };
            if best.as_ref().is_some_and(|b| b.spend <= plan.spend) {
                continue;
            }
            if source.destroy {
                let drops = self.drops[source.recipe].as_ref().expect("indexed drops");
                for &(mat, per) in &drops.amounts {
                    if mat != id && !self.quotes[&mat].transferable() {
                        continue;
                    }
                    let amount = per * u128::from(units);
                    *plan
                        .spare
                        .entry((mat, if mat == id { owner } else { None }))
                        .or_default() += if mat == id { amount - need } else { amount };
                }
            } else {
                plan.spare.insert(
                    key,
                    u128::from(runs) * u128::from(r.quantity) * SCALE - need,
                );
                if owner.is_some() {
                    plan.same_character.push((source.recipe, consumer));
                }
            }
            plan.steps.push(Step {
                recipe: source.recipe,
                runs,
                destroyed: if source.destroy { units } else { 0 },
            });
            if owner.is_some() && !self.groups_possible(&plan) {
                continue;
            }
            best = Some(plan);
        }
        parents.pop();
        best
    }

    // Connected bound intermediates must be crafted and consumed on one character.
    fn groups(&self, state: &Ledger) -> Vec<Set<usize>> {
        let mut groups: Vec<Set<usize>> = vec![];
        for &(a, b) in &state.same_character {
            let mut merged = Set::from([a, b]);
            groups.retain(|group| {
                if !group.is_disjoint(&merged) {
                    merged.extend(group);
                    false
                } else {
                    true
                }
            });
            groups.push(merged);
        }
        groups
    }
    fn group_enchant(&self, state: &Ledger, group: &Set<usize>) -> Option<u32> {
        state
            .steps
            .iter()
            .filter(|step| {
                step.destroyed > 0
                    && group.contains(&step.recipe)
                    && !self.quotes[&self.s.recipes[step.recipe].output].transferable()
            })
            .filter_map(|step| self.drops[step.recipe].as_ref().map(|d| d.skill))
            .max()
    }
    fn groups_possible(&self, ledger: &Ledger) -> bool {
        self.groups(ledger).iter().all(|group| {
            let recipes = group
                .iter()
                .map(|&idx| &self.s.recipes[idx])
                .collect::<Vec<_>>();
            professions::joint(self.s, &recipes, self.group_enchant(ledger, group)).is_some()
        })
    }

    pub fn plan(&self, index: usize) -> Option<Path> {
        let r = &self.s.recipes[index];
        if !r
            .mats
            .iter()
            .any(|(id, _)| self.choices.last().unwrap().contains_key(id))
        {
            return None;
        }
        let mut state = Ledger::default();
        let mut parents = vec![r.output];
        for &(id, count) in &r.mats {
            let mut budget = PER_REAGENT_BUDGET;
            state = self.supply(id, count, index, DEPTH, &mut parents, state, &mut budget)?;
        }
        if state.steps.is_empty() {
            return None;
        }
        let mut ready = true;
        let mut stages = vec![];
        let mut professions_used = Set::new();
        let mut expected = false;
        for step in &state.steps {
            let r = &self.s.recipes[step.recipe];
            let req = self
                .s
                .recipe_requirements
                .get(&r.id)
                .unwrap_or(&Value::Null);
            let de = self.drops[step.recipe]
                .as_ref()
                .filter(|_| step.destroyed > 0);
            let (can, advice) = professions::access(
                self.s,
                r,
                req,
                de.map(|d| d.skill),
                self.quotes[&r.output].transferable(),
            );
            if let Some(prof) = req["profession"].as_str() {
                professions_used.insert(prof);
            }
            ready &= can;
            let mats:Vec<_>=r.mats.iter().map(|(id,n)|json!({"id":id,"name":self.quotes[id].name,"quantity":u64::from(*n)*u64::from(step.runs)})).collect();
            stages.push(json!({"action":"craft","inputs":mats,"name":r.name,"item":r.output,"recipe_id":r.id,"runs":step.runs,"quantity":u64::from(step.runs)*u64::from(r.quantity),"requirements":req,"advice":advice}));
            if let Some(de) = de {
                expected = true;
                professions_used.insert("Enchanting");
                let drops:Vec<_>=de.amounts.iter().map(|(id,amount)|json!({"id":id,"name":self.quotes[id].name,"quantity":(*amount*u128::from(step.destroyed)) as f64/SCALE as f64})).collect();
                stages.push(json!({"action":"disenchant","name":r.name,"item":r.output,"quantity":step.destroyed,"outputs":drops,"skill":de.skill}));
            }
        }
        if professions_used.is_empty() {
            professions_used.insert("the intermediate recipes");
        }
        let skills = professions_used.iter().map(|s| s.to_string()).collect();
        let mut advice = format!(
            "Intermediate steps require {}.",
            professions_used.into_iter().collect::<Vec<_>>().join(", ")
        );
        let mut final_de_access = Some((true, String::new()));
        for group in self.groups(&state) {
            let recipes: Vec<&Recipe> = group.iter().map(|i| &self.s.recipes[*i]).collect();
            let (ok, note) =
                professions::joint(self.s, &recipes, self.group_enchant(&state, &group))?;
            ready &= ok;
            if group.contains(&index) && !self.quotes[&self.s.recipes[index].output].transferable()
            {
                if let Some(band) = &self.drops[index] {
                    let rank = self
                        .group_enchant(&state, &group)
                        .unwrap_or(0)
                        .max(band.skill);
                    final_de_access = professions::joint(self.s, &recipes, Some(rank));
                }
            }
            advice.push_str(&format!(
                " Bound or unconfirmed intermediates require the same crafter. {note}"
            ));
        }
        let inputs = state
            .purchases
            .iter()
            .map(|(&id, &qty)| self.quotes[&id].line(id, qty, true, false))
            .collect();
        Some(Path {
            cost: state.spend,
            inputs,
            stages,
            skills,
            ready,
            advice,
            expected,
            final_de_access,
        })
    }
}
