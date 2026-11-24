const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { indexListings, quoteShoppingBatch, quoteStacks, percentilePurchase, percentileInput } = vm.runInNewContext(
  fs.readFileSync("web/shopping.js", "utf8") +
    ";({indexListings, quoteShoppingBatch, quoteStacks, percentilePurchase, percentileInput})",
);
const ore = {
  id: 1,
  name: "Ore",
  checked_at: 100,
  lots: [
    [1, 3, 1],
    [1, 8, 5],
  ],
  listed_units: 6,
};
const dust = {
  id: 2,
  name: "Dust",
  checked_at: 100,
  lots: [[4, 15, 2]],
  listed_units: 8,
};
const vendor = { id: 3, name: "Thread", vendor_buy: 3 };
const item = {
  id: 4,
  name: "Buckle",
  vendor_sell: 90,
  checked_at: 100,
  lots: [
    [1, 100, 1],
    [1, 500, 1],
  ],
  listed_units: 2,
};
const book = indexListings([ore, dust, vendor, item]);
const route = {
  kind: "craft",
  quantity: 1,
  inputs: [ore, dust, vendor].map((item) => ({
    id: item.id,
    name: item.name,
    quantity: 2,
    source: "estimate",
  })),
};
const quote = (r = route, target = 10, cutoff = 10) =>
  quoteShoppingBatch(item, r, { batch: 1, minProfit: target }, 4, book, cutoff);
const q = quote();
assert.equal(q.profit, 54); // sale 90 less ore 11, whole stack 15, vendor 6 and mail 4.
assert.equal(q.orders[0].units, 2);
assert.equal(q.orders[1].units, 4);
assert.equal(q.orders[0].cap, 14);
assert.equal(q.orders[1].cap, 10);
assert.ok(
  q.orders.reduce((sum, o) => sum + o.units * o.cap, 0) + 6 + 4 + 10 <= q.out,
);
assert.equal(quote(route, 89).capsReady, false);
assert.equal(quote({ ...route, kind: "craft_auction" }).out, 80);
const de = {
  ...route,
  kind: "craft_disenchant",
  quantity: 2,
  outputs: [{ id: 2, quantity: 2.5 }],
};
assert.equal(quote(de).out, 7);
assert.equal(
  quote({ ...de, outputs: [{ id: 8, quantity: 1 }] }).capsReady,
  false,
);
assert.equal(quote(route, 10, 101).profit, null);
assert.equal(
  quote({ ...route, inputs: [{ ...route.inputs[0], quantity: 7 }] }).profit,
  null,
);
assert.equal(
  quoteStacks(
    [
      [8, 8, 1],
      [5, 6, 2],
    ],
    10,
  ).cost,
  12,
);
assert.equal(
  quoteStacks(
    [
      [20, 20, 1],
      [1, 2, 1],
    ],
    1,
  ).cost,
  2,
);
assert.equal(
  quoteStacks(
    [
      [1, 3, 1],
      [1, 8, 5],
    ],
    2,
  ).cost,
  11,
);
const depth = {source: "In-game item check", observed_at: 100, available: 10, levels: [[8, 3, 2], [10, 11, 1]]};
assert.equal(percentilePurchase(depth, 8, 0).budget, 12);
assert.equal(percentilePurchase(depth, 1, 90).budget, 11);
assert.equal(percentilePurchase(depth, 9, 0).budget, 99);
assert.equal(percentilePurchase(depth, 11, 0).status, "insufficient");
const material = {quantity: 1, source: "estimate"};
const entry = {purchase_depth: depth, estimate: 4, vendor_buy: 5};
const input = (n, cutoff = 90, data = entry) => percentileInput(material, data, n, 0, cutoff, true);
assert.equal(input(3).purchase_budget, 5); // Round once across the batch.
assert.equal(input(9).source, "vendor");
assert.equal(input(11).purchase_budget, 55);
assert.equal(input(11, 90, {...entry, vendor_buy: null}).purchase_budget, null);
assert.equal(input(6, 101).source, "estimate");
assert.equal(input(2, 90, {...entry, auctionable: false}).source, "vendor");
assert.equal(input(2, 90, {...entry, auctionable: false, vendor_buy: null}).source, "bound");
console.log(
  "Whole-stack and commodity pricing, shared TSM budget, auction and disenchant exits, expiry and stock checks passed.",
);
