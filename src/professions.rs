use crate::{
    catalog::FOREVER,
    scan::{Recipe, Snapshot},
};
use serde_json::Value;
use std::collections::BTreeSet;

const PRIMARY: [&str; 9] = [
    "Alchemy",
    "Blacksmithing",
    "Enchanting",
    "Engineering",
    "Herbalism",
    "Leatherworking",
    "Mining",
    "Skinning",
    "Tailoring",
];

fn number(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_str()?.parse().ok())
}

fn craft_level_floor(req: &Value) -> Option<u64> {
    let skill_level = req["profession"]
        .as_str()
        .and_then(|p| FOREVER.rank_level(p, number(&req["skill"])?));
    skill_level
        .max(number(&req["character_level"]))
        .max(number(&req["pattern_character_level"]))
        .max(number(&req["pattern_quest_level"]))
        .filter(|&level| level > 0)
}

fn craft_level(req: &Value) -> Option<u64> {
    if !req["pattern"].is_null() || !req["pattern_id"].is_null() {
        // A verified zero means using the pattern requires no character level.
        // Missing data cannot establish that the character can learn this recipe.
        number(&req["pattern_character_level"])?;
    }
    craft_level_floor(req)
}

pub fn route_level(route: &Value) -> Option<u64> {
    let enchanting = |skill: &Value| FOREVER.rank_level("Enchanting", number(skill)?);
    let mut level = match route["kind"].as_str()? {
        "vendor" => 1,
        "disenchant" => enchanting(&route["requirements"]["skill"])?,
        "craft" | "craft_auction" => craft_level(&route["requirements"])?,
        "craft_disenchant" => {
            craft_level(&route["requirements"])?.max(enchanting(&route["enchanting_rank"])?)
        }
        _ => return None,
    };
    for stage in route["stages"].as_array().into_iter().flatten() {
        let stage_level = match stage["action"].as_str()? {
            "craft" => craft_level(&stage["requirements"])?,
            "disenchant" => enchanting(&stage["skill"])?,
            _ => return None,
        };
        level = level.max(stage_level);
    }
    Some(level)
}

struct Need<'a> {
    name: &'a str,
    skill: u64,
    recipe: Option<&'a Recipe>,
    category: &'a str,
    level: u64,
}
impl Need<'_> {
    fn target(&self) -> String {
        if self.skill > 0 {
            format!("{} {}", self.name, self.skill)
        } else {
            self.name.into()
        }
    }
    fn enchanting(rank: u32) -> Self {
        Self {
            name: "Enchanting",
            skill: rank.into(),
            recipe: None,
            category: "primary",
            level: 0,
        }
    }
}

// Order costs lexicographically so a ready character or a free slot wins over replacing a profession.
#[derive(Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Cost {
    replacements: usize,
    uncertain_slots: usize,
    unknown_class: usize,
    new_profs: usize,
    steps: usize,
    ranks: u64,
}
impl std::ops::Add for Cost {
    type Output = Self;
    fn add(self, b: Self) -> Self {
        Self {
            replacements: self.replacements + b.replacements,
            uncertain_slots: self.uncertain_slots + b.uncertain_slots,
            unknown_class: self.unknown_class + b.unknown_class,
            new_profs: self.new_profs + b.new_profs,
            steps: self.steps + b.steps,
            ranks: self.ranks + b.ranks,
        }
    }
}
struct Plan<'a> {
    name: &'a str,
    cost: Cost,
    advice: String,
}
fn targets(needs: &[&Need]) -> String {
    needs
        .iter()
        .map(|need| need.target())
        .collect::<Vec<_>>()
        .join(" and ")
}
fn for_character<'a>(s: &Snapshot, name: &'a str, needs: &[&Need]) -> Plan<'a> {
    let profs = s.professions.get(name);
    let mut held: BTreeSet<&str> = profs
        .into_iter()
        .flat_map(|p| p.keys())
        .map(String::as_str)
        .filter(|p| PRIMARY.contains(p))
        .collect();
    let mut missing = BTreeSet::new();
    let mut steps = vec![];
    let mut cost = Cost::default();
    for n in needs {
        let rank = profs.and_then(|p| p.get(n.name)).copied().unwrap_or(0);
        let known = n
            .recipe
            .is_some_and(|r| r.characters.iter().any(|who| who == name))
            && (rank > 0 || !s.complete_rosters.contains(name) || !PRIMARY.contains(&n.name));
        if known {
            if PRIMARY.contains(&n.name) {
                held.insert(n.name);
            }
            continue;
        }
        if rank == 0 {
            if n.category == "class" {
                cost.unknown_class += 1;
                steps.push(format!("confirm class eligibility for {}", n.target()));
            } else {
                steps.push(format!("train {}", n.target()));
            }
            if PRIMARY.contains(&n.name) {
                missing.insert(n.name);
            }
        } else if u64::from(rank) < n.skill {
            cost.ranks += n.skill - u64::from(rank);
            steps.push(format!("level {} from {rank} to {}", n.name, n.skill));
        }
        if n.level > 0
            && s.character_levels
                .get(name)
                .copied()
                .map(u64::from)
                .unwrap_or(0)
                < n.level
        {
            steps.push(format!("reach character level {}", n.level));
        }
        if n.recipe.is_some() {
            if n.skill == 0 {
                steps.push("confirm the required skill in game".into());
            }
            steps.push("check or learn the recipe".into());
        }
    }
    cost.replacements = held.union(&missing).count().saturating_sub(2);
    cost.uncertain_slots = usize::from(
        !missing.is_empty() && !s.complete_rosters.contains(name) && cost.replacements == 0,
    );
    cost.new_profs = missing.len();
    cost.steps = steps.len();
    let advice = if steps.is_empty() {
        format!("{name} is ready.")
    } else if cost.replacements > 0 {
        format!("Use or level an alt with {} to keep {}'s {}. Using {name} would require replacing {} primary profession(s). Then {}.",targets(needs),name,held.iter().copied().collect::<Vec<_>>().join(" and "),cost.replacements,steps.join(", "))
    } else if cost.uncertain_slots > 0 {
        format!(
            "Check {name}'s open primary slots with /wamsync roster, then {}.",
            steps.join(", ")
        )
    } else {
        format!("{name} can {}.", steps.join(", "))
    };
    Plan { name, cost, advice }
}
fn choose(s: &Snapshot, needs: &[&Need], split: bool) -> (bool, String) {
    let mut names: BTreeSet<&str> = s
        .professions
        .keys()
        .chain(s.character_levels.keys())
        .map(String::as_str)
        .collect();
    for n in needs {
        if let Some(r) = n.recipe {
            names.extend(r.characters.iter().map(String::as_str));
        }
    }
    let Some(mut best) = names
        .iter()
        .map(|name| for_character(s, name, needs))
        .min_by_key(|p| p.cost)
    else {
        return (false,format!("Requires {}. Capture each character with /wamsync roster to see whether an alt is needed.",targets(needs)));
    };
    if split {
        // The two best choices per role suffice because only the other character is excluded.
        let options = |role| {
            let mut plans = names
                .iter()
                .map(|name| for_character(s, name, &[role]))
                .collect::<Vec<_>>();
            plans.sort_by_key(|p| p.cost);
            plans.truncate(2);
            plans
        };
        let crafters = options(needs[0]);
        let enchanters = options(needs[1]);
        for a in &crafters {
            for b in &enchanters {
                let cost = a.cost + b.cost;
                if a.name != b.name && cost < best.cost {
                    best = Plan {
                        name: a.name,
                        cost,
                        advice: format!("Crafting: {} Disenchanting: {}", a.advice, b.advice),
                    };
                }
            }
        }
        if best.cost.replacements > 0 {
            // A new character doing only the missing job can receive tradeable gear.
            let roles = [
                (crafters.first(), needs[1], "disenchant"),
                (enchanters.first(), needs[0], "craft"),
            ];
            if let Some((current, missing, job)) = roles
                .into_iter()
                .filter_map(|(p, n, job)| Some((p?, n, job)))
                .filter(|(p, _, _)| p.cost.replacements == 0 && p.cost.uncertain_slots == 0)
                .min_by_key(|(p, _, _)| p.cost)
            {
                return (false,format!("{} Use or level an alt with {} to {job} and keep the current professions. Keeping both jobs on the same character would require a profession change.",current.advice,missing.target()));
            }
        }
    }
    (best.cost.steps == 0, best.advice)
}
pub fn disenchanter(s: &Snapshot, rank: u32) -> (bool, String) {
    choose(s, &[&Need::enchanting(rank)], false)
}
fn craft_need<'a>(r: &'a Recipe, req: &'a Value) -> Need<'a> {
    Need {
        name: req["profession"]
            .as_str()
            .unwrap_or("the crafting profession"),
        skill: req["skill"].as_u64().unwrap_or(0),
        category: req["category"].as_str().unwrap_or("primary"),
        level: craft_level_floor(req).unwrap_or(0),
        recipe: Some(r),
    }
}

pub fn slot_advice(s: &Snapshot, skills: &BTreeSet<&str>) -> String {
    let primary: BTreeSet<_> = skills
        .iter()
        .copied()
        .filter(|name| PRIMARY.contains(name))
        .collect();
    if primary.is_empty() {
        return String::new();
    }
    let minimum = primary.len().div_ceil(2);
    let mut notes = vec![];
    if minimum > 1 {
        notes.push(format!(
            "This path needs at least {minimum} characters for {}.",
            primary.iter().copied().collect::<Vec<_>>().join(", ")
        ));
    }
    if !s.professions.is_empty()
        && s.professions
            .keys()
            .chain(s.character_levels.keys())
            .all(|name| s.complete_rosters.contains(name))
    {
        let learned: BTreeSet<_> = s
            .professions
            .values()
            .flat_map(|p| p.keys().map(String::as_str))
            .collect();
        let missing: Vec<_> = primary.difference(&learned).copied().collect();
        let open: usize = s
            .professions
            .values()
            .map(|p| {
                2usize.saturating_sub(p.keys().filter(|n| PRIMARY.contains(&n.as_str())).count())
            })
            .sum();
        let slots = missing.len().saturating_sub(open);
        if slots > 0 {
            let alts = slots.div_ceil(2);
            notes.push(format!("Your recorded characters have {open} free primary slots. Keeping their professions takes at least {alts} additional character(s) to cover the missing skills ({}). Switching would require freeing {slots} slot(s).",missing.join(", ")));
        }
    }
    notes.join(" ")
}

pub fn joint(s: &Snapshot, recipes: &[&Recipe], enchant: Option<u32>) -> Option<(bool, String)> {
    let mut needs: Vec<_> = recipes
        .iter()
        .map(|r| craft_need(r, s.recipe_requirements.get(&r.id).unwrap_or(&Value::Null)))
        .collect();
    if let Some(rank) = enchant {
        needs.push(Need::enchanting(rank));
    }
    if needs
        .iter()
        .map(|n| n.name)
        .filter(|p| PRIMARY.contains(p))
        .collect::<BTreeSet<_>>()
        .len()
        > 2
    {
        return None;
    }
    Some(choose(s, &needs.iter().collect::<Vec<_>>(), false))
}
pub fn access(
    s: &Snapshot,
    r: &Recipe,
    req: &Value,
    enchant: Option<u32>,
    transferable: bool,
) -> (bool, String) {
    let craft = craft_need(r, req);
    let Some(rank) = enchant else {
        return choose(s, &[&craft], false);
    };
    if craft.name == "Enchanting" && (rank == 1 || craft.skill >= rank.into()) {
        return choose(s, &[&craft], false);
    }
    let (ready, advice) = choose(s, &[&craft, &Need::enchanting(rank)], transferable);
    if transferable {
        (ready, advice)
    } else {
        (
            ready,
            format!("Plan for the crafter to disenchant the output. {advice}"),
        )
    }
}
