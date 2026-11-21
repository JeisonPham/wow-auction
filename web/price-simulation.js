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
    if (!Number.isFinite(cost) || cost > Number.MAX_SAFE_INTEGER)
      throw Error(
        "This total exceeds the supported copper range. Try a smaller batch.",
      );
    outcomes[t] = cost;
    average += (cost - average) / (t + 1);
    if (model.proceeds !== null && model.proceeds > cost) profitable++;
  }

  outcomes.sort();
  const quantile = (fraction) => {
    const index = (trials - 1) * fraction;
    const lo = Math.floor(index);
    return (
      outcomes[lo] + (outcomes[Math.ceil(index)] - outcomes[lo]) * (index - lo)
    );
  };
  const low = outcomes[0],
    high = outcomes[trials - 1];
  const bins = Array(low === high ? 1 : 20).fill(0);
  for (const cost of outcomes) {
    const bin =
      high === low
        ? 0
        : Math.floor(((cost - low) / (high - low)) * bins.length);
    bins[Math.min(bin, bins.length - 1)]++;
  }
  return {
    average,
    p5: quantile(0.05),
    median: quantile(0.5),
    p95: quantile(0.95),
    low,
    high,
    bins,
    profitChance: model.proceeds === null ? null : profitable / trials,
  };
}

self.onmessage = ({ data: { model, trials, volatility } }) => {
  try {
    self.postMessage({ result: simulatePrices(model, trials, volatility) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
