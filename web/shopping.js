"use strict";

function indexListings(items) {
  AuctionMath.call("register", items.map(({id, checked_at, lots, listed_units, auctionable,
    vendor_buy, estimate, purchase_depth}) =>
    ({id, checked_at, lots, listed_units, auctionable, vendor_buy, estimate, purchase_depth})));
  return new Map(items.map(item => [item.id, item]));
}
function itemForPricing(item) {
  return {id:item.id, max_stack:item.max_stack, vendor_sell:item.vendor_sell};
}
function routeForPricing(route) {
  const {kind, quantity, inputs, outputs, cost, proceeds, timing, purchaseBudget, percentileMode, shopping} = route;
  return {kind, quantity, inputs, outputs, cost, proceeds, timing, purchaseBudget, percentileMode,
    shopping: shopping && {cost:shopping.cost, out:shopping.out}};
}
