// Each hourly sample is [UTC hour start, observed unit price, budget for the requested quantity].
const timingCache = new Map();
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

const utcHour = (hour) => String(hour).padStart(2, "0") + ":00";

function dailyPriceChart(samples, url, key) {
  const today = Math.floor(Date.now() / 86400000),
    first = today - 27;
  const dates = Array.from({ length: 28 }, (_, i) =>
    new Date((first + i) * 86400000).toISOString().slice(0, 10),
  );
  const buckets = dates.map(() => []);
  for (const [t, v] of samples) buckets[Math.floor(t / 86400) - first]?.push(v);
  const sampled = buckets.flatMap((values, hour) =>
    values.length
      ? [{ hour, count: values.length, value: median(values) }]
      : [],
  );
  return hourlyChart([["Unit price", { sampled }]], url, key, null, dates);
}

function hourlyChart(columns, url, key, highPrice, dates) {
  const entry = timingCache.get(url);
  const series = columns.map(([label, side]) => ({
    label,
    fixed: side.state === "fixed",
    value: side.value,
    bins: new Map((side.sampled || []).map((bin) => [bin.hour, bin])),
    best: new Map(),
  }));
  function mark(result, s, label) {
    if (result?.state === "ready" && result.winners.length < result.compared) {
      for (const bin of result.winners) s.best.set(bin.hour, label);
    }
  }
  mark(
    columns[0][1],
    series[0],
    highPrice ? "lowest unit price" : "lowest batch cost",
  );
  if (highPrice) mark(highPrice, series[0], "highest unit price");
  else if (series[1]) mark(columns[1][1], series[1], "highest sale proceeds");
  const values = series
    .flatMap((s) =>
      s.fixed ? [s.value] : [...s.bins.values()].map((bin) => bin.value),
    )
    .filter(Number.isFinite);
  if (!values.length)
    return '<p class="hint">The chart will appear when hourly prices are available.</p>';

  const peak = Math.max(...values) || 1;
  const power = 10 ** Math.floor(Math.log10(peak));
  const ceiling = ([1, 2, 5, 10].find((n) => n * power >= peak) || 10) * power;
  const divisor = ceiling >= 10000 ? 10000 : ceiling >= 100 ? 100 : 1;
  const unit = divisor === 10000 ? "g" : divisor === 100 ? "s" : "c";
  const tick = (n) =>
    (n / divisor).toLocaleString(undefined, {
      maximumSignificantDigits: 3,
      notation: n / divisor >= 1000 ? "compact" : "standard",
    }) + unit;
  const periodLabel = (n) => (dates ? dates[n] : utcHour(n)) + " UTC";
  const hours = Array.from({ length: dates?.length || 24 }, (_, hour) => hour);
  const selected =
    entry.hours?.get(key) ??
    columns.find(([, side]) => side.winners?.length)?.[1].winners[0].hour ??
    (dates
      ? hours.findLast((hour) => series.some((s) => s.bins.has(hour)))
      : hours.find((hour) => series.some((s) => s.bins.has(hour)))) ??
    0;

  function point(s, hour) {
    const bin = s.bins.get(hour);
    const value = s.fixed ? s.value : bin?.value;
    if (value == null)
      return { value, detail: s.fixed ? "Unknown vendor price" : "No sample" };
    const coverage = s.fixed
      ? "fixed vendor price"
      : dates
        ? bin.count + (bin.count === 1 ? " sampled hour" : " sampled hours")
        : bin.days + (bin.days === 1 ? " sampled day" : " sampled days");
    return {
      value,
      detail: [money(value), coverage, s.best.get(hour)]
        .filter(Boolean)
        .join(" · "),
    };
  }
  const bands = hours
    .map((hour) => {
      const bars = series
        .map((s, i) => {
          const { value, detail } = point(s, hour);
          // Each series keeps its slot when one side of the basket has no quote.
          const style =
            s.fixed || value == null
              ? "visibility:hidden"
              : `height:${(100 * value) / ceiling}%`;
          return `<span class="hour-bar series-${i}" data-detail="${esc(detail)}" style="${style}" ${s.best.has(hour) ? "data-best" : ""}></span>`;
        })
        .join("");
      return `<div data-hour="${hour}" data-label="${periodLabel(hour)}" class="${hour === selected ? "inspected" : ""}">${bars}</div>`;
    })
    .join("");
  const rules = series
    .map((s, i) =>
      s.fixed && s.value != null
        ? `<span class="vendor-rule series-${i}" style="bottom:${(100 * s.value) / ceiling}%"></span>`
        : "",
    )
    .join("");
  const metrics = series
    .map(
      (s, i) =>
        `<span class="hour-metric series-${i}${s.fixed ? " fixed" : ""}">${esc(s.label)} <strong data-metric>${esc(point(s, selected).detail)}</strong></span>`,
    )
    .join("");
  const ticks = hours
    .map(
      (hour) =>
        `<span>${dates ? (hour % 7 === 0 || hour === 27 ? dates[hour].slice(8) : "") : hour % 4 === 0 || hour === 23 ? String(hour).padStart(2, "0") : ""}</span>`,
    )
    .join("");
  const title = dates
    ? "Daily unit price"
    : columns.length === 1
      ? "Hourly unit price"
      : "Hourly batch prices";
  const bestKey = series.some((s) => s.best.size)
    ? '<i class="best-key" aria-hidden="true"></i> Best hours · '
    : "";
  const label = periodLabel(selected);
  const description = [
    label,
    ...series.map((s) => s.label + " " + point(s, selected).detail),
  ].join(", ");
  return `<figure class="hourly-chart" style="--chart-periods:${hours.length}" data-chart-key="${esc(key)}" data-chart-url="${esc(url)}">
    <figcaption><strong>${title}</strong><span>${bestKey}${dates ? "Daily medians · UTC" : "28-day medians"}</span></figcaption>
    <div class="hour-graph">
      <div class="hour-y" aria-hidden="true"><span>${tick(ceiling)}</span><span>${tick(ceiling / 2)}</span><span>0</span></div>
      <div class="hour-plot" aria-hidden="true">${bands}${rules}</div>
      <div class="hour-x" aria-hidden="true">${ticks}</div>
      <input class="hour-slider" type="range" min="0" max="${hours.length - 1}" step="1" value="${selected}"
        aria-label="Inspect ${dates ? "day" : "hour"} in UTC" aria-valuetext="${esc(description)}">
    </div>
    <div class="hour-readout"><b data-hour-label>${label}</b>${metrics}</div>
  </figure>`;
}

function bindHourlyCharts(container) {
  function inspect(chart, hour) {
    const column = chart.querySelector('[data-hour="' + hour + '"]');
    if (!column) return;
    chart.querySelector(".inspected")?.classList.remove("inspected");
    column.classList.add("inspected");
    const label = column.dataset.label;
    chart.querySelector("[data-hour-label]").textContent = label;
    const descriptions = [];
    chart.querySelectorAll("[data-metric]").forEach((metric, i) => {
      metric.textContent = column.children[i].dataset.detail;
      descriptions.push(metric.parentElement.textContent);
    });
    const slider = chart.querySelector(".hour-slider");
    slider.value = hour;
    slider.setAttribute("aria-valuetext", [label, ...descriptions].join(", "));
    const entry = timingCache.get(chart.dataset.chartUrl);
    if (entry) (entry.hours ??= new Map()).set(chart.dataset.chartKey, hour);
  }
  function inspectColumn(event) {
    const column = event.target.closest(".hour-plot [data-hour]");
    if (column && !column.contains(event.relatedTarget)) {
      inspect(column.closest(".hourly-chart"), Number(column.dataset.hour));
    }
  }
  container.addEventListener("pointerover", inspectColumn);
  container.addEventListener("click", inspectColumn);
  container.addEventListener("input", (event) => {
    if (event.target.matches(".hour-slider")) {
      inspect(
        event.target.closest(".hourly-chart"),
        event.target.valueAsNumber,
      );
    }
  });
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

function timingPanel(item, route, c, url) {
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
    const columns = [
      ["Batch cost", buy],
      ["Sale proceeds", sell],
    ];
    const margin =
      buy.value != null && sell.value != null
        ? "<p>Projected batch margin at these hours, including postage · <strong>" +
          money(sell.value - buy.value - summary(item, route, c).postage) +
          "</strong></p>"
        : "";
    result =
      hourlyChart(columns, url, routeKey(item, route)) +
      "<p>" +
      esc(timingText("Buy reagents / prepare craft", buy)) +
      "</p><p>" +
      esc(timingText("Sell", sell)) +
      "</p>" +
      margin +
      hourlyTable(columns) +
      '<p class="hint">Last 28 days, UTC. Each compared hour needs 3 sampled days. Auction proceeds use observed prices, expected yields, auction cut and sale reserve. ' +
      (route.percentileMode
        ? "Reagent budgets use the selected quantity percentile."
        : "Reagent budgets use historical unit prices.") +
      "</p>";
  }
  if (entry?.error)
    result +=
      '<p role="status">Price history unavailable. Refresh to retry.</p>';
  return (
    '<section class="history-panel"><button data-history="' +
    esc(url) +
    '"' +
    (entry?.loading ? " disabled" : "") +
    ">" +
    (entry?.loading
      ? "Loading price history…"
      : entry?.data
        ? "Refresh hourly comparison"
        : entry?.error
          ? "Retry price history"
          : "Loading price history…") +
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
    const columns = [["Unit price", low]];
    content =
      hourlyChart(columns, url, "item/" + item.id, high) +
      "<p>" +
      esc(timingText("Lowest unit price", low, "per unit")) +
      "</p><p>" +
      esc(timingText("Highest unit price", high, "per unit")) +
      "</p>" +
      hourlyTable(columns) +
      '<p class="hint">Last 28 days, UTC. Each compared hour needs 3 sampled days.</p>';
  } else if (entry?.error) {
    content = "<p>Price history unavailable. Try again.</p>";
  }
  return (
    '<section class="history-panel"><button data-history="' +
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

async function loadTiming(key, initial = false) {
  const previous = timingCache.get(key);
  if (previous?.loading) return;
  const entry = { ...previous, loading: true, error: false };
  timingCache.set(key, entry);
  if (!initial) render(true);
  try {
    const items = {};
    for (const url of key.split("|")) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw Error("History unavailable");
      const page = await response.json();
      Object.assign(items, page.items);
    }
    entry.data = { items };
    entry.fetchedAt = Date.now();
  } catch {
    entry.error = true;
  } finally {
    entry.loading = false;
    if (timingCache.size > 40) {
      const oldest = [...timingCache.keys()].find(
        (k) => k !== key && !timingCache.get(k).loading,
      );
      if (oldest) timingCache.delete(oldest);
    }
    render(true);
  }
}
