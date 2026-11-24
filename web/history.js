// Each hourly sample is [UTC hour start, observed unit price, budget for the requested quantity].
const timingCache = new Map();
function timingRequest(item, route, batch, basis, floor) {
  const needs = new Map();
  for (const line of route.inputs) needs.set(line.id, line.quantity * batch);
  if (route.kind === "craft_auction") {
    if (!needs.has(item.id)) needs.set(item.id, 1);
  }
  for (const line of route.outputs || []) {
    if (!needs.has(line.id)) needs.set(line.id, 1);
  }
  const pairs = [...needs]
    .sort(([a], [b]) => a - b)
    .map(([id, n]) => id + ":" + n);
  return (
    "/api/price-history?items=" +
    pairs.join(",") +
    (basis === "percentile" ? "&floor=" + floor : "")
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bestHour(samples, highest) {
  const bins = Array.from({ length: 24 }, () => []);
  for (const [hour, value] of samples) bins[(hour / 3600) % 24].push(value);
  const sampled = bins.flatMap((values, hour) =>
    values.length ? [{ hour, days: values.length, value: median(values) }] : [],
  );
  const eligible = sampled.filter((bin) => bin.days >= 3);
  if (eligible.length < 2)
    return { state: "collecting", compared: eligible.length, sampled };
  const best = (highest ? Math.max : Math.min)(
    ...eligible.map((bin) => bin.value),
  );
  return {
    state: "ready",
    value: best,
    compared: eligible.length,
    sampled,
    winners: eligible.filter((bin) => bin.value === best),
  };
}

function timingProfile(item, route, batch, history, book) {
  const series = new Map(),
    hours = new Set(),
    quoted = new Set();
  for (const [id, rows] of Object.entries(history.items)) {
    series.set(
      Number(id),
      new Map(
        rows.map(([hour, unit, budget]) => {
          hours.add(hour);
          if (unit != null) quoted.add(Number(id));
          return [hour, { unit, budget }];
        }),
      ),
    );
  }
  const craft = route.kind.startsWith("craft");
  // An unlimited vendor ingredient supplies a fixed alternative each hour. Use only
  // hours with a real market observation for every auction-dependent ingredient.
  const lines = route.inputs.map((line) => {
    const entry = book.get(line.id);
    const vendor = craft
      ? (entry?.vendor_buy ??
        (line.source === "vendor" ? line.unit_cost : null))
      : null;
    const fixed =
      vendor != null && (entry?.auctionable === false || !quoted.has(line.id));
    return {
      id: line.id,
      vendorCost: vendor == null ? null : vendor * line.quantity * batch,
      fixed,
      bound: line.source === "bound" || entry?.auctionable === false,
    };
  });
  const inputsFixed = lines.every((line) => line.fixed);
  const fixedSpend = lines.reduce(
    (sum, line) => sum + (line.vendorCost ?? 0),
    0,
  );
  const vendorSale = ["craft", "vendor"].includes(route.kind);
  const outputs =
    route.kind === "craft_auction"
      ? [{ id: item.id, quantity: route.quantity }]
      : route.outputs || [];
  const costs = [],
    sales = [];
  for (const hour of hours) {
    let cost = 0;
    for (const line of lines) {
      if (line.fixed) {
        cost += line.vendorCost;
        continue;
      }
      const quote = series.get(line.id)?.get(hour);
      if (!quote || line.bound) {
        cost = null;
        break;
      }
      const spend =
        quote.budget == null
          ? line.vendorCost
          : Math.min(quote.budget, line.vendorCost ?? Infinity);
      if (spend == null) {
        cost = null;
        break;
      }
      cost += Math.ceil(spend);
    }
    if (Number.isSafeInteger(cost)) costs.push([hour, cost]);
    if (!vendorSale && outputs.length) {
      let gross = 0;
      for (const out of outputs) {
        const unit = series.get(out.id)?.get(hour)?.unit;
        if (unit == null) {
          gross = null;
          break;
        }
        gross += unit * out.quantity;
      }
      if (gross != null)
        sales.push([hour, Math.floor((gross * 323) / 400) * batch]);
    }
  }
  return {
    buy: inputsFixed
      ? { state: "fixed", value: fixedSpend }
      : bestHour(costs, false),
    sell: vendorSale
      ? {
          state: "fixed",
          value: route.proceeds == null ? null : route.proceeds * batch,
        }
      : bestHour(sales, true),
  };
}

function timingText(label, result, basis = "per batch") {
  if (result.state === "collecting") {
    return (
      label +
      " · Collecting history (" +
      result.compared +
      " of 2 comparable hours)."
    );
  }
  if (result.state === "fixed") {
    return (
      label +
      " · Any hour · " +
      (result.value == null
        ? "vendor price unknown"
        : money(result.value) + " at vendor prices") +
      "."
    );
  }
  const hourText = (hour) => String(hour).padStart(2, "0") + ":00";
  const when =
    result.winners.length === result.compared
      ? "Same median at all compared hours"
      : result.winners.map((bin) => hourText(bin.hour)).join(", ") + " UTC";
  const counts = result.winners.map((bin) => bin.days);
  const minDays = Math.min(...counts),
    maxDays = Math.max(...counts);
  const days = minDays === maxDays ? minDays : minDays + "–" + maxDays;
  return (
    label +
    " · " +
    when +
    " · " +
    money(result.value) +
    " median " +
    basis +
    " · " +
    days +
    " sampled days · " +
    result.compared +
    " hours compared."
  );
}

function hourlyTable(columns) {
  const hours = new Set();
  const series = columns.map(
    ([, side]) =>
      new Map(
        (side.sampled ?? []).map((bin) => {
          hours.add(bin.hour);
          return [bin.hour, money(bin.value) + " (" + bin.days + "d)"];
        }),
      ),
  );
  if (!hours.size) return "";
  const head = columns.map(([name]) => "<th>" + name + "</th>").join("");
  const rows = [...hours]
    .sort((a, b) => a - b)
    .map((hour) => {
      const cells = columns
        .map(
          ([, side], i) =>
            "<td>" +
            (series[i].get(hour) ??
              (side.state === "fixed" ? money(side.value) : "—")) +
            "</td>",
        )
        .join("");
      return (
        "<tr><td>" +
        String(hour).padStart(2, "0") +
        ":00</td>" +
        cells +
        "</tr>"
      );
    });
  return (
    "<details><summary>Hourly medians and sampled days</summary><table><thead><tr><th>Hour (UTC)</th>" +
    head +
    "</tr></thead><tbody>" +
    rows.join("") +
    "</tbody></table></details>"
  );
}

function timingPanel(item, route, c) {
  const url = timingRequest(
    item,
    route,
    c.batch,
    route.percentileMode ? "percentile" : "",
    prefs().floor || 0,
  );
  const entry = timingCache.get(url);
  let result = "";
  if (entry?.data) {
    const { buy, sell } = timingProfile(
      item,
      route,
      c.batch,
      entry.data,
      listingBook,
    );
    const margin =
      buy.value != null && sell.value != null
        ? "<p>Projected batch margin at these hours, including postage · <strong>" +
          money(sell.value - buy.value - summary(item, route, c).postage) +
          "</strong></p>"
        : "";
    result =
      "<p>" +
      esc(timingText("Buy reagents / prepare craft", buy)) +
      "</p><p>" +
      esc(timingText("Sell", sell)) +
      "</p>" +
      margin +
      hourlyTable([
        ["Batch cost", buy],
        ["Sale proceeds", sell],
      ]) +
      '<p class="hint">Last 28 days, UTC. Each compared hour needs 3 sampled days. Auction proceeds use observed prices, expected yields, auction cut and sale reserve. ' +
      (route.percentileMode
        ? "Reagent budgets use the selected quantity percentile."
        : "Reagent budgets use historical unit prices.") +
      "</p>";
  } else if (entry?.error) {
    result = '<p role="status">Price history unavailable. Try again.</p>';
  }
  return (
    '<section><button data-history="' +
    esc(url) +
    '"' +
    (entry?.loading ? " disabled" : "") +
    ">" +
    (entry?.loading
      ? "Loading price history…"
      : entry?.data
        ? "Refresh hourly comparison"
        : "Compare crafting and selling hours") +
    "</button>" +
    result +
    "</section>"
  );
}

function marketHistory(item) {
  const url = "/api/price-history?items=" + item.id;
  const entry = timingCache.get(url);
  const rows = entry?.data?.items[item.id]?.filter((row) => row[1] != null);
  let content = "";
  if (rows) {
    const values = rows.map(([hour, unit]) => [hour, unit]);
    const low = bestHour(values, false),
      high = bestHour(values, true);
    content =
      "<p>" +
      esc(timingText("Lowest unit price", low, "per unit")) +
      "</p><p>" +
      esc(timingText("Highest unit price", high, "per unit")) +
      "</p>" +
      hourlyTable([["Unit price", low]]) +
      '<p class="hint">Last 28 days, UTC. Each compared hour needs 3 sampled days.</p>';
  } else if (entry?.error) {
    content = "<p>Price history unavailable. Try again.</p>";
  }
  return (
    '<section><button data-history="' +
    url +
    '"' +
    (entry?.loading ? " disabled" : "") +
    ">" +
    (entry?.loading
      ? "Loading price history…"
      : entry?.data
        ? "Refresh hourly prices"
        : "Compare hourly item prices") +
    "</button>" +
    content +
    "</section>"
  );
}

async function loadTiming(url) {
  if (timingCache.get(url)?.loading) return;
  timingCache.set(url, { loading: true });
  render();
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw Error("History unavailable");
    const data = await res.json();
    if (timingCache.size >= 40)
      timingCache.delete(timingCache.keys().next().value);
    timingCache.set(url, { data });
  } catch {
    timingCache.set(url, { error: true });
  }
  render();
}
