// Run with node tests/price-simulation.cjs. A seeded sampler keeps distribution checks repeatable.
const assert = require("node:assert/strict");
const {engine} = require("./wasm.cjs");
const context = {
  simulatePrices: (model, trials, sigma, seed = 123) => engine.call("simulate", model, trials, sigma, seed),
  kellyFraction: returns => engine.call("kelly", returns),
  sizeBatches: (model, returns) => engine.call("size", model, returns),
};
const unit = {
  unitOnly: true,
  batch: 1,
  postage: 0,
  proceeds: null,
  lines: [{ unit_cost: 100, quantity: 1, source: "estimate" }],
};
const simulate = (model, sigma) =>
  context.simulatePrices(model, 30000, sigma, 123);
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
assert.deepEqual(simulate(dynamite, 0), varying); // Seeded Wasm runs are reproducible.
const noQuote = simulate({ ...dynamite, proceeds: null }, 0);
assert.equal(noQuote.profit, null);
assert.ok(noQuote.output.mean > 29);
assert.throws(() =>
  simulate({ ...dynamite, yield: { ...dynamite.yield, min: 6 } }, 0),
);
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
  42,
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
const deResult = simulate(deBatch, 0);
const possible = [1,2,3].flatMap(a => [1,2,3].map(b => {
  const profit = [0,2,5,8][a] + [0,2,5,8][b];
  return {profit, rate: profit * 0.36 / (Math.max(10, 9 + (a-2)*3) + 9 + (b-2)*3)};
}));
assert.ok(Math.abs(deResult.profit.mean - possible.reduce((v,x)=>v+x.profit,0)/9) < 0.05);
assert.ok(Math.abs(deResult.goldPerHour - possible.reduce((v,x)=>v+x.rate,0)/9) < 0.001);
console.log(
  "Independent batch output rolls, profit range, postage and disenchant timing passed.",
);

// Three wins and two total losses at even odds have full Kelly 20%.
const binary = [1, -1, 1, -1, 1];
assert.ok(Math.abs(context.kellyFraction(binary) - 0.2) < 1e-12);
assert.equal(context.kellyFraction([0, 0]), 0);
assert.equal(context.kellyFraction([-0.8, 0.3]), 0);
assert.equal(context.kellyFraction([2, 0.5, -0.1]), 1);
const order = {
  batch: 1,
  bankroll: 100,
  postage: 0,
  lines: [{ source: "checked", cost: 30, quantity: 1 }],
};
const sized = context.sizeBatches(order, binary);
assert.equal(sized.target, 20);
assert.equal(sized.batches, 1); // 30% has better log growth than sitting out.
assert.equal(sized.spend, 30);
assert.equal(sized.remaining, 70);
assert.equal(
  context.sizeBatches({ ...order, bankroll: 30 }, binary).batches,
  0,
); // Ruin on a loss.
assert.equal(context.sizeBatches({ ...order, bankroll: 0 }, [1, 1]).batches, 0);
assert.equal(
  context.sizeBatches({ ...order, bankroll: 29 }, [1, 1]).batches,
  0,
);
assert.equal(context.sizeBatches(order, [-0.1, -0.8]).spend, 0);
const constrained = {
  ...order,
  batch: 2,
  bankroll: 1000,
  postage: 10,
  lines: [
    { source: "checked", cost: 30, quantity: 2, listed_units: 9 },
    { source: "vendor", cost: 5, quantity: 1, listed_units: 0 },
  ],
  yield: { min: 1, max: 5, base: 2, post: 10, returnStack: 4 },
};
const capped = context.sizeBatches(constrained, [1, 1]);
assert.equal(capped.quote, 100); // 70c inputs, 10c postage, 20c maximum extra return postage.
assert.equal(capped.batches, 2);
assert.equal(capped.stockLimited, true);
assert.equal(capped.spend, 200);

// Independent calls with the same seed produce the same per-trial percentage return.
const kellyCraft = {...order, bankroll:10000, proceeds:96, lines:[{source:"estimate",unit_cost:100,cost:100,quantity:1}]};
const paired = context.simulatePrices(kellyCraft, 5000, 30, 123);
assert.ok(Math.abs(paired.kelly.fraction - 0.589956641387918) < 1e-9);
assert.equal(paired.kelly.spend, paired.kelly.batches * paired.kelly.quote);
assert.equal(simulate(unit, 0).kelly, null);
assert.equal(simulate({ ...kellyCraft, proceeds: null }, 0).kelly, null);
assert.match(
  simulate({ ...kellyCraft, lines: [] }, 0).kelly.unavailable,
  /positive batch cost/,
);
assert.throws(
  () => simulate({ ...kellyCraft, bankroll: 1.5 }, 0),
  /whole copper/,
);
console.log(
  "Kelly return pairing, log-optimal sizing, full losses, affordability, postage and stock caps passed.",
);

const targetOrder = {
  order: true, target: 7, yield: {min: 2, max: 2, base: 2}, stockSpread: 0,
  lines: [{quantity: 2, vendor: null, lots: [[1, 23, 4], [3, 15, 2]]}],
};
const targetSim = (model, spread = 0) => context.simulatePrices(model, 5000, spread, 678);
const full = targetSim(targetOrder);
assert.equal(full.current, 76); // Four casts need eight units: both 3-stacks and two singles.
assert.equal(full.median, 76);
assert.equal(full.runs, 4);
assert.equal(full.filled, 5000);
const empty = targetSim({...targetOrder, target: 11});
assert.equal(empty.filled, 0);
assert.equal(empty.current, null);
assert.equal(empty.p5, undefined);
assert.equal(empty.shortages[0], 5000);
const mixed = targetSim({...targetOrder, lines: [{quantity: 2, vendor: 8, lots: [[3, 15, 2], [1, 23, 4]]}]});
assert.equal(mixed.current, 46); // Six at auction plus two from the vendor.
const varyingStock = targetSim({...targetOrder, stockSpread: 65});
assert.ok(varyingStock.filled > 0 && varyingStock.filled < 5000);
assert.equal(varyingStock.bins.reduce((a,b) => a+b), varyingStock.filled);
assert.ok(varyingStock.p5 < varyingStock.p95);
assert.equal(varyingStock.shortages[0] + varyingStock.filled, 5000);
const varyingPrices = targetSim(targetOrder, 20);
assert.equal(varyingPrices.filled, 5000);
assert.ok(varyingPrices.p5 < full.current && varyingPrices.p95 > full.current);
const varyingYield = targetSim({...targetOrder, yield: {min: 1, max: 5, base: 3},
  lines: [{quantity: 1, vendor: 10, lots: []}]}, 100);
assert.ok(varyingYield.runs > 2 && varyingYield.runs < 4);
assert.ok(varyingYield.p5 < varyingYield.p95);
assert.equal(varyingYield.filled, 5000);
assert.equal(varyingYield.current, 30);
assert.throws(() => targetSim({...targetOrder, target: 0}));
assert.throws(() => targetSim({...targetOrder, stockSpread: -1}));
console.log("Target pieces, whole stacks, variable yield, independent market spreads, vendor top-ups and conditional costs passed.");
