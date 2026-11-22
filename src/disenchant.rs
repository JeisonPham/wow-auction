use crate::scan::{Band, Item, Snapshot};
pub fn rule<'a>(id: u32, item: &Item, s: &'a Snapshot) -> Option<(&'a Band, u32)> {
    let eligible = matches!(item.class, Some(2 | 4))
        && (2..=4).contains(&item.quality)
        && item.level > 0
        && !item.no_disenchant
        && s.non_disenchantable
            .as_ref()
            .is_some_and(|x| !x.contains(&id))
        && equip(item);
    if !eligible {
        return None;
    }
    let mut bands = s.disenchant.iter().filter(|d| {
        Some(d.class) == item.class
            && d.quality == item.quality
            && (d.min_level..=d.max_level).contains(&item.level)
    });
    let d = bands.next()?;
    let mut skill = d.skill.max(1);
    let mut conflict = false;
    for other in bands {
        skill = skill.max(other.skill);
        conflict |= other.mats != d.mats
    }
    if conflict {
        return None;
    }
    Some((d, skill))
}
pub fn proceeds(d: &Band, quote: impl Fn(u32) -> Option<(u64, u64)>) -> Option<u64> {
    proceeds_for(d, 1, quote)
}
pub fn proceeds_for(
    d: &Band,
    quantity: u32,
    quote: impl Fn(u32) -> Option<(u64, u64)>,
) -> Option<u64> {
    let total = net_per_piece(d, quote)? * num_bigint::BigInt::from(quantity);
    num_traits::ToPrimitive::to_u64(&total.to_integer())
}
pub fn net_per_piece(
    d: &Band,
    quote: impl Fn(u32) -> Option<(u64, u64)>,
) -> Option<num_rational::BigRational> {
    let mut gross = num_rational::BigRational::from_integer(0.into());
    for (id, expected) in &d.mats {
        let (price, units) = quote(*id)?;
        // Use the decimal expected yield and the original auction ratio.
        // Floating-point multiplication can round an integer payout down.
        let decimal = expected.to_string();
        let (whole, fraction) = decimal.split_once('.').unwrap_or((&decimal, ""));
        let scale = num_bigint::BigInt::from(10).pow(fraction.len() as u32);
        let amount = format!("{whole}{fraction}")
            .parse::<num_bigint::BigInt>()
            .ok()?;
        gross += num_rational::BigRational::new(amount * price, scale * units);
    }
    Some(gross * num_rational::BigRational::new(323.into(), 400.into()))
}
fn equip(i: &Item) -> bool {
    if matches!(i.inventory_slot, Some(4 | 19))
        || matches!(i.inventory_type.as_str(), "INVTYPE_BODY" | "INVTYPE_TABARD")
    {
        return false;
    }
    i.inventory_slot.is_some_and(|v| (1..=28).contains(&v))
        || matches!(
            i.inventory_type.as_str(),
            "INVTYPE_HEAD"
                | "INVTYPE_NECK"
                | "INVTYPE_SHOULDER"
                | "INVTYPE_CHEST"
                | "INVTYPE_WAIST"
                | "INVTYPE_LEGS"
                | "INVTYPE_FEET"
                | "INVTYPE_WRIST"
                | "INVTYPE_HAND"
                | "INVTYPE_FINGER"
                | "INVTYPE_TRINKET"
                | "INVTYPE_WEAPON"
                | "INVTYPE_SHIELD"
                | "INVTYPE_RANGED"
                | "INVTYPE_CLOAK"
                | "INVTYPE_2HWEAPON"
                | "INVTYPE_ROBE"
                | "INVTYPE_WEAPONMAINHAND"
                | "INVTYPE_WEAPONOFFHAND"
                | "INVTYPE_HOLDABLE"
                | "INVTYPE_THROWN"
                | "INVTYPE_RANGEDRIGHT"
                | "INVTYPE_RELIC"
        )
}
