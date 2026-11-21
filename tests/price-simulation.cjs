// Run with node tests/price-simulation.cjs. A seeded sampler keeps distribution checks repeatable.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const context = vm.createContext({ self: {} });
vm.runInContext(fs.readFileSync("web/price-simulation.js", "utf8"), context);
function seeded(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
const unit = {
  unitOnly: true,
  batch: 1,
  postage: 0,
  proceeds: null,
  lines: [{ unit_cost: 100, quantity: 1, source: "estimate" }],
};
const simulate = (model, sigma) =>
  context.simulatePrices(model, 30000, sigma, seeded(123));
// With a 10% spread, negative draws have negligible probability.
const normal = simulate(unit, 10);
assert.ok(Math.abs(normal.average - 100) < 0.3);
assert.ok(Math.abs(normal.p5 - 83.55) < 0.5);
assert.ok(Math.abs(normal.p95 - 116.45) < 0.5);
assert.equal(
  normal.bins.reduce((a, b) => a + b, 0),
  30000,
);
assert.equal(normal.profitChance, null);
const wide = simulate(unit, 100);
assert.ok(wide.low >= 0 && wide.high > 400);
assert.ok(Math.abs(wide.average - 128.76) < 1.5);
const craft = {
  unitOnly: false,
  batch: 2,
  postage: 30,
  proceeds: 200,
  lines: [
    { source: "checked", unit_cost: 5.5, cost: 17, quantity: 3 },
    { source: "vendor", unit_cost: 4, cost: 8, quantity: 2 },
  ],
};
const fixed = simulate(craft, 0);
assert.equal(fixed.low, 80);
assert.equal(fixed.high, 80);
assert.equal(fixed.profitChance, 1);
assert.equal(simulate({ ...craft, proceeds: 80 }, 0).profitChance, 0);
const half = simulate({ ...craft, proceeds: 80 }, 10);
assert.ok(half.profitChance > 0.35 && half.profitChance < 0.45);
assert.throws(() => context.simulatePrices(craft, 0, 10));
assert.throws(() => context.simulatePrices(craft, 100, -1));
console.log(
  "Normal price draws, nonnegative sampling, percentiles and batch costs passed.",
);
