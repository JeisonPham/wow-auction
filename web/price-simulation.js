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
  const low = chart[0],
    high = chart[trials - 1];
  const bins = Array(low === high ? 1 : 20).fill(0);
  for (const cost of chart) {
    const bin =
      high === low
        ? 0
        : Math.floor(((cost - low) / (high - low)) * bins.length);
    bins[Math.min(bin, bins.length - 1)]++;
  }
  return {
    average,
    p5: quantile(outcomes, 0.05),
    median: quantile(outcomes, 0.5),
    p95: quantile(outcomes, 0.95),
    low,
    high,
    bins,
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
  };
}

self.onmessage = ({ data: { model, trials, volatility } }) => {
  try {
    self.postMessage({ result: simulatePrices(model, trials, volatility) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
