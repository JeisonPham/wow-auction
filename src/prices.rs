//! Planning uses the last positive price for each item. Only a live capture can establish stock.
use crate::{
    feed::{BrokerBook, Feed},
    scan::{Bundle, Price},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[repr(u8)]
pub(crate) enum Source {
    // At equal observation times prefer a local search, then a full scan, then Blizzard.
    Broker = 0,
    Public = 1,
    Desktop = 2,
    Blizzard = 3,
    Full = 4,
    Targeted = 5,
}
impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Self::Targeted => "In-game item check",
            Self::Full => "In-game full scan",
            Self::Blizzard => "Blizzard Auction House",
            Self::Desktop => "Desktop AppHelper",
            Self::Public => "Public DBRecent",
            Self::Broker => "Booty Bay Broker",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct Observation {
    pub total: u64,
    pub units: u64,
    pub at: u64,
    pub source: Source,
    pub auctions: Option<u64>,
}
impl Observation {
    fn from_scan(p: &Price, source: Source) -> Self {
        Self {
            total: p.total_buyout,
            units: p.units,
            at: p.observed_at,
            source,
            auctions: (source == Source::Desktop).then_some(p.auctions),
        }
    }
    pub fn unit(self) -> serde_json::Value {
        if self.total % self.units == 0 {
            (self.total / self.units).into()
        } else {
            (self.total as f64 / self.units as f64).into()
        }
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(transparent)]
pub(crate) struct Prices(pub BTreeMap<u32, Observation>);
impl Prices {
    pub fn valid_upload_history(&self, now: u64) -> bool {
        self.0.iter().all(|(id, p)| {
            *id > 0
                && (1..=crate::scan::MAX).contains(&p.total)
                && (1..=crate::scan::MAX).contains(&p.units)
                && (1..=now.saturating_add(300)).contains(&p.at)
                && matches!(p.source, Source::Desktop | Source::Full | Source::Targeted)
        })
    }
    pub(crate) fn observe(&mut self, id: u32, quote: Observation) {
        if self
            .0
            .get(&id)
            .is_none_or(|old| (old.at, old.source) <= (quote.at, quote.source))
        {
            self.0.insert(id, quote);
        }
    }
    pub fn include_upload(&mut self, b: &Bundle) {
        for (book, source) in [
            (&b.snapshot.estimate_prices, Source::Desktop),
            (&b.snapshot.prices, Source::Full),
        ] {
            for (&id, p) in book {
                self.observe(id, Observation::from_scan(p, source));
            }
        }
        for c in b.targeted.iter().rev() {
            for (&id, p) in &c.prices {
                let mut quote = Observation::from_scan(p, Source::Targeted);
                quote.at = c.time_for(id);
                self.observe(id, quote);
            }
        }
    }
    pub fn resolve(&self, b: Option<&Bundle>, feed: &Feed, broker: &BrokerBook) -> Self {
        let mut prices = self.clone();
        if let Some(b) = b {
            prices.include_upload(b);
        }
        for (&id, (_, price)) in &feed.items {
            prices.observe(
                id,
                Observation {
                    total: *price,
                    units: 1,
                    at: feed.observed_at(id),
                    source: Source::Public,
                    auctions: None,
                },
            );
        }
        for (&id, p) in &broker.items {
            prices.observe(
                id,
                Observation {
                    total: p.price,
                    units: 1,
                    at: p.observed_at,
                    source: Source::Broker,
                    auctions: None,
                },
            );
        }
        prices
    }
}
