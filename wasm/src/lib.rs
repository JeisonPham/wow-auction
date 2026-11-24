//! Browser calculations. A single UTF-8 JSON message crosses the Wasm boundary per operation.
use serde_json::{json, Value as V};
use std::cell::RefCell;
mod history;
mod market;
mod optimize;
mod simulation;
mod stacks;

type Result<T> = std::result::Result<T, String>;
const MAX: f64 = 9_007_199_254_740_991.0;
fn num(v: &V) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
fn uint(v: &V) -> u64 {
    v.as_u64().unwrap_or_else(|| num(v) as u64)
}
fn rows(v: &V) -> &[V] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn safe(v: f64) -> bool {
    v.abs() <= MAX && v.fract() == 0.0
}
fn ratio(a: f64, b: f64) -> Option<f64> {
    (b != 0.0).then(|| a / b)
}
fn dispatch(command: &V) -> Result<V> {
    let a = &command["args"];
    Ok(match command["op"].as_str().unwrap_or("") {
        "register" => return market::register(&a[0]),
        "simulate" => return simulation::simulate(a, false),
        "forecast" => simulation::simulate(a, true).unwrap_or_else(|_| json!({"cost":null,"proceeds":null,"profit":null,"winPercent":null,"repeatGoldPerHour":null})),
        "optimize" => return optimize::optimize(a),
        "kelly" => json!(simulation::kelly(
            &serde_json::from_value::<Vec<f64>>(a[0].clone()).map_err(|e| e.to_string())?
        )),
        "size" => simulation::size(
            &a[0],
            &serde_json::from_value::<Vec<f64>>(a[1].clone()).map_err(|e| e.to_string())?,
        ),
        "quoteStacks" => {
            let mut lots = stacks::lots(&a[0])?;
            stacks::sort(&mut lots);
            json!(stacks::quote(&lots, uint(&a[1]), 1., 1., None, 250000)
                .map(|(cost, units)| json!({"cost":cost,"units":units})))
        }
        "shopping" => market::shopping(a),
        "percentile" => market::percentile(&a[0], uint(&a[1]), uint(&a[2])),
        "input" => market::input(
            &a[0],
            &a[1],
            uint(&a[2]),
            uint(&a[3]),
            uint(&a[4]),
            a[5] == true,
        ),
        "priceRoute" => market::price_route(a),
        "summary" => market::summary(&a[0], &a[1], &a[2]),
        "bestHour" => history::best(&history::samples(&a[0]), a[1] == true),
        "chartScale" => history::chart_scale(&a[0]),
        "daily" => history::daily(a),
        "profile" => history::profile(a),
        "training" => market::training(&a[0]),
        "breakdown" => market::breakdown(&a[0], num(&a[1])),
        "lowest" => json!(stacks::lots(&a[0])?
            .iter()
            .map(|&[s, p, _]| p as f64 / s as f64)
            .reduce(f64::min)),
        _ => return Err("Unknown calculation".into()),
    })
}
thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}
// The JS caller writes only into the reserved region and copies the result before the next call.
#[no_mangle]
pub extern "C" fn reserve_input(len: usize) -> *mut u8 {
    INPUT.with_borrow_mut(|buf| {
        buf.resize(len, 0);
        buf.as_mut_ptr()
    })
}
#[no_mangle]
pub extern "C" fn calculate() -> usize {
    let result = INPUT.with_borrow(|buf| {
        serde_json::from_slice(buf)
            .map_err(|e| e.to_string())
            .and_then(|v| dispatch(&v))
    });
    OUTPUT.with_borrow_mut(|out| {
        out.clear();
        let value = match result {
            Ok(value) => json!({"result":value}),
            Err(error) => json!({"error":error}),
        };
        serde_json::to_writer(&mut *out, &value).unwrap();
        out.len()
    })
}
#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 {
    OUTPUT.with_borrow(|b| b.as_ptr())
}

// Scalar exports avoid encoding JSON for batch quantities and small UI projections.
#[no_mangle]
pub extern "C" fn batch_units(quantity: f64, batch: f64) -> f64 {
    quantity * batch
}
#[no_mangle]
pub extern "C" fn unit_value(total: f64, count: f64) -> f64 {
    total / count
}
#[no_mangle]
pub extern "C" fn gold_to_copper(gold: f64) -> f64 {
    (gold * 10000.).round()
}
#[no_mangle]
pub extern "C" fn training_runs(gold: f64, profit: f64) -> f64 {
    ((gold * 10000.).ceil() / profit).ceil()
}
#[no_mangle]
pub extern "C" fn default_target(quantity: f64, batch: f64) -> f64 {
    (quantity * batch).min(10000.)
}
#[no_mangle]
pub extern "C" fn quote_cutoff(now_ms: f64, max_age: f64) -> f64 {
    (now_ms / 1000.).floor() - max_age
}
#[no_mangle]
pub extern "C" fn chart_percent(value: f64, ceiling: f64) -> f64 {
    100. * value / ceiling
}
