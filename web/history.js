// Each hourly sample is [UTC hour start, observed unit price, budget for the requested quantity].
const timingCache = new Map();
function bestHour(samples, highest) {
  return AuctionMath.call("bestHour", samples, highest);
}
function timingProfile(item, route, batch, history, book, postage = 0) {
  const vendors = Object.fromEntries(route.inputs.map(l => {
    const entry = book.get(l.id);
    return [l.id, {vendor_buy: entry?.vendor_buy, auctionable: entry?.auctionable}];
  }));
  return AuctionMath.call("profile", {id:item.id}, routeForPricing(route), batch, history, vendors, postage);
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
  const { minDays, maxDays } = result;
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

function dailyPriceChart(samples, url, key, prepared) {
  const profile = prepared ?? AuctionMath.call("daily", samples, Date.now());
  const dates = profile.dates.map(t => new Date(t).toISOString().slice(0, 10));
  const sampled = profile.sampled;
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

  const { ceiling, divisor, top, middle } = AuctionMath.call("chartScale", values);
  const unit = divisor === 10000 ? "g" : divisor === 100 ? "s" : "c";
  const tick = (n) =>
    n.toLocaleString(undefined, {
      maximumSignificantDigits: 3,
      notation: n >= 1000 ? "compact" : "standard",
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
              : `height:${AuctionMath.scalar.chart_percent(value, ceiling)}%`;
          return `<span class="hour-bar series-${i}" data-detail="${esc(detail)}" style="${style}" ${s.best.has(hour) ? "data-best" : ""}></span>`;
        })
        .join("");
      return `<div data-hour="${hour}" data-label="${periodLabel(hour)}" class="${hour === selected ? "inspected" : ""}">${bars}</div>`;
    })
    .join("");
  const rules = series
    .map((s, i) =>
      s.fixed && s.value != null
        ? `<span class="vendor-rule series-${i}" style="bottom:${AuctionMath.scalar.chart_percent(s.value, ceiling)}%"></span>`
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
      <div class="hour-y" aria-hidden="true"><span>${tick(top)}</span><span>${tick(middle)}</span><span>0</span></div>
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
    const {buy,sell,margin:projectedMargin} = routeTimingResult(entry,item,route,c);
    const columns = [
      ["Batch cost", buy],
      ["Sale proceeds", sell],
    ];
    const margin =
      buy.value != null && sell.value != null
        ? "<p>Projected batch margin at these hours, including postage · <strong>" +
          money(projectedMargin) +
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
  return '<section class="history-panel">' + result + '</section>';
}

function routeFloor(route) { return route.percentileMode ? Number(prefs().floor || 0) : null; }

// Share a material's series across all routes using that quantity and price floor.
const archivedSeries = new Map();
function prepareTiming(key, materials, floor, needSeries = true) {
  let entry = timingCache.get(key);
  if (!entry) {
    entry = {data:{items:{}}, profiles:new WeakMap()};
    timingCache.set(key,entry);
  }
  if (needSeries && !entry.ready) {
    for (const {id,need} of materials) {
      const item = listingBook.get(id);
      const k = [id,need,floor].join("/");
      if (!archivedSeries.has(k))
        archivedSeries.set(k,AuctionMath.call("archiveSeries",item?.hours ?? [],report.covered_hours ?? [],need,floor,floor == null ? [] : item?.level_books ?? []));
      entry.data.items[id] = archivedSeries.get(k);
    }
    entry.ready = true;
  }
  return entry;
}

function marketHistory(item) {
  const url = "/api/price-history?items=" + item.id;
  const entry = prepareTiming(url,[{id:item.id,need:1}],null,!item.charts);
  const rows = entry?.data?.items[item.id]?.filter((row) => row[1] != null);
  let content = "";
  if (item.charts || rows) {
    const values = (rows ?? []).map(([hour, unit]) => [hour, unit]);
    const low = item.charts?.low ?? bestHour(values, false),
      high = item.charts?.high ?? bestHour(values, true);
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
  } else {
    content = "<p>No hourly prices recorded yet.</p>";
  }
  return '<section class="history-panel">' + content + '</section>';
}

function routeTimingResult(entry,item,route,c) {
  if (route.hourly_profile && c.batch === 1 && !route.percentileMode && !route.shopping && !c.mail) return route.hourly_profile;
  const postage = summary(item,route,c).postage;
  const cached = entry.profiles.get(route);
  if (cached && cached.postage === postage && cached.batch === c.batch) return cached.profile;
  const profile = timingProfile(item,route,c.batch,entry.data,listingBook,postage);
  entry.profiles.set(route,{postage,batch:c.batch,profile});
  return profile;
}

let warmVersion = 0;
function warmCustomRoutes() {
  const version = ++warmVersion;
  if (!report) return;
  const profiles = [saved.opportunities, saved.professions].filter(Boolean);
  function* work() {
    for (const p of profiles) {
      for (const item of report.items) for (const base of item.routes) {
        const c = calc(item,base,p);
        const route = pricedRoute(item,base,p);
        if (!base.hourly_profile || c.batch !== 1 || c.mail || route.percentileMode || route.shopping) {
          const floor = route.percentileMode ? Number(p.floor || 0) : null;
          const materials = routeMaterials(item,route,c.batch);
          const key = historyForMaterials(materials,route,floor);
          routeTimingResult(prepareTiming(key,materials,floor),item,route,c);
        }
        yield;
      }
    }
  }
  const jobs = work();
  function chunk() {
    if (version !== warmVersion) return;
    const start = performance.now();
    do { if (jobs.next().done) return; } while (performance.now()-start < 8);
    schedule();
  }
  function schedule() {
    if (window.requestIdleCallback) window.requestIdleCallback(chunk,{timeout:100});
    else setTimeout(chunk,0);
  }
  schedule();
}
