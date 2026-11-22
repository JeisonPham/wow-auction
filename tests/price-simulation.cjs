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

const dynamite = {
  batch: 10,
  proceeds: 3000,
  postage: 0,
  lines: [{ source: "vendor", cost: 300 }],
  yield: {
    min: 1,
    max: 5,
    base: 3,
    netPerUnit: 100,
    timing: { elapsed_seconds: 5, repeat_seconds: 5 },
  },
};
const varying = simulate(dynamite, 0);
assert.ok(Math.abs(varying.output.mean - 30) < 0.15);
assert.ok(varying.output.p5 >= 21 && varying.output.p5 <= 24);
assert.ok(varying.output.p95 >= 36 && varying.output.p95 <= 39);
assert.equal(varying.p5, 3000);
assert.ok(varying.profit.p5 < 0 && varying.profit.p95 > 0);
assert.ok(varying.profitChance > 0.44 && varying.profitChance < 0.48);
assert.equal(varying.chartMetric, "Batch profit");
let rolls = 0;
const alternating = context.simulatePrices(dynamite, 100, 0, () =>
  rolls++ % 2 ? 0.999 : 0,
);
assert.equal(rolls, 1000);
assert.equal(alternating.output.p5, 30);
assert.equal(alternating.output.p95, 30);
assert.equal(alternating.profitChance, 0);
const noQuote = simulate({ ...dynamite, proceeds: null }, 0);
assert.equal(noQuote.profit, null);
assert.ok(noQuote.output.mean > 29);
assert.throws(() =>
  simulate({ ...dynamite, yield: { ...dynamite.yield, min: 6 } }, 0),
);
const noRoll = () => {
  throw Error("Fixed yield must not draw randomly");
};
const fixedFour = context.simulatePrices(
  {
    ...dynamite,
    postage: 60,
    yield: {
      ...dynamite.yield,
      min: 4,
      max: 4,
      returnStack: 10,
      post: 20,
    },
  },
  100,
  0,
  noRoll,
);
assert.equal(fixedFour.average, 3080);
assert.equal(fixedFour.profit.mean, 920);
assert.ok(Math.abs(fixedFour.goldPerHour - 6.624) < 1e-10);
const deBatch = {
  ...dynamite,
  batch: 2,
  proceeds: 10,
  lines: [],
  yield: {
    min: 1,
    max: 3,
    base: 2,
    netPerUnit: 2.75,
    timing: {
      elapsed_seconds: 9,
      repeat_seconds: 10,
      cooldown_span: 10,
      end_de_seconds: 3,
    },
  },
};
rolls = 0;
const deResult = context.simulatePrices(deBatch, 100, 0, () =>
  rolls++ % 2 ? 0.999 : 0,
);
assert.equal(deResult.profit.mean, 10); // One piece pays 2c, three pieces pay 8c.
assert.ok(Math.abs(deResult.goldPerHour - (0.001 * 3600) / (10 + 12)) < 1e-10);
console.log(
  "Independent batch output rolls, profit range, postage and disenchant timing passed.",
);
