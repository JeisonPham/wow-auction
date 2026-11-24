const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { timingProfile, bestHour, hourlyChart } = vm.runInNewContext(
  fs.readFileSync("web/history.js", "utf8") +
    ';timingCache.set("fixture", {});({timingProfile,bestHour,hourlyChart})',
  {money: n => n + "c", esc: String},
);
const day = 86400;
const rows = (morning, evening, n = 4) =>
  Array.from({ length: n }, (_, d) => [
    [d * day + 8 * 3600, morning, morning * 3],
    [d * day + 18 * 3600, evening, evening * 3],
  ]).flat();
const book = new Map([
  [1, { auctionable: true }],
  [3, { vendor_buy: 2 }],
]);
const inputs = [
  { id: 1, quantity: 3 },
  { id: 3, quantity: 2, source: "vendor", unit_cost: 2 },
];
const route = { kind: "craft_auction", quantity: 2, inputs };
const archived = { items: { 1: rows(2, 9), 2: rows(10, 30), 3: [] } };
const profile = (r = route, h = archived) =>
  timingProfile({ id: 2 }, r, 1, h, book);
const optimal = profile();
assert.equal(optimal.buy.winners[0].hour, 8);
assert.equal(optimal.buy.value, 10);
assert.equal(optimal.sell.winners[0].hour, 18);
assert.equal(optimal.sell.value, 48);
assert.equal(optimal.sell.winners[0].days, 4);
const de = profile({
  ...route,
  kind: "craft_disenchant",
  outputs: [
    { id: 2, quantity: 1.5 },
    { id: 1, quantity: 0.5 },
  ],
});
assert.equal(de.sell.value, 39);
assert.equal(
  profile({ ...route, kind: "craft", proceeds: 150 }).sell.value,
  150,
);
const sparse = profile(route, { items: { 1: rows(2, 9, 2), 2: [], 3: [] } });
assert.equal(sparse.buy.state, "collecting");
assert.equal(sparse.sell.state, "collecting");
const missing = profile(route, {
  items: { 1: [[8 * 3600, 4, null]], 2: rows(2, 8), 3: [] },
});
assert.equal(missing.buy.sampled.length, 0);
assert.equal(
  bestHour(
    rows(7, 7).map(([hour, v]) => [hour, v]),
    true,
  ).winners.length,
  2,
);
const chartFor = (...sides) => hourlyChart(sides.map((side, i) => [["Batch cost","Sale proceeds"][i], side]), "fixture", "recipe");
const chart = chartFor(optimal.buy, optimal.sell);
assert.equal((chart.match(/ data-best[ >]/g) || []).length, 2);
assert.match(chart, /highest sale proceeds/);
assert.doesNotMatch(chart, /class="vendor-rule/);
const early = chartFor(bestHour([[8 * 3600, 0]], false));
assert.match(early, /0c · 1 sampled day/);
assert.match(early, /style="height:0%"/);
assert.doesNotMatch(early, /data-best/);
assert.doesNotMatch(chartFor(bestHour([], false), {state:"fixed", value:null}), /hour-plot/);
assert.equal((chartFor({state:"fixed", value:0}, {state:"fixed", value:100}).match(/class="vendor-rule/g) || []).length, 2);
console.log(
  "Hourly route costs, auction and disenchant proceeds, vendor prices, ties and sparse history passed.",
);
