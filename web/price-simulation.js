"use strict";

// Box–Muller generates two independent standard normal draws per pair of uniforms.
function normalSampler(random) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const draw = spare;
      spare = null;
      return draw;
    }
    const radius = Math.sqrt(-2 * Math.log(1 - random()));
    const angle = 2 * Math.PI * random();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

// A trial repeats the displayed production plan. Only the final craft's output varies.
function productionSampler(model, random) {
  const y = model.yield;
  const { min, max, base, netPerUnit, timing, returnStack, post } = y;
  const batch = model.batch;
  if (
    ![min, max, base, batch].every((n) => Number.isSafeInteger(n) && n >= 1) ||
    min > max ||
    max > 4294967295 ||
    batch > 10000
  ) {
    throw Error(
      "Use a positive whole-number yield range with minimum ≤ maximum.",
    );
  }
  const basePayout = model.proceeds === null ? 0 : model.proceeds / batch;
  const payout = (n) =>
    n === base ? basePayout : Math.floor(n * (netPerUnit ?? 0));
  const de = timing?.end_de_seconds || 0;
  const ready = timing?.cooldown_span || 0;
  const elapsed = (n) =>
    timing ? timing.elapsed_seconds + (n - base) * de : 0;
  const normalSeconds = timing
    ? timing.elapsed_seconds + (batch - 1) * timing.repeat_seconds
    : 0;
  const postageDelta = (units) =>
    returnStack
      ? (Math.ceil(units / returnStack) -
          Math.ceil((base * batch) / returnStack)) *
        post
      : 0;
  if (min === max) {
    const units = batch * min;
    const seconds = de
      ? elapsed(min) + (batch - 1) * Math.max(ready, elapsed(min))
      : normalSeconds;
    const result = {
      units,
      proceeds: batch * payout(min),
      seconds,
      postage: postageDelta(units),
    };
    return () => result;
  }
  return () => {
    let units = 0,
      proceeds = 0,
      seconds = de ? 0 : normalSeconds;
    for (let run = 0; run < batch; run++) {
      const n = min + Math.floor(random() * (max - min + 1));
      units += n;
      proceeds += payout(n);
      if (de)
        seconds += run === batch - 1 ? elapsed(n) : Math.max(ready, elapsed(n));
    }
    return { units, proceeds, seconds, postage: postageDelta(units) };
  };
}

function quantile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lo = Math.floor(index);
  return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
}

function histogram(sorted) {
  const low = sorted[0],
    high = sorted[sorted.length - 1];
  const bins = Array(low === high ? 1 : 20).fill(0);
  for (const value of sorted) {
    const index =
      high === low
        ? 0
        : Math.floor(((value - low) / (high - low)) * bins.length);
    bins[Math.min(index, bins.length - 1)]++;
  }
  return { low, high, bins };
}

// Auction price draws scale every tier together. Reuse mixed-stack combinations
// when two trials need the same quantity and have the same usable stack counts.
function reagentPricer(line) {
  const lots = [...line.lots].sort(
    (a, b) => a[1] / a[0] - b[1] / b[0] || a[0] - b[0],
  );
  const mixed = lots.some(([size]) => size !== lots[0][0]);
  const cache = new Map();
  return (runs, price, stock) => {
    const need = runs * line.quantity;
    if (!Number.isSafeInteger(need))
      throw Error("Reagent quantity exceeds the supported range.");
    const buy = quoteListedStacks(lots, need, price, stock, line.vendor);
    if (!buy) return null;
    let spend = buy.cost;
    // Keep large baskets practical over thousands of trials by using the
    // feasible cheapest-first quote when combination search would be expensive.
    if (mixed && lots.length * need <= 10000) {
      const scaled = lots.map(([size, ask, count]) => [
        size,
        ask,
        Math.min(Math.ceil(need / size), Math.round(count * stock)),
      ]);
      const key = need + "/" + scaled.map((lot) => lot[2]).join(",");
      if (!cache.has(key)) {
        if (cache.size >= 32) cache.delete(cache.keys().next().value);
        cache.set(key, stackCombinations(scaled, need, 10000)?.costs);
      }
      const costs = cache.get(key);
      if (costs) {
        spend = Math.min(spend, costs[need] * price);
        if (line.vendor != null) {
          for (let n = 1; n < need; n++)
            spend = Math.min(
              spend,
              costs[n] * price + (need - n) * line.vendor,
            );
        }
      }
    }
    const copper = Math.ceil(spend);
    if (!Number.isSafeInteger(copper))
      throw Error("Reagent cost exceeds the supported copper range.");
    return copper;
  };
}

function simulateCraftOrder(model, trials, priceSpread, random) {
  const { target, stockSpread, lines } = model;
  const { min, max, base } = model.yield;
  if (
    !Number.isInteger(target) ||
    target < 1 ||
    target > 10000 ||
    !Number.isFinite(stockSpread) ||
    stockSpread < 0 ||
    stockSpread > 100 ||
    ![min, max, base].every(
      (n) => Number.isSafeInteger(n) && n >= 1 && n <= 4294967295,
    ) ||
    min > max
  )
    throw Error(
      "Use 1–10,000 finished pieces, a valid craft yield and a stock deviation from 0% to 100%.",
    );
  // Stock is listing count per price tier. Recipe ingredients per cast stay fixed.
  const normal = normalSampler(random);
  function priceFactor() {
    if (!priceSpread) return 1;
    let factor;
    do {
      factor = 1 + (normal() * priceSpread) / 100;
    } while (factor <= 0);
    return factor;
  }
  const prices = lines.map(reagentPricer);
  const plannedRuns = Math.ceil(target / Math.min(max, Math.max(min, base)));
  const quoted = prices.map((quote) => quote(plannedRuns, 1, 1));
  const sum = (values) => {
    const value = values.reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(value))
      throw Error("Order cost exceeds the supported copper range.");
    return value;
  };
  const current = quoted.some((n) => n == null) ? null : sum(quoted);
  const shortages = lines.map(() => 0);
  const costs = [];
  let runTotal = 0,
    average = 0;
  for (let t = 0; t < trials; t++) {
    let runs = Math.ceil(target / min);
    if (min !== max) {
      runs = 0;
      let produced = 0;
      while (produced < target) {
        produced += min + Math.floor(random() * (max - min + 1));
        runs++;
      }
    }
    runTotal += runs;
    let full = true,
      total = 0;
    for (const [j, line] of lines.entries()) {
      const auction = line.lots.length > 0;
      const stock =
        auction && stockSpread
          ? Math.max(0, 1 + (normal() * stockSpread) / 100)
          : 1;
      const cost = prices[j](runs, auction ? priceFactor() : 1, stock);
      if (cost == null) {
        shortages[j]++;
        full = false;
      } else total += cost;
    }
    if (full) {
      if (!Number.isSafeInteger(total))
        throw Error("Order cost exceeds the supported copper range.");
      costs.push(total);
      average += (total - average) / costs.length;
    }
  }
  costs.sort((a, b) => a - b);
  const result = {
    filled: costs.length,
    target,
    current,
    plannedRuns,
    runs: runTotal / trials,
    shortages,
  };
  if (costs.length)
    Object.assign(result, histogram(costs), {
      average,
      median: quantile(costs, 0.5),
      p5: quantile(costs, 0.05),
      p95: quantile(costs, 0.95),
      chartMetric: "Reagent cost",
    });
  return result;
}

// Full Kelly maximizes mean(log(1 + fraction * return)) for one route.
// Its derivative decreases with the fraction, so bisection finds the maximum.
function kellyFraction(returns) {
  const slope = (fraction) => {
    let sum = 0;
    for (const r of returns) sum += r / (1 + fraction * r);
    return sum;
  };
  if (slope(0) <= 0) return 0;
  if (slope(1) >= 0) return 1;
  let low = 0,
    high = 1;
  for (let i = 0; i < 54; i++) {
    const mid = (low + high) / 2;
    if (slope(mid) > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

function sizeBatches(model, returns) {
  const { bankroll, batch } = model;
  if (returns.some((r) => !Number.isFinite(r))) {
    return {
      unavailable:
        "Kelly sizing requires a positive batch cost in every trial.",
    };
  }
  let quote =
    model.lines.reduce((total, line) => total + line.cost, 0) * batch +
    model.postage;
  const y = model.yield;
  if (y?.returnStack) {
    // Reserve enough postage even when every cast produces the maximum.
    quote +=
      (Math.ceil((batch * y.max) / y.returnStack) -
        Math.ceil((batch * y.base) / y.returnStack)) *
      y.post;
  }
  if (!Number.isSafeInteger(quote) || quote <= 0) {
    return {
      unavailable:
        "Kelly sizing needs a positive quoted batch cost within the supported copper range.",
    };
  }
  const affordable = Math.floor(bankroll / quote);
  let available = Infinity;
  for (const line of model.lines) {
    if (line.source !== "vendor" && line.listed_units != null)
      available = Math.min(
        available,
        Math.floor(line.listed_units / (batch * line.quantity)),
      );
  }
  const fraction = kellyFraction(returns);
  const target = fraction * bankroll;
  const limit = Math.min(affordable, available);
  let batches = Math.min(limit, Math.floor(target / quote));
  // Concavity leaves only the two adjacent feasible orders to compare.
  if (batches < limit && target > batches * quote) {
    const current = (batches * quote) / bankroll;
    const step = quote / bankroll;
    let gain = 0;
    for (const r of returns) {
      if ((batches + 1) * quote === bankroll && r === -1) {
        gain = -Infinity;
        break;
      }
      gain += Math.log1p((step * r) / (1 + current * r));
    }
    if (gain > 0) batches++;
  }
  const spend = batches * quote;
  return {
    fraction,
    target: Math.round(target),
    batches,
    quote,
    spend,
    remaining: bankroll - spend,
    stockLimited: available < affordable && available * quote < target,
  };
}

function simulatePrices(model, trials, volatility, random = Math.random) {
  if (
    !Number.isInteger(trials) ||
    trials < 100 ||
    trials > 50000 ||
    !Number.isFinite(volatility) ||
    volatility < 0 ||
    volatility > 100
  ) {
    throw Error(
      "Use 100–50,000 trials and a standard deviation from 0% to 100%.",
    );
  }
  if (model.order) return simulateCraftOrder(model, trials, volatility, random);
  const normal = normalSampler(random);
  const auctionLines = model.lines.filter((line) => line.source !== "vendor");
  const vendorPerRun = model.lines.reduce(
    (sum, line) => sum + (line.source === "vendor" ? line.cost : 0),
    0,
  );
  const fixed = vendorPerRun * model.batch + model.postage;
  const outcomes = new Float64Array(trials);
  const produce = model.yield ? productionSampler(model, random) : null;
  const units = produce ? new Float64Array(trials) : null;
  const profits = model.proceeds != null ? new Float64Array(trials) : null;
  if (
    model.bankroll != null &&
    (!Number.isSafeInteger(model.bankroll) || model.bankroll < 0)
  )
    throw Error("Enter starting gold as a nonnegative amount in whole copper.");
  const returns =
    model.bankroll != null && profits && !model.unitOnly
      ? new Float64Array(trials)
      : null;
  const variable = model.yield && model.yield.min !== model.yield.max;
  let meanUnits = 0,
    meanProfit = 0,
    meanRate = 0,
    timed = 0;
  let average = 0,
    profitable = 0;
  for (let t = 0; t < trials; t++) {
    let cost = fixed;
    for (const line of auctionLines) {
      let price = line.unit_cost;
      if (volatility > 0) {
        do {
          price = line.unit_cost * (1 + (normal() * volatility) / 100);
        } while (price < 0);
      }
      // Market rows show the unit quote. Recipes round each line per craft.
      // At zero spread, retain the planner's exact integer calculation.
      if (model.unitOnly) cost = price;
      else
        cost +=
          (volatility === 0 ? line.cost : Math.ceil(price * line.quantity)) *
          model.batch;
    }
    const production = produce?.();
    if (production) {
      units[t] = production.units;
      meanUnits += (production.units - meanUnits) / (t + 1);
      cost += production.postage;
    }
    if (!Number.isFinite(cost) || cost > Number.MAX_SAFE_INTEGER)
      throw Error(
        "This total exceeds the supported copper range. Try a smaller batch.",
      );
    outcomes[t] = cost;
    average += (cost - average) / (t + 1);
    if (profits) {
      const proceeds = production ? production.proceeds : model.proceeds;
      if (!Number.isSafeInteger(proceeds))
        throw Error("Batch proceeds exceed the supported copper range.");
      const profit = proceeds - cost;
      profits[t] = profit;
      if (returns) returns[t] = cost > 0 ? profit / cost : NaN;
      meanProfit += (profit - meanProfit) / (t + 1);
      if (profit > 0) profitable++;
      if (production?.seconds > 0) {
        meanRate +=
          (((profit / 10000) * 3600) / production.seconds - meanRate) / ++timed;
      }
    }
  }

  outcomes.sort();
  units?.sort();
  profits?.sort();
  const chart = variable && profits ? profits : outcomes;
  return {
    average,
    p5: quantile(outcomes, 0.05),
    median: quantile(outcomes, 0.5),
    p95: quantile(outcomes, 0.95),
    ...histogram(chart),
    chartMetric:
      chart === profits
        ? "Batch profit"
        : model.unitOnly
          ? "Unit price"
          : "Batch cost",
    output: units
      ? {
          mean: meanUnits,
          p5: units[Math.floor((trials - 1) * 0.05)],
          p95: units[Math.ceil((trials - 1) * 0.95)],
        }
      : null,
    profit: profits
      ? {
          mean: meanProfit,
          p5: quantile(profits, 0.05),
          p95: quantile(profits, 0.95),
        }
      : null,
    goldPerHour: timed === trials ? meanRate : null,
    profitChance: profits ? profitable / trials : null,
    kelly: returns ? sizeBatches(model, returns) : null,
  };
}

self.onmessage = ({ data: { model, trials, volatility } }) => {
  try {
    if (model.order && typeof quoteListedStacks !== "function")
      importScripts("/shopping.js");
    self.postMessage({ result: simulatePrices(model, trials, volatility) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
