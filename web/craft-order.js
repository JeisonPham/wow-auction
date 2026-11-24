"use strict";

function craftOrderModel(item, route, settings) {
  return {
    order: true,
    chained: !!route.stages?.length,
    target: Math.min(10000, settings.batch * route.quantity),
    yield: craftYield(item, route, settings),
    lines: route.inputs.map((line) => {
      const entry = listingBook.get(line.id);
      return {
        id: line.id,
        name: line.name,
        quantity: line.quantity,
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
      else if (snapshot === null) market = "No fresh snapshot";
      else if (snapshot) {
        market =
          snapshot.available.toLocaleString() +
          " units · " +
          esc(snapshot.source) +
          "<br><small>" +
          esc(timestamp(snapshot.observed_at)) +
          "</small>";
        if (snapshot.lots.length) {
          const low = snapshot.lots.reduce(
            (p, [size, price]) => Math.min(p, price / size),
            Infinity,
          );
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

async function loadOrderListings(lines, signal) {
  const ids = [
    ...new Set(lines.filter((line) => !line.bound).map((line) => line.id)),
  ];
  const snapshots = {};
  for (let i = 0; i < ids.length; i += 128) {
    const response = await fetch(
      "/api/reagent-listings?items=" + ids.slice(i, i + 128).join(","),
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
          ? "Fresh stack prices needed for " +
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
      "Reagents at current listings (" +
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
        ((100 * result.filled) / trials).toFixed(1) +
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
        ["95th-percentile budget", money(Math.ceil(result.p95))],
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
            ((100 * result.shortages[i]) / trials).toFixed(1) + "% of trials",
          ],
        ]
      : [],
  );
  if (shortages.length)
    html += "<h3>Reagent shortages</h3>" + simulationStats(shortages);
  return html;
}
