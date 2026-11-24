"use strict";

function craftOrderModel(item, route, settings) {
  return {
    order: true,
    settings, destroys: destroys(route),
    chained: !!route.stages?.length,
    target: AuctionMath.scalar.default_target(route.quantity, settings.batch),
    yield: craftYield(item, route, settings),
    lines: route.inputs.map((line) => {
      const entry = listingBook.get(line.id);
      return {
        id: line.id,
        name: line.name,
        quantity: line.quantity,
        max_stack: line.max_stack || settings.stack,
        bound: line.source === "bound" || entry?.auctionable === false,
        vendor:
          entry?.vendor_buy ??
          (line.source === "vendor" ? line.unit_cost : null),
      };
    }),
  };
}

function orderInputTable(lines) {
  return lines
    .map((line) => {
      const snapshot = line.snapshot;
      let market = "Awaiting listings";
      if (line.bound) market = "Bound item";
      else if (snapshot === null) market = "No recorded snapshot";
      else if (snapshot) {
        market =
          snapshot.available.toLocaleString() +
          " units · " +
          esc(snapshot.source) + (snapshot.stale ? " · Stale" : "") +
          "<br><small>" +
          esc(timestamp(snapshot.observed_at)) +
          "</small>";
        if (snapshot.lots.length) {
          const low = AuctionMath.call("lowest", snapshot.lots);
          market += "<br>From " + money(low) + " per unit";
        } else if (snapshot.available) market += "<br>Stack prices unavailable";
      }
      return (
        "<tr><td>" +
        esc(line.name) +
        "</td><td>" +
        line.quantity.toLocaleString() +
        "</td><td>" +
        market +
        "</td><td>" +
        money(line.vendor) +
        "</td></tr>"
      );
    })
    .join("");
}

async function loadOrderListings(model, signal) {
  const lines = model.lines;
  const sales = model.optimize && model.yield.marketSale ? model.yield.saleItems : [];
  const ids = [...new Set([...lines.filter(line => !line.bound), ...sales].map(line => line.id))];
  const snapshots = {};
  for (let i = 0; i < ids.length; i += 128) {
    const response = await fetch(
      "/api/simulation-listings?items=" + ids.slice(i, i + 128).join(","),
      { cache: "no-store", signal },
    );
    if (!response.ok)
      throw Error("Listings could not be loaded. Run again to retry.");
    const data = await response.json();
    Object.assign(snapshots, data.items);
  }
  const inputs = lines.map((line) => ({
    ...line,
    snapshot: snapshots[line.id] ?? null,
  }));
  if (signal.aborted) return [];
  $("sim-inputs").innerHTML = orderInputTable(inputs);
  if (sales.length) {
    const observations = [];
    model.yield.saleItems = sales.map(line => {
      const entry = listingBook.get(line.id);
      const snapshot = snapshots[line.id];
      const useListing = snapshot?.lots.length && (!entry?.estimate || snapshot.observed_at >= (entry.estimate_at ?? 0));
      const unit = useListing ? AuctionMath.call("lowest", snapshot.lots) : entry?.estimate ?? line.unit_cost ?? null;
      const source = useListing ? snapshot.source : entry?.estimate_source || "Report";
      const time = useListing ? snapshot.observed_at : entry?.estimate_at;
      const stale = useListing ? snapshot.stale : entry?.estimate_stale;
      observations.push(line.name + " · " + money(unit) + " · " + source + (time ? " · " + timestamp(time) : "") + (stale ? " · Stale" : ""));
      return {...line, unit_cost: unit};
    });
    model.yield.refreshSale = true;
    $("sim-sales").textContent = "Auction sale quotes · " + observations.join(" | ");
  }
  const unknown = inputs.filter(
    (line) =>
      line.vendor == null &&
      (line.bound ||
        !line.snapshot ||
        (line.snapshot.available > 0 && !line.snapshot.lots.length)),
  );
  if (unknown.length) {
    const missing = unknown
      .filter((line) => !line.bound)
      .map((line) => line.name);
    const bound = unknown.filter((line) => line.bound).map((line) => line.name);
    throw Error(
      [
        missing.length
          ? "Recorded stack prices needed for " +
            missing.join(", ") +
            ". Upload an auction scan or refresh Blizzard listings."
          : "",
        bound.length
          ? "This plan requires bound reagents with no purchase source: " +
            bound.join(", ") +
            "."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  return inputs.map(({ snapshot, ...line }) => ({
    ...line,
    lots: snapshot?.lots || [],
  }));
}

function orderResults(result, trials, lines) {
  const stats = [
    ["Finished pieces wanted", result.target.toLocaleString()],
    [
      "Reagents at recorded listings (" +
        result.plannedRuns.toLocaleString() +
        " planned casts)",
      result.current == null ? "Insufficient stock" : money(result.current),
    ],
    [
      "Trials with enough reagents",
      result.filled.toLocaleString() +
        " / " +
        trials.toLocaleString() +
        " (" +
        result.fillPercent.toFixed(1) +
        "%)",
    ],
    [
      "Mean casts to reach target",
      result.runs.toLocaleString(undefined, { maximumFractionDigits: 2 }),
    ],
  ];
  let html = simulationStats(stats);
  if (result.filled) {
    html +=
      "<h3>Reagent cost for filled orders</h3>" +
      simulationStats([
        ["Median cost", money(result.median)],
        ["Mean cost", money(result.average)],
        ["Middle 90% of costs", money(result.p5) + " – " + money(result.p95)],
        ["95th-percentile budget", money(result.budget95)],
      ]) +
      simulationDistribution(result);
  } else {
    html += "<p>No trial could fill this order.</p>";
  }
  const shortages = lines.flatMap((line, i) =>
    result.shortages[i]
      ? [
          [
            line.name,
            result.shortagePercent[i].toFixed(1) + "% of trials",
          ],
        ]
      : [],
  );
  if (shortages.length)
    html += "<h3>Reagent shortages</h3>" + simulationStats(shortages);
  return html;
}

function optimizationResults(result) {
  if (!result.casts) {
    const reason = result.feasible
      ? "No quantity had a positive average profit across the simulated markets."
      : "No simulated market had enough affordable stock for one craft.";
    return "<h3>Recommended order</h3>" + simulationStats([["Crafts", "0"], ["Expected net profit", money(0)]]) + "<p>" + reason + "</p>";
  }
  const units = result.minPieces === result.maxPieces ? result.pieces.toLocaleString()
    : result.pieces.toLocaleString(undefined, {maximumFractionDigits: 2}) + " average (" + result.minPieces.toLocaleString() + "–" + result.maxPieces.toLocaleString() + " possible)";
  return "<h3>Recommended order</h3>" + simulationStats([
    ["Crafts", result.casts.toLocaleString()], ["Finished pieces per filled order", units],
    ["Expected net profit across all trials", money(result.profit)],
    ["Middle 90% of net profits", money(result.p5) + " – " + money(result.p95)],
    ["Chance of positive profit", result.winPercent.toFixed(1) + "%"],
    ["Chance of filling within budget", result.fillPercent.toFixed(1) + "%"],
    ["Mean cost per filled order, including postage", money(result.cost)],
    ["Mean postage per filled order", money(result.postage)],
    ["Mean sale proceeds per filled order", money(result.out)],
  ]) + simulationDistribution(result);
}
