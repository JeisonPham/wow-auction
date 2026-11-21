pub mod catalog;
pub mod disenchant;
pub mod feed;
pub mod planner;
mod professions;
pub mod scan;
pub mod service;

pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn fresh(t: u64, now: u64, age: u64) -> bool {
    t > 0 && t <= now.saturating_add(300) && now.saturating_sub(t) <= age
}
