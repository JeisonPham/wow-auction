"use strict";

// Each lot is [units per stack, buyout per stack, number of identical stacks].
// Commodity tiers arrive as individually purchasable units.
function indexListings(items) {
  return new Map(
    items.map((item) => {
      const lots = [...(item.lots || [])].sort(
        (a, b) => a[1] / a[0] - b[1] / b[0] || a[0] - b[0],
      );
      return [item.id, { ...item, lots, quotes: new Map() }];
    }),
  );
}

// Tier order stays valid when every price for an item moves by the same factor.
// Keep whole stacks intact, including when an oversized final stack is cheaper.
function quoteListedStacks(lots, need, priceFactor = 1, stockFactor = 1, vendor = null) {
  let cost = 0,
    units = 0,
    best = vendor == null ? null : { cost: vendor * need, units: need };
  for (const [size, ask, listed] of lots) {
    const price = ask * priceFactor;
    if (vendor != null && price >= vendor * size) break;
    const count = Math.round(listed * stockFactor);
    if (!count) continue;
    const remaining = need - units;
    const fill = Math.ceil(remaining / size);
    if (fill <= count) {
      const spend = cost + fill * price;
      if (!best || spend < best.cost)
        best = { cost: spend, units: units + fill * size };
    }
    const take = Math.min(count, Math.floor(remaining / size));
    cost += take * price;
    units += take * size;
    if (vendor != null) {
      const mixed = cost + (need - units) * vendor;
      if (mixed < best.cost) best = { cost: mixed, units: need };
    }
    if (units === need) break;
  }
  return best;
}

function quoteStacks(lots, need) {
  const best = quoteListedStacks(lots, need);
  if (
    !best ||
    !Number.isSafeInteger(best.cost) ||
    !Number.isSafeInteger(best.units)
  )
    return null;
  if (lots.every((lot) => lot[0] === lots[0][0])) return best;
  const combinations = stackCombinations(lots, need);
  return combinations ? { cost: combinations.costs[need], units: combinations.quantities[need] } : best;
}

function stackCombinations(lots, need, workLimit = 250000) {
  // For mixed stacks, compare combinations. Bundle identical listings in
  // powers of two so large commodity counts do not require one pass per unit.
  // Very large baskets keep the feasible whole-stack quote found above.
  const work =
    lots.reduce(
      (sum, [size, , count]) =>
        sum + Math.ceil(Math.log2(1 + Math.min(count, Math.ceil(need / size)))),
      0,
    ) * need;
  if (work > workLimit) return null;
  const costs = new Float64Array(need + 1).fill(Infinity);
  const quantities = new Float64Array(need + 1);
  costs[0] = 0;
  for (const [size, price, count] of lots) {
    let left = Math.min(count, Math.ceil(need / size));
    for (let group = 1; left; group *= 2) {
      const take = Math.min(group, left);
      left -= take;
      for (let n = need - 1; n >= 0; n--) {
        const total = costs[n] + take * price;
        const bought = quantities[n] + take * size;
        const next = Math.min(need, bought);
        if (
          total < costs[next] ||
          (total === costs[next] && bought < quantities[next])
        ) {
          costs[next] = total;
          quantities[next] = bought;
        }
      }
    }
  }
  return { costs, quantities };
}

function quoteShoppingBatch(item, route, settings, postage, book, cutoff) {
  const batch = settings.batch;
  const fresh = (entry) => entry?.checked_at > 0 && entry.checked_at >= cutoff;
  let oldest = Infinity;
  const observe = (entry) => {
    oldest = Math.min(oldest, entry.checked_at);
  };
  const askingPrice = (id) => {
    const entry = book.get(id);
    if (!fresh(entry) || !entry.lots.length) return null;
    observe(entry);
    const [size, price] = entry.lots[0];
    return price / size;
  };
  let outputs = route.outputs;
  let netUnit = item.vendor_sell;
  if (route.kind === "craft_auction") {
    const ask = askingPrice(item.id);
    netUnit = ask == null ? null : (ask * 323) / 400;
  } else if (route.kind === "craft_disenchant" || route.kind === "disenchant") {
    outputs = (outputs || []).map((output) => {
      const price = askingPrice(output.id);
      return {
        ...output,
        unit_cost: price,
        source: price == null ? "unpriced" : "checked",
      };
    });
    // Drop quantities in the report already include the planned pieces per cast.
    netUnit =
      outputs.length && outputs.every((o) => o.unit_cost != null)
        ? (outputs.reduce((sum, o) => sum + o.quantity * o.unit_cost, 0) *
            323) /
          (400 * route.quantity)
        : null;
  }
  const out =
    netUnit == null ? null : Math.floor(netUnit * route.quantity * batch);
  let fixed = postage,
    auctionCost = 0,
    issue = "",
    short = false;
  const orders = [];
  const inputs = route.inputs.map((line) => {
    const need = line.quantity * batch;
    const entry = book.get(line.id);
    const vendor = route.kind.startsWith("craft")
      ? (entry?.vendor_buy ??
        (line.source === "vendor" ? line.unit_cost : null))
      : null;
    const checked = fresh(entry);
    let bought = null;
    if (checked && line.source !== "bound" && entry.lots.length) {
      if (!entry.quotes.has(need)) {
        if (entry.quotes.size >= 64) entry.quotes.clear();
        entry.quotes.set(need, quoteStacks(entry.lots, need));
      }
      bought = entry.quotes.get(need);
    }
    let cost = null,
      source = "unpriced";
    if (vendor != null && (!bought || vendor * need <= bought.cost)) {
      source = "vendor";
      cost = vendor * need;
      fixed += cost;
    } else if (bought) {
      source = "checked";
      cost = bought.cost;
      observe(entry);
      orders.push({ id: line.id, name: line.name, vendor, ...bought });
      auctionCost += cost;
    } else {
      const insufficient = checked && entry.listed_units < need;
      short ||= insufficient;
      issue ||= insufficient
        ? "Insufficient listed quantity for " + line.name + "."
        : "A fresh listing scan is needed for " + line.name + ".";
    }
    return {
      ...line,
      source,
      cost: cost == null ? null : cost / batch,
      unit_cost: cost == null ? null : cost / need,
      listed_units: checked ? entry.listed_units : null,
    };
  });
  const cost = issue ? null : fixed + auctionCost;
  if (!Number.isSafeInteger(out))
    issue ||= "A current sale value is needed for the output.";
  if (cost != null && !Number.isSafeInteger(cost))
    issue ||= "Batch cost exceeds the supported copper range.";
  const profit = issue ? null : out - cost;
  const budget = issue ? 0 : out - fixed - settings.minProfit;
  // Reserve the target only once. Allocate the shared budget in proportion to
  // observed spend, rounding each unit ceiling DOWN to a whole copper.
  if (budget > 0 && auctionCost > 0) {
    const needsFloor = orders.some(
      (o) =>
        BigInt(budget) * BigInt(o.cost) < BigInt(auctionCost) * BigInt(o.units),
    );
    const totalUnits = orders.reduce((sum, o) => sum + o.units, 0);
    const floor = needsFloor && totalUnits <= budget ? 1 : 0;
    const shared = BigInt(budget - floor * totalUnits);
    for (const order of orders) {
      order.cap =
        floor +
        Number(
          (shared * BigInt(order.cost)) /
            (BigInt(auctionCost) * BigInt(order.units)),
        );
      if (order.vendor != null) order.cap = Math.min(order.cap, order.vendor);
      order.available = book
        .get(order.id)
        .lots.reduce(
          (sum, [size, price, count]) =>
            BigInt(price) <= BigInt(order.cap) * BigInt(size)
              ? sum + size * count
              : sum,
          0,
        );
    }
  }
  const capsReady =
    !issue && orders.length > 0 && orders.every((o) => o.cap > 0);
  return {
    inputs,
    outputs,
    netUnit,
    out,
    cost,
    profit,
    orders,
    capsReady,
    issue,
    short,
    oldest: Number.isFinite(oldest) ? oldest : null,
  };
}

// The server orders levels by exact unit price and publishes cumulative unit ranks.
function percentilePurchase(depth, need, floor) {
  if (!depth) return { status: "no_depth" };
  if (need > depth.available) return { status: "insufficient" };
  if (!depth.levels.length) return { status: "no_price_levels" };
  const rank = Math.max(need, Number((BigInt(depth.available) * BigInt(floor) + 99n) / 100n));
  let lo = 0, hi = depth.levels.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (depth.levels[mid][0] < rank) lo = mid + 1;
    else hi = mid;
  }
  const [, total, size] = depth.levels[lo];
  const budget = Number((BigInt(total) * BigInt(need) + BigInt(size) - 1n) / BigInt(size));
  if (!Number.isSafeInteger(budget)) return { status: "budget_overflow" };
  return { status: "priced", unit: total / size, budget, percentile: (100 * rank) / depth.available };
}

function percentileInput(line, entry, batch, floor, cutoff, craft) {
  const need = line.quantity * batch;
  const depth = entry?.purchase_depth?.observed_at >= cutoff ? entry.purchase_depth : null;
  const quote = percentilePurchase(depth, need, floor);
  const bound = line.source === "bound" || entry?.auctionable === false;
  const fallback = ["no_depth", "no_price_levels"].includes(quote.status);
  let unit = bound ? null : (quote.unit ?? (fallback ? entry?.estimate : null) ?? null);
  let budget = unit == null ? null : (quote.budget ?? Math.ceil(need * unit));
  const vendor = craft ? (entry?.vendor_buy ?? (line.source === "vendor" ? line.unit_cost : null)) : null;
  let source = quote.status === "priced" ? "percentile" : "estimate";
  if (vendor != null && (budget == null || vendor * need <= budget)) {
    unit = vendor;
    budget = vendor * need;
    source = "vendor";
  } else if (unit == null) {
    source = bound ? "bound" : "unpriced";
  }
  return { ...line, source, unit_cost: unit, cost: Number.isSafeInteger(budget) ? budget / batch : null,
    purchase_budget: Number.isSafeInteger(budget) ? budget : null, listed_units: depth?.available ?? null,
    depth, percentile: quote.percentile, quote_status: quote.status };
}
