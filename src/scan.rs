use crate::Result;
use flate2::{bufread::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap as Map, BTreeSet as Set},
    io::{Read, Write},
};
pub const MAX: u64 = (1 << 53) - 1;
pub const COMPRESSED: usize = 32 << 20;
pub type Book = Map<u32, Price>;

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
pub struct Price {
    pub total_buyout: u64,
    pub units: u64,
    pub auctions: u64,
    pub observed_at: u64,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Item {
    pub name: String,
    pub vendor_sell: Option<u64>,
    pub vendor_buy: Option<u64>,
    pub max_stack: Option<u64>,
    pub level: u32,
    pub class: Option<u32>,
    pub quality: u32,
    pub inventory_slot: Option<u32>,
    pub inventory_type: String,
    pub no_disenchant: bool,
    pub binding: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub output: u32,
    pub quantity: u32,
    pub mats: Vec<(u32, u32)>,
    #[serde(default)]
    pub characters: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Band {
    pub class: u32,
    pub quality: u32,
    pub min_level: u32,
    pub max_level: u32,
    #[serde(default)]
    pub skill: u32,
    pub mats: Map<u32, f64>,
}
#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Snapshot {
    pub newest_price_at: u64,
    pub prices: Book,
    pub estimate_at: u64,
    pub estimate_prices: Book,
    pub items: Map<u32, Item>,
    pub tsm_item_count: Option<usize>,
    pub recipes: Vec<Recipe>,
    pub recipe_requirements: Map<String, Value>,
    pub professions: Map<String, Map<String, u32>>,
    pub character_levels: Map<String, u32>,
    pub complete_rosters: Set<String>,
    pub disenchant: Vec<Band>,
    pub non_disenchantable: Option<Set<u32>>,
    pub local_scan_failed: bool,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Capture {
    pub captured_at: u64,
    #[serde(default)]
    pub prices: Book,
    pub listed_units: Map<u32, u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Bundle {
    pub version: u32,
    pub region: String,
    pub market: String,
    pub revision: u64,
    pub snapshot: Snapshot,
    #[serde(default)]
    pub targeted: Vec<Capture>,
}
fn check(ok: bool, msg: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(msg.into())
    }
}
fn book(b: &Book, time: u64, desktop: bool, now: u64) -> Result<()> {
    check(
        b.len() <= 500000 && (time > 0 || b.is_empty()) && time <= now + 300,
        "invalid price book time or size",
    )?;
    for (id, p) in b {
        check(
            *id > 0
                && p.total_buyout > 0
                && p.total_buyout <= MAX
                && p.units > 0
                && p.units <= MAX
                && p.auctions <= MAX
                && p.observed_at == time
                && if desktop {
                    p.units == 1
                } else {
                    p.auctions > 0 && p.auctions <= p.units
                },
            "invalid price record",
        )?
    }
    Ok(())
}
// Deserialize to a unique-key tree first. Serde normally replaces duplicate map entries.
struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        use serde::de::{Error, MapAccess, SeqAccess, Visitor};
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Unique;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "a JSON value")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut v = serde_json::Map::new();
                while let Some((k, Unique(x))) = a.next_entry::<String, Unique>()? {
                    if v.insert(k, x).is_some() {
                        return Err(A::Error::custom("duplicate key"));
                    }
                }
                Ok(Unique(v.into()))
            }
            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut v = vec![];
                while let Some(Unique(x)) = a.next_element()? {
                    v.push(x)
                }
                Ok(Unique(v.into()))
            }
            fn visit_u64<E: Error>(self, x: u64) -> std::result::Result<Unique, E> {
                Ok(Unique(x.into()))
            }
            fn visit_i64<E: Error>(self, x: i64) -> std::result::Result<Unique, E> {
                Ok(Unique(x.into()))
            }
            fn visit_f64<E: Error>(self, x: f64) -> std::result::Result<Unique, E> {
                Ok(Unique(x.into()))
            }
            fn visit_str<E: Error>(self, x: &str) -> std::result::Result<Unique, E> {
                Ok(Unique(x.into()))
            }
            fn visit_bool<E: Error>(self, x: bool) -> std::result::Result<Unique, E> {
                Ok(Unique(x.into()))
            }
            fn visit_unit<E: Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
        }
        d.deserialize_any(V)
    }
}
pub fn decode(data: &[u8], region: &str, market: &str, now: u64) -> Result<Bundle> {
    check(data.len() <= COMPRESSED, "compressed limit exceeded")?;
    let mut gz = GzDecoder::new(data);
    let mut raw = vec![];
    (&mut gz)
        .take((128 << 20) + 1)
        .read_to_end(&mut raw)
        .map_err(|e| e.to_string())?;
    check(
        raw.len() <= 128 << 20 && gz.into_inner().is_empty(),
        "expanded limit or trailing gzip data",
    )?;
    let Unique(value) = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    check(value["snapshot"].is_object(), "expected a snapshot object")?;
    // Reject aliases such as "01" and "1" before converting map keys to u32.
    let canonical_ids = |map: &Value| -> Result<()> {
        if let Some(map) = map.as_object() {
            for key in map.keys() {
                let id = key.parse::<u32>().map_err(|_| "invalid item ID")?;
                check(id > 0 && id.to_string() == *key, "invalid item ID spelling")?;
            }
        }
        Ok(())
    };
    for field in ["items", "prices", "estimate_prices"] {
        canonical_ids(&value["snapshot"][field])?;
    }
    if let Some(captures) = value["targeted"].as_array() {
        for cap in captures {
            canonical_ids(&cap["prices"])?;
            canonical_ids(&cap["listed_units"])?;
        }
    }
    if let Some(bands) = value["snapshot"]["disenchant"].as_array() {
        for band in bands {
            canonical_ids(&band["mats"])?;
        }
    }
    let mut b: Bundle = serde_json::from_value(value).map_err(|e| e.to_string())?;
    check(
        b.version == 1
            && b.region == region
            && b.market == market
            && (1..=MAX).contains(&b.revision),
        "version, scope or revision mismatch",
    )?;
    let s = &mut b.snapshot;
    check(
        !s.local_scan_failed && s.warnings.is_empty(),
        "partial scan",
    )?;
    book(&s.prices, s.newest_price_at, false, now)?;
    book(&s.estimate_prices, s.estimate_at, true, now)?;
    check(
        s.items.len() <= 500000 && s.tsm_item_count.unwrap_or(s.items.len()) == s.items.len(),
        "invalid item count",
    )?;
    s.tsm_item_count = Some(s.items.len());
    for (id, i) in &s.items {
        check(
            *id > 0
                && i.vendor_buy.unwrap_or(0) <= MAX
                && i.vendor_sell.unwrap_or(0) <= MAX
                && (1..=MAX).contains(&i.max_stack.unwrap_or(1)),
            "invalid item metadata",
        )?
    }
    check(
        s.recipes.len() <= 50000 && b.targeted.len() <= 128,
        "too many recipes or captures",
    )?;
    let mut ids = Set::new();
    for r in &s.recipes {
        let mut mats = Set::new();
        check(
            !r.id.is_empty()
                && ids.insert(&r.id)
                && r.quantity > 0
                && r.output > 0
                && !r.mats.is_empty()
                && r.mats
                    .iter()
                    .all(|(id, q)| *id > 0 && *q > 0 && mats.insert(id)),
            "invalid recipe",
        )?
    }
    for d in &s.disenchant {
        check(
            d.min_level <= d.max_level
                && !d.mats.is_empty()
                && d.mats
                    .iter()
                    .all(|(id, q)| *id > 0 && *q > 0. && *q <= MAX as f64),
            "invalid yield band",
        )?
    }
    for c in &b.targeted {
        check(
            c.captured_at > 0 && c.listed_units.len() <= 100000,
            "invalid targeted capture",
        )?;
        book(&c.prices, c.captured_at, false, now)?;
        check(
            c.listed_units
                .iter()
                .all(|(id, n)| *id > 0 && *n == c.prices.get(id).map_or(0, |p| p.units))
                && c.prices.keys().all(|id| c.listed_units.contains_key(id)),
            "targeted coverage mismatch",
        )?
    }
    b.targeted.sort_by_key(|c| std::cmp::Reverse(c.captured_at));
    Ok(b)
}
pub fn encode(b: &Bundle) -> Result<Vec<u8>> {
    let mut gz = GzEncoder::new(vec![], Compression::fast());
    serde_json::to_writer(&mut gz, b).map_err(|e| e.to_string())?;
    gz.flush().map_err(|e| e.to_string())?;
    gz.finish().map_err(|e| e.to_string())
}
impl Bundle {
    pub fn times(&self) -> [u64; 3] {
        [
            self.snapshot.newest_price_at,
            self.snapshot.estimate_at,
            self.targeted.first().map_or(0, |c| c.captured_at),
        ]
    }
}
