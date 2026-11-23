"use strict";
const $ = (id) => document.getElementById(id);
const titles = {
  market: "Market prices",
  opportunities: "Opportunities",
  professions: "Professions",
};
const esc = (x) =>
  String(x ?? "—").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const age = (t) => {
  if (!t) return "—";
  const n = Math.max(0, Date.now() / 1000 - t);
  return n < 60
    ? "Just now"
    : n < 3600
      ? Math.floor(n / 60) + "m"
      : n < 86400
        ? Math.floor(n / 3600) + "h " + Math.floor((n % 3600) / 60) + "m"
        : Math.floor(n / 86400) + "d";
};
const timestamp = (t) => (t ? new Date(t * 1000).toLocaleString() : "—");
function money(n) {
  if (n == null) return "—";
  const a = Math.abs(n),
    g = Math.floor(a / 10000),
    s = Math.floor((a % 10000) / 100);
  return (
    (n < 0 ? "−" : "") +
    [g ? g + "g" : "", s ? s + "s" : "", +(a % 100).toFixed(2) + "c"]
      .filter(Boolean)
      .join(" ")
  );
}
function duration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.round(seconds * 10) / 10;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = +(total % 60).toFixed(1);
  return (
    [hours && hours + "h", minutes && minutes + "m", rest && rest + "s"]
      .filter(Boolean)
      .join(" ") || "0s"
  );
}
function hourly(value) {
  return Number.isFinite(value)
    ? value.toLocaleString(undefined, {
        maximumFractionDigits: 2,
        maximumSignificantDigits:
          value !== 0 && Math.abs(value) < 0.01 ? 2 : undefined,
      }) + " g/h"
    : "—";
}
let saved = {};
try {
  saved = JSON.parse(sessionStorage.wam || "{}");
} catch {}
const validBatch = (n) => Number.isInteger(n) && n >= 1 && n <= 10000;
if (!validBatch(saved.batchSize)) {
  // The previous dashboard saved a default of one whenever a route was opened.
  for (const name of Object.keys(titles)) {
    for (const settings of Object.values(saved[name]?.calc || {})) {
      if (settings.batch === 1) delete settings.batch;
    }
  }
  saved.batchSize = 1;
}
const save = () => {
  try {
    sessionStorage.wam = JSON.stringify(saved);
  } catch {}
};
let report,
  listingBook = new Map(),
  busy = false,
  offline = "",
  rows = [],
  etag;
function view() {
  return Object.hasOwn(titles, location.hash.slice(1))
    ? location.hash.slice(1)
    : "market";
}
function prefs() {
  return (saved[view()] ??= {
    search: "",
    level: "",
    profession: "",
    sort: view() === "market" ? "name" : "profit",
    page: 0,
    open: {},
    calc: {},
  });
}
function options(list, value) {
  return list
    .map(
      ([k, v]) =>
        '<option value="' +
        esc(k) +
        '" ' +
        (k === value ? "selected" : "") +
        ">" +
        esc(v) +
        "</option>",
    )
    .join("");
}
function setup() {
  const v = view(),
    p = prefs();
  document.querySelector("h1").textContent = titles[v];
  document.querySelectorAll("nav a").forEach((a) => {
    if (a.hash === "#" + v) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("search").value = p.search;
  $("level").value = p.level;
  $("route").value = p.route || "";
  $("profitability").value = p.profitability || "";
  $("pricing").value = p.pricing || "listings";
  $("trainingCost").value = p.trainingCost || "";
  $("trainingCostLabel").hidden = v !== "professions";
  $("batchSize").value = saved.batchSize;
  $("batchSizeLabel").hidden = v === "market";
  $("access").value = p.access || "";
  $("routeLabel").hidden =
    $("profitabilityLabel").hidden =
    $("pricingLabel").hidden =
    $("accessLabel").hidden =
    $("levelLabel").hidden =
    $("profLabel").hidden =
      v === "market";
  $("sort").innerHTML = options(
    v === "market"
      ? [
          ["name", "Item name"],
          ["estimate", "Highest TSM price"],
          ["units", "Most checked units"],
        ]
      : [
          ["profit", "Highest profit"],
          ["gold_per_hour", "Highest gold per hour"],
          ["name", "Item name"],
          v === "professions"
            ? ["level", "Character level"]
            : ["stock", "Stock status"],
        ],
    p.sort,
  );
  render();
}
function patternText(req = {}) {
  const { pattern, pattern_id, pattern_character_level, pattern_quest_level } =
    req;
  if (!pattern && !pattern_id) return "";
  const parts = [pattern || "Pattern #" + pattern_id];
  if (pattern_character_level == null)
    parts.push("Pattern learning level unknown");
  else if (pattern_character_level > 0)
    parts.push("Level " + pattern_character_level + " to learn");
  if (pattern_quest_level > 0)
    parts.push("Level " + pattern_quest_level + " to accept the pattern quest");
  return parts.join(" · ");
}
function reqText(r) {
  const req = r.requirements || {};
  const fields = Object.entries(req)
    .filter(
      ([k]) =>
        ![
          "pattern",
          "pattern_id",
          "pattern_character_level",
          "pattern_quest_level",
        ].includes(k),
    )
    .map(
      ([k, v]) =>
        k.replaceAll("_", " ") +
        " " +
        (typeof v === "object" ? JSON.stringify(v) : v),
    );
  return [...fields, patternText(req)].filter(Boolean).join(" · ");
}
const isCraft = (r) =>
  ["craft", "craft_disenchant", "craft_auction"].includes(r.kind);
function profitability(profit) {
  if (profit == null) return "unknown";
  if (profit > 0) return "profit";
  if (profit < 0) return "loss";
  return "even";
}
const destroys = (r) =>
  r.kind === "disenchant" || r.kind === "craft_disenchant";
const exitLabel = (r) =>
  ({
    craft: "Craft → vendor",
    craft_disenchant: "Craft → disenchant",
    craft_auction: "Craft → auction",
    disenchant: "Buy → disenchant",
    vendor: "Buy → vendor",
  })[r.kind] || r.name;
const routeLabel = (r) => (r.stages?.length ? "Chained · " : "") + exitLabel(r);
function pathSteps(r, batch) {
  if (!r.stages?.length) return [];
  const amount = (n) =>
    (n * batch).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const mats = (list) =>
    list.map((m) => amount(m.quantity) + " × " + m.name).join(", ");
  const result = r.stages.map((s) => {
    if (s.action === "disenchant")
      return (
        "Disenchant " +
        amount(s.quantity) +
        " × " +
        s.name +
        ". Expected materials: " +
        mats(s.outputs) +
        "."
      );
    return (
      "Craft " +
      amount(s.quantity) +
      " × " +
      s.name +
      " from " +
      mats(s.inputs) +
      " (" +
      amount(s.runs) +
      " recipe runs). " +
      [patternText(s.requirements || {}), s.advice].filter(Boolean).join(". ")
    );
  });
  result.push(
    "Craft " +
      amount(r.quantity) +
      " × " +
      r.name +
      " from " +
      mats(r.final_inputs) +
      ".",
  );
  result.push(
    {
      craft: "Sell the finished items to a vendor.",
      craft_auction: "List the finished items on the auction house.",
      craft_disenchant:
        "Disenchant the finished items and list their materials on the auction house.",
    }[r.kind],
  );
  return result;
}
function trainingPlans(rows) {
  const best = new Map();
  const byHour = prefs().sort === "gold_per_hour";
  const score = (r) => (byHour ? r.timing?.gold_per_hour : r.profit);
  for (const { i, r } of rows) {
    if (
      !isCraft(r) ||
      r.ready !== false ||
      !(r.profit > 0) ||
      !Number.isFinite(score(r)) ||
      r.stock === "insufficient"
    )
      continue;
    const key = r.profession || "Unknown profession";
    if (!best.has(key) || score(r) > score(best.get(key).r))
      best.set(key, { i, r });
  }
  const list = [...best.values()].sort((a, b) => score(b.r) - score(a.r));
  const trainingCopper = Math.ceil(Number(prefs().trainingCost) * 10000);
  const payback = (profit) =>
    trainingCopper > 0 && Number.isFinite(trainingCopper)
      ? " · " +
        Math.ceil(trainingCopper / profit).toLocaleString() +
        " profitable crafts to recover your budget"
      : "";
  const catalog = report?.catalog;
  const caption = catalog
    ? catalog.recipes.toLocaleString() +
      " recipes checked · " +
      catalog.characters +
      " character rosters · build " +
      catalog.build
    : "";
  return (
    "<h2>Profession plans</h2><p class='hint'>" +
    esc(caption) +
    "</p>" +
    (list.length
      ? "<p>Highest projected " +
        (byHour ? "repeat gold per hour" : "profit per craft") +
        " requiring training or a roster check, by profession. Enter the gold you expect to spend on training and patterns to see how many crafts would repay it.</p><ul>" +
        list
          .map(
            ({ i, r }) =>
              "<li><strong>" +
              esc(r.profession) +
              " · " +
              esc(i.name) +
              "</strong> · " +
              esc(routeLabel(r)) +
              " · " +
              money(r.profit) +
              " per craft" +
              (r.timing ? " · " + hourly(r.timing.gold_per_hour) : "") +
              payback(r.profit) +
              "<br>" +
              esc(r.advice) +
              "</li>",
          )
          .join("") +
        "</ul>"
      : "<p>No profitable training opportunities match these filters.</p>")
  );
}
function render() {
  const v = view(),
    p = prefs(),
    market = v === "market",
    items = report?.items || [],
    tsm = report?.tsm || {};
  if (report) {
    $("scope").textContent = report.region + " / " + report.market;
    const desktop = $("tsm-desktop");
    desktop.hidden = !report.desktop_port;
    if (report.desktop_port) {
      const url = new URL(location.href);
      url.port = report.desktop_port;
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      desktop.href = url.href;
    }
    $("count").textContent = tsm.count.toLocaleString();
    $("source").textContent = tsm.source;
    if (report.catalog && tsm.source !== "Desktop AppHelper") {
      $("source").textContent += report.catalog.desktop_at
        ? " · Desktop last synced " + timestamp(report.catalog.desktop_at)
        : " · Awaiting desktop sync";
    }
    $("client-upload").textContent = report.uploaded_at
      ? "Last upload " + timestamp(report.uploaded_at)
      : "Awaiting first client upload";
    $("age").textContent = age(tsm.observed_at);
    $("observed").textContent = timestamp(tsm.observed_at);
    $("coverage").textContent = items
      .filter((i) => i.listed_units != null)
      .length.toLocaleString();
    $("updated").textContent =
      "Report updated " + timestamp(report.generated_at);
  }
  const notice =
    offline ||
    tsm.error ||
    (tsm.state === "stale"
      ? "Price estimates have expired. Waiting for a fresh observation."
      : "");
  $("notice").hidden = !notice;
  $("notice").textContent = notice;
  rows = [];
  const profs = new Set();
  for (const i of items) {
    const match = (i.name + " " + i.id)
      .toLowerCase()
      .includes(p.search.trim().toLowerCase());
    if (market) {
      if (match) rows.push({ i, key: String(i.id) });
      continue;
    }
    for (const [index, base] of i.routes.entries()) {
      const r = pricedRoute(i, base);
      if (
        v === "opportunities" &&
        !isCraft(r) &&
        !(r.profit > 0 && r.stock !== "insufficient")
      )
        continue;
      if (v === "professions" && r.kind === "vendor") continue;
      const prof =
        r.profession || (r.kind === "vendor" ? "Vendor" : "Crafting");
      profs.add(prof);
      if (p.profitability && profitability(r.profit) !== p.profitability)
        continue;
      if (
        p.route === "chain" ? !r.stages?.length : p.route && r.kind !== p.route
      )
        continue;
      if (
        (p.access === "training" && r.ready !== false) ||
        (p.access === "ready" && r.ready === false)
      )
        continue;
      if (
        (match ||
          r.name.toLowerCase().includes(p.search.trim().toLowerCase())) &&
        (!p.profession || prof === p.profession) &&
        (!p.level ||
          (r.required_character_level != null &&
            r.required_character_level <= Number(p.level)))
      )
        rows.push({ i, r, key: i.id + "-" + index });
    }
  }
  $("training").hidden = v !== "professions" || p.access === "ready";
  if (v === "professions") $("training").innerHTML = trainingPlans(rows);
  $("profession").innerHTML = options(
    [
      ["", "All professions"],
      ...Array.from(profs)
        .sort()
        .map((x) => [x, x]),
    ],
    p.profession,
  );
  const num = (x) =>
    ({
      profit: x.r?.profit,
      gold_per_hour: x.r?.timing?.gold_per_hour,
      estimate: x.i.estimate,
      units: x.i.listed_units,
      stock: { verified: 2, estimated: 1, insufficient: 0 }[x.r?.stock],
      level: -(x.r?.required_character_level ?? Infinity),
    })[p.sort] ?? -Infinity;
  rows.sort(
    (a, b) =>
      (p.sort === "name" ? 0 : num(b) - num(a)) ||
      a.i.name.localeCompare(b.i.name) ||
      a.i.id - b.i.id,
  );
  p.page = Math.min(p.page, Math.max(0, Math.ceil(rows.length / 40) - 1));
  const start = p.page * 40;
  const showBatch =
    !market &&
    (saved.batchSize > 1 || Object.values(p.calc).some((c) => c.batch > 1));
  $("head").innerHTML =
    "<tr>" +
    (market
      ? [
          "Item",
          "TSM estimate",
          "Checked average",
          "Checked units",
          "Last check",
        ]
      : [
          "Item",
          "Route",
          "Cost / run",
          "Profit / run",
          "Time / run",
          "Repeat gold/hour",
          "Stock",
          ...(showBatch ? ["Batch estimate"] : []),
        ]
    )
      .map((s) => "<th>" + s + "</th>")
      .join("") +
    "</tr>";
  $("body").innerHTML = rows
    .slice(start, start + 40)
    .map(({ i, r, key }, j) => {
      const open = !!p.open[key],
        idx = start + j;
      const cells = market
        ? [
            money(i.estimate),
            money(i.checked_price),
            i.listed_units ?? "—",
            age(i.checked_at),
          ]
        : [
            esc(routeLabel(r)) +
              (r.kind === "vendor"
                ? ""
                : "<br><small>" +
                  esc(
                    [
                      r.profession,
                      r.required_character_level == null
                        ? "Character level unknown"
                        : "Character level " + r.required_character_level,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  ) +
                  "</small>"),
            money(
              r.shopping?.cost == null
                ? r.cost
                : r.shopping.cost / calc(i, r).batch,
            ),
            '<span class="' +
              profitability(r.profit) +
              '">' +
              (r.profit == null ? "Unknown" : money(r.profit)) +
              "</span>",
            duration(r.timing?.elapsed_seconds) +
              (r.timing?.assumed_cast
                ? "<br><small>Assumed cast time</small>"
                : ""),
            hourly(r.timing?.gold_per_hour),
            '<span class="' +
              esc(r.stock) +
              '">' +
              esc(r.stock) +
              "</span>" +
              (r.ready === false
                ? "<br><small>Training or roster needed</small>"
                : ""),
          ];
      if (showBatch) {
        const c = calc(i, r);
        const b = summary(i, r, c);
        cells.push(
          money(b.net) +
            " profit<br><small>" +
            c.batch +
            (c.batch === 1 ? " run" : " runs") +
            (r.timing
              ? " · " + duration(b.seconds) + " · " + hourly(b.goldPerHour)
              : "") +
            "</small>" +
            (b.shortages.length
              ? '<br><small class="estimated">Insufficient stock for batch</small>'
              : ""),
        );
      }
      return (
        '<tr><td><button class="rowname" data-row="' +
        idx +
        '" aria-expanded="' +
        open +
        '">' +
        (open ? "▾" : "▸") +
        " " +
        esc(i.name) +
        ' <span class="id">#' +
        i.id +
        "</span></button></td>" +
        cells.map((x) => "<td>" + x + "</td>").join("") +
        "</tr>" +
        (open
          ? '<tr><td colspan="' +
            (cells.length + 1) +
            '"><div class="detail"><p class="hint">' +
            esc(tsm.source) +
            " · " +
            timestamp(tsm.observed_at) +
            " · Estimated auctions " +
            esc(i.estimated_auctions) +
            " · Checked auctions " +
            esc(i.checked_auctions) +
            " · Vendor payout " +
            money(i.vendor_sell) +
            "</p>" +
            (market ? marketSimulationButton(i, idx) : "") +
            (r ? [r] : i.routes)
              .map((route, n) => detail(i, r || pricedRoute(i, route), idx, n))
              .join("") +
            "</div></td></tr>"
          : "")
      );
    })
    .join("");
  $("empty").textContent = rows.length
    ? ""
    : !report
      ? "Waiting for the first report…"
      : items.length === 0
        ? "Awaiting market data. A public price update or a scanner upload will populate this view."
        : v === "professions" && !p.search
          ? "No matching profession routes. Adjust the filters or wait for current prices."
          : "No matching items or routes.";
  $("range").textContent = rows.length
    ? start + 1 + "–" + Math.min(start + 40, rows.length) + " of " + rows.length
    : "0 results";
  $("prev").disabled = start === 0;
  $("next").disabled = start + 40 >= rows.length;
  save();
}
function marketQuote(item) {
  if (item.listed_units != null || item.checked_at != null)
    return {
      price: item.checked_price,
      source: "checked",
      at: item.checked_at,
    };
  return {
    price: item.estimate,
    source: "estimate",
    at: report.tsm.observed_at,
  };
}
function marketSimulationButton(item, idx) {
  return marketQuote(item).price > 0
    ? '<button class="sim-launch" aria-haspopup="dialog" data-sim-item="' +
        idx +
        '">Simulate unit price</button>'
    : '<p class="hint">A current auction quote is needed to simulate this price.</p>';
}
function craftSimulationButton(route) {
  if (
    route.inputs.some(
      (line) =>
        !Number.isFinite(line.cost) ||
        !Number.isFinite(line.unit_cost) ||
        (line.source !== "vendor" && line.unit_cost <= 0),
    )
  )
    return '<p class="hint">Simulating a batch requires a price for each reagent.</p>';
  return '<button class="sim-launch" aria-haspopup="dialog" data-sim-craft>Simulate craft batch</button>';
}

let simulationModel, simulationWorker;
function clearSimulation() {
  simulationWorker?.terminate();
  simulationWorker = null;
  $("sim-result").replaceChildren();
  $("sim-status").textContent = "";
}
function craftYield(item, route, c) {
  return {
    key: "recipe/" + (route.recipe_id || item.id),
    min: route.quantity_min ?? route.quantity,
    max: route.quantity_max ?? route.quantity,
    base: route.quantity,
    netPerUnit:
      route.net_unit_value ??
      (route.proceeds == null ? null : route.proceeds / route.quantity),
    timing: route.timing,
    returnStack:
      c.mail && c.back && !destroys(route) ? item.max_stack || c.stack : null,
    post: c.post,
  };
}
function openSimulation(name, model, shortages, at) {
  clearSimulation();
  simulationModel = model;
  $("sim-title").textContent =
    name + (model.unitOnly ? " · Unit price" : " · Craft batch");
  $("sim-context").textContent = model.unitOnly
    ? "Monte Carlo simulation using the quote from " + timestamp(at) + "."
    : "Monte Carlo simulation for " +
      model.batch.toLocaleString() +
      (model.batch === 1 ? " craft" : " crafts") +
      " using the report from " +
      timestamp(at) +
      ". Recipe output range: " +
      model.yield.min +
      "–" +
      model.yield.max +
      " pieces per final craft. Each cast rolls independently with equal odds for each whole number. Unit sale values and vendor prices stay fixed." +
      (model.chained
        ? " Intermediate steps follow the displayed production plan."
        : "") +
      (model.expectedInputs
        ? " Disenchant materials use their expected yields per piece."
        : "");
  for (const bound of ["min", "max"]) {
    const field = $("sim-yield-" + bound);
    field.disabled = !model.yield;
    $("sim-" + bound + "-label").hidden = !model.yield;
    field.value = model.yield
      ? (saved.yieldRanges?.[model.yield.key]?.[bound] ?? model.yield[bound])
      : "";
  }
  $("sim-inputs").innerHTML = model.lines
    .map(
      (line) =>
        "<tr><td>" +
        esc(line.name) +
        "</td><td>" +
        (line.quantity * model.batch).toLocaleString() +
        "</td><td>" +
        money(line.unit_cost) +
        "</td><td>" +
        esc(
          {
            checked: "In-game scan",
            estimate: report.tsm.source,
            vendor: "Vendor",
          }[line.source],
        ) +
        "</td></tr>",
    )
    .join("");
  $("sim-stock").hidden = !shortages.length;
  $("sim-stock").textContent = shortages.length
    ? "Assumes the full batch can be bought. Stock shortage · " +
      shortages.join(" / ")
    : "";
  $("sim-volatility").value = saved.simulation?.volatility ?? 10;
  $("sim-trials").value = saved.simulation?.trials ?? 5000;
  const canSize = !model.unitOnly && model.proceeds != null;
  $("sim-gold-label").hidden = $("sim-gold").disabled = !canSize;
  $("sim-gold").value = canSize ? (saved.simulation?.gold ?? "") : "";
  $("simulation").showModal();
}
function simulationStats(stats) {
  return (
    "<dl>" +
    stats
      .map(
        ([label, value]) =>
          "<dt>" + esc(label) + "</dt><dd>" + esc(value) + "</dd>",
      )
      .join("") +
    "</dl>"
  );
}
function kellyResults(k, batch) {
  if (k.unavailable)
    return "<h3>Kelly sizing</h3><p>" + esc(k.unavailable) + "</p>";
  const percent = k.fraction.toLocaleString(undefined, {
    style: "percent",
    maximumFractionDigits: 2,
  });
  const order =
    k.batches.toLocaleString() +
    (k.batches === 1 ? " batch" : " batches") +
    " × " +
    batch.toLocaleString() +
    (batch === 1 ? " craft" : " crafts");
  const stats = [
    ["Suggested spend at current quotes", money(k.spend)],
    ["Order size", order],
    ["Gold left after purchase", money(k.remaining)],
    [
      "Full Kelly target before rounding or stock limits",
      money(k.target) + " (" + percent + " of starting gold)",
    ],
    ["Cost per batch at current quotes", money(k.quote)],
  ];
  let reason = "";
  if (k.fraction === 0)
    reason = "The simulated returns favor keeping your gold. ";
  else if (k.stockLimited) reason = "Checked reagent stock limits this order. ";
  else if (k.batches === 0)
    reason = "No whole batch fits both the budget and the growth objective. ";
  return (
    "<h3>Kelly sizing</h3>" +
    simulationStats(stats) +
    "<p class='hint'>" +
    reason +
    "Sizing treats this batch’s simulated percentage return as the return on the whole order in each trial. Whole batches use current quotes and reserve postage for the maximum output.</p>"
  );
}
function showSimulationResults(result, trials) {
  const { average, median, p5, p95, low, high, bins, profitChance } = result;
  const metric = simulationModel.unitOnly ? "unit price" : "batch cost";
  const stats = [
    ["Mean " + metric, money(average)],
    ["Median " + metric, money(median)],
    ["Middle 90% of " + metric, money(p5) + " – " + money(p95)],
  ];
  if (result.output) {
    stats.push(
      [
        "Mean batch output",
        result.output.mean.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        }) + " pieces",
      ],
      [
        "Middle 90% of output",
        result.output.p5 + " – " + result.output.p95 + " pieces",
      ],
    );
  }
  if (profitChance != null) {
    stats.push(
      ["Mean batch profit", money(result.profit.mean)],
      [
        "Middle 90% of batch profit",
        money(result.profit.p5) + " – " + money(result.profit.p95),
      ],
      ["Trials with positive profit", (100 * profitChance).toFixed(1) + "%"],
    );
  }
  if (result.goldPerHour != null)
    stats.push(["Mean batch gold/hour", hourly(result.goldPerHour)]);
  const peak = Math.max(...bins);
  $("sim-result").innerHTML =
    (result.kelly
      ? kellyResults(result.kelly, simulationModel.batch) +
        "<h3>Simulated batch</h3>"
      : "") +
    simulationStats(stats) +
    (low === high
      ? ""
      : "<p>" +
        result.chartMetric +
        " distribution</p>" +
        '<div class="sim-bars" aria-hidden="true">' +
        bins
          .map((count, idx) => {
            const width = (high - low) / bins.length;
            const range =
              money(low + idx * width) + " – " + money(low + (idx + 1) * width);
            return (
              '<span title="' +
              range +
              " · " +
              count.toLocaleString() +
              ' trials" style="height:' +
              (100 * count) / peak +
              '%"></span>'
            );
          })
          .join("") +
        '</div><div class="sim-axis"><span>Min ' +
        money(low) +
        "</span><span>Max " +
        money(high) +
        "</span></div>");
  $("sim-status").textContent = trials.toLocaleString() + " trials completed.";
}
$("sim-close").onclick = () => $("simulation").close();
$("simulation").onclose = () => {
  clearSimulation();
  simulationModel = null;
};
$("sim-form").oninput = clearSimulation;
$("sim-form").onsubmit = (event) => {
  event.preventDefault();
  if (!$("sim-form").reportValidity() || !simulationModel) return;
  clearSimulation();
  const volatility = $("sim-volatility").valueAsNumber;
  const trials = $("sim-trials").valueAsNumber;
  const model = { ...simulationModel };
  if (model.yield) {
    const min = $("sim-yield-min").valueAsNumber,
      max = $("sim-yield-max").valueAsNumber;
    if (min > max) {
      $("sim-status").textContent =
        "Minimum pieces per craft must be at most the maximum.";
      return;
    }
    const ranges = (saved.yieldRanges ??= {});
    if (min === model.yield.min && max === model.yield.max)
      delete ranges[model.yield.key];
    else ranges[model.yield.key] = { min, max };
    model.yield = { ...model.yield, min, max };
  }
  const gold = $("sim-gold");
  if (!gold.disabled && gold.value !== "") {
    model.bankroll = Math.round(gold.valueAsNumber * 10000);
    if (!Number.isSafeInteger(model.bankroll) || model.bankroll < 0) {
      $("sim-status").textContent =
        "Starting gold exceeds the supported copper range.";
      return;
    }
  }
  saved.simulation = { ...saved.simulation, volatility, trials };
  if (!gold.disabled) saved.simulation.gold = gold.value;
  save();
  $("sim-status").textContent = "Running simulation…";
  try {
    const worker = new Worker("/price-simulation.js");
    simulationWorker = worker;
    worker.onmessage = ({ data }) => {
      if (simulationWorker !== worker) return;
      clearSimulation();
      if (data.error) $("sim-status").textContent = data.error;
      else showSimulationResults(data.result, trials);
    };
    worker.onerror = () => {
      if (simulationWorker !== worker) return;
      clearSimulation();
      $("sim-status").textContent =
        "Simulation interrupted. Run it again to retry.";
    };
    worker.postMessage({ model, trials, volatility });
  } catch {
    clearSimulation();
    $("sim-status").textContent =
      "The browser could not start the simulation worker.";
  }
};

function routeKey(i, r) {
  return (
    i.id +
    "/" +
    (r.recipe_id || r.kind) +
    (r.kind.startsWith("craft_") ? "/" + r.kind : "") +
    (r.stages?.length ? "/chain" : "")
  );
}
function calc(i, r) {
  const settings = prefs().calc[routeKey(i, r)];
  return {
    mail: false,
    back: false,
    stack: 20,
    post: 30,
    returns: 1,
    minProfit: 1,
    ...settings,
    batch: validBatch(settings?.batch) ? settings.batch : saved.batchSize,
  };
}
function pricedRoute(i, r) {
  if (prefs().pricing === "estimates" || view() === "market") return r;
  const c = calc(i, r);
  const postage = summary(i, r, c).postage;
  const cutoff =
    Math.floor(Date.now() / 1000) - (report?.shopping_max_age ?? 900);
  const q = quoteShoppingBatch(i, r, c, postage, listingBook, cutoff);
  const profit = q.profit == null ? null : q.profit / c.batch;
  const timing = r.timing && {
    ...r.timing,
    gold_per_hour:
      profit == null || !r.timing.repeat_seconds
        ? null
        : (profit * 0.36) / r.timing.repeat_seconds,
  };
  return {
    ...r,
    baseRoute: r,
    shopping: q,
    inputs: q.inputs,
    outputs: q.outputs,
    cost: q.cost == null ? null : (q.cost - postage) / c.batch,
    proceeds: q.out == null ? null : q.out / c.batch,
    net_unit_value: q.netUnit,
    profit,
    timing,
    stock: q.short ? "insufficient" : q.issue ? "unknown" : "verified",
  };
}
function summary(i, r, c) {
  const stacks = r.inputs.reduce(
    (sum, l) =>
      sum + Math.ceil((l.quantity * c.batch) / (l.max_stack || c.stack)),
    0,
  );
  const back =
    c.mail && c.back
      ? isCraft(r) && !destroys(r)
        ? Math.ceil((r.quantity * c.batch) / (i.max_stack || c.stack))
        : destroys(r)
          ? c.returns
          : 0
      : 0;
  const postage = c.mail ? (stacks + back) * c.post : 0;
  const cost = r.shopping
      ? r.shopping.cost
      : r.cost == null
        ? null
        : r.cost * c.batch + postage,
    out = r.shopping
      ? r.shopping.out
      : r.proceeds == null
        ? null
        : r.proceeds * c.batch;
  const shortages = r.inputs
    .filter(
      (l) =>
        l.source !== "vendor" &&
        l.listed_units != null &&
        l.quantity * c.batch > l.listed_units,
    )
    .map(
      (l) =>
        l.name +
        " needs " +
        l.quantity * c.batch +
        ", checked " +
        l.listed_units,
    );
  const net = cost == null || out == null ? null : out - cost;
  const seconds = r.timing
    ? r.timing.elapsed_seconds + (c.batch - 1) * r.timing.repeat_seconds
    : null;
  return {
    seconds,
    active: r.timing ? r.timing.active_seconds * c.batch : null,
    goldPerHour:
      net != null && seconds > 0 ? ((net / 10000) * 3600) / seconds : null,
    postage,
    cost,
    out,
    net,
    shortages,
  };
}
function batchTiming(r, b) {
  if (!r.timing) return "";
  const wait = Math.max(0, Math.round((b.seconds - b.active) * 10) / 10);
  return (
    "Estimated batch time " +
    duration(b.seconds) +
    (wait > 0
      ? " (" +
        duration(b.active) +
        " casting, " +
        duration(wait) +
        " cooldown wait)"
      : "") +
    " · Batch profit per hour " +
    hourly(b.goldPerHour)
  );
}
function timingBasis(r) {
  return (
    "Starts with recipes ready. Known recipe cooldowns apply between casts. Travel, mail, vendor visits and auction sale time are excluded." +
    (r.timing.assumed_cast
      ? " Uses a 3s estimate for a craft with no recorded cast time."
      : "")
  );
}
function steps(r) {
  return {
    craft_auction:
      "Buy the reagents, craft the item, then list the output at the auction house.",
    craft_disenchant:
      "Buy the reagents, craft the equipment, disenchant it, then list the resulting materials.",
    craft:
      "Buy the listed reagents, craft the recipe on an eligible character, then sell the output to a vendor.",
    vendor:
      "Buy the checked item at the auction house and sell it to a vendor.",
    disenchant:
      "Buy the equipment, disenchant it on an eligible enchanter, then list the materials at the auction house.",
  }[r.kind];
}
function instructions(i, r, c) {
  const b = summary(i, r, c);
  return [
    "## " + i.name + " — " + r.name,
    routeLabel(r),
    "Runs: " + c.batch,
    ...(r.advice ? [r.advice] : []),
    "Characters: " +
      (r.characters?.join(", ") ||
        (isCraft(r)
          ? "No learned crafter recorded"
          : destroys(r)
            ? "Enchanting required"
            : "Any")),
    "Requirements: " + (reqText(r) || "None recorded"),
    ...r.inputs.map(
      (l) =>
        "- " +
        l.name +
        " × " +
        l.quantity * c.batch +
        " (" +
        l.source +
        ", " +
        money(l.unit_cost) +
        " each, " +
        money(l.cost == null ? null : l.cost * c.batch) +
        " total)",
    ),
    ...(r.outputs || []).map(
      (l) =>
        "- Expected " +
        l.name +
        " × " +
        l.quantity * c.batch +
        " (" +
        l.source +
        ", " +
        money(l.unit_cost) +
        " each)",
    ),
    ...(r.stages?.length ? pathSteps(r, c.batch) : [steps(r)]),
    ...(r.expected_inputs
      ? [
          "Disenchant yields are averages. Extra crafts may be needed to obtain enough materials.",
        ]
      : []),
    "Basis: " +
      r.stock +
      (r.shopping
        ? " · Current listing prices for this batch. "
        : " · Checked prices are weighted averages. ") +
      (destroys(r)
        ? "Random yields; net includes the 5% auction cut and 15% sale reserve."
        : r.kind === "craft_auction"
          ? "Net includes the 5% auction cut and 15% sale reserve."
          : ""),
    ...(r.timing ? [batchTiming(r, b), timingBasis(r)] : []),
    "Postage: " + money(b.postage),
    "Cost: " +
      money(b.cost) +
      " · Proceeds: " +
      money(b.out) +
      " · Profit: " +
      money(b.net),
    ...b.shortages.map((s) => "Stock shortage: " + s),
  ].join("\n");
}
function tsmSearch(order) {
  if (!order.cap || !order.name || /[/;^\r\n]/.test(order.name)) return null;
  return (
    order.name +
    "/exact/" +
    money(order.cap).replaceAll(" ", "") +
    "/x" +
    order.units
  );
}
function shoppingPanel(r, c, input) {
  const q = r.shopping;
  let text =
    "<h4>TSM shopping ceilings</h4>" +
    input(
      "minProfit",
      "Minimum batch profit (copper)",
      Number.MAX_SAFE_INTEGER,
    );
  if (q.issue)
    return (
      text +
      '<p class="hint">' +
      esc(q.issue) +
      " Run /wamsync full at the auction house, then /reload after completion.</p>"
    );
  if (!q.orders.length)
    return text + "<p>This route buys all inputs from vendors.</p>";
  text +=
    "<p>Oldest listing used " +
    esc(timestamp(q.oldest)) +
    ". Projected batch profit " +
    money(q.profit) +
    " at scanned prices. " +
    (q.profit < c.minProfit
      ? "Wait for lower reagent prices to meet your target."
      : "The scanned batch meets your target.") +
    "</p>";
  if (!q.capsReady)
    return (
      text +
      "<p>The remaining budget cannot fund every reagent at a positive whole-copper ceiling.</p>"
    );
  return (
    text +
    "<p>Paste each search into TSM Shopping. Stay within both its unit price and quantity, including the last stack.</p><ul>" +
    q.orders
      .map((o) => {
        const search = tsmSearch(o);
        return (
          "<li>" +
          esc(o.name) +
          " × " +
          o.units +
          " · max " +
          money(o.cap) +
          " each · max spend " +
          money(o.cap * o.units) +
          (o.available < o.units
            ? " · Only " + o.available + " units scanned at or below ceiling"
            : "") +
          (search
            ? " <code>" +
              esc(search) +
              '</code> <button data-tsm="' +
              o.id +
              '">Copy search</button>'
            : " · Enter this ceiling in a TSM Shopping Operation for this item.") +
          "</li>"
        );
      })
      .join("") +
    "</ul>"
  );
}
function detail(i, r, idx, n) {
  const override = prefs().calc[routeKey(i, r)]?.batch;
  const c = calc(i, r),
    b = summary(i, r, c);
  const input = (key, label, max) =>
    "<label>" +
    label +
    ' <input type="number" data-field="' +
    key +
    '" min="' +
    (key === "post" ? 0 : 1) +
    '" max="' +
    max +
    '" value="' +
    c[key] +
    '"></label>';
  const toggle = (key, label) =>
    '<label><input type="checkbox" data-field="' +
    key +
    '" ' +
    (c[key] ? "checked" : "") +
    "> " +
    label +
    "</label>";
  return (
    '<div class="route" data-idx="' +
    idx +
    '" data-route="' +
    n +
    '"><h3>' +
    esc(r.name) +
    " · " +
    esc(routeLabel(r)) +
    "</h3>" +
    (r.advice ? "<p class='estimated'>" + esc(r.advice) + "</p>" : "") +
    "<p>" +
    esc(
      [r.profession, reqText(r), r.characters?.join(", ")]
        .filter(Boolean)
        .join(" · "),
    ) +
    "</p><ul>" +
    r.inputs
      .map(
        (l) =>
          "<li>" +
          esc(l.name) +
          " × " +
          l.quantity * c.batch +
          " · " +
          esc(l.source) +
          " · " +
          money(l.unit_cost) +
          " each · " +
          money(l.cost == null ? null : l.cost * c.batch) +
          " for batch</li>",
      )
      .join("") +
    (r.outputs || [])
      .map(
        (l) =>
          "<li>Expected " +
          esc(l.name) +
          " × " +
          l.quantity * c.batch +
          " · " +
          money(l.unit_cost) +
          " each (" +
          esc(l.source) +
          ")</li>",
      )
      .join("") +
    "</ul>" +
    (r.stages?.length
      ? "<h4>Production steps · " +
        c.batch +
        " final runs</h4><ol>" +
        pathSteps(r, c.batch)
          .map((s) => "<li>" + esc(s) + "</li>")
          .join("") +
        "</ol>"
      : "<p>" + steps(r) + "</p>") +
    (r.expected_inputs
      ? "<p>Disenchant yields are averages. Extra crafts may be needed to obtain enough materials. " +
        esc(report?.catalog?.disenchant_source || "") +
        "</p>"
      : "") +
    '<p class="hint">' +
    esc(r.stock) +
    (r.shopping
      ? " · Current listing prices for this batch."
      : " · Checked prices are weighted averages.") +
    (destroys(r)
      ? " Expected proceeds include the auction cut and sale reserve. Drops and sale prices vary. " +
        esc(report?.catalog?.disenchant_source || "")
      : r.kind === "craft_auction"
        ? " Net includes a 5% auction cut and 15% sale reserve."
        : "") +
    "</p>" +
    '<label>Batch size override <input type="number" data-field="batch" min="1" max="10000" step="1" title="Leave blank to use the dashboard batch size" placeholder="' +
    saved.batchSize +
    '" value="' +
    (validBatch(override) ? override : "") +
    '"></label>' +
    toggle("mail", "Mail to alt") +
    (c.mail
      ? input("stack", "Default stack", 100000) +
        input("post", "Postage (copper)", 100000) +
        (r.kind !== "vendor" ? toggle("back", "Include return mail") : "") +
        (c.back && destroys(r) ? input("returns", "Return stacks", 10000) : "")
      : "") +
    "<p>Postage " +
    money(b.postage) +
    " · Cost " +
    money(b.cost) +
    " · Proceeds " +
    money(b.out) +
    " · <strong>Profit " +
    money(b.net) +
    "</strong></p>" +
    (r.timing
      ? "<p><strong>" +
        batchTiming(r, b) +
        "</strong></p><p class='hint'>" +
        timingBasis(r) +
        "</p>"
      : "") +
    (b.shortages.length
      ? '<p class="estimated">Stock shortage · ' +
        esc(b.shortages.join(" / ")) +
        "</p>"
      : "") +
    (r.shopping ? shoppingPanel(r, c, input) : "") +
    "<button data-copy>Copy Markdown</button> " +
    (isCraft(r) ? craftSimulationButton(r) : "") +
    "</div>"
  );
}
$("body").onclick = async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.row != null) {
    const key = rows[+btn.dataset.row].key;
    prefs().open[key] = !prefs().open[key];
    render();
    document.querySelector('[data-row="' + btn.dataset.row + '"]')?.focus();
  } else if (btn.hasAttribute("data-sim-item")) {
    const item = rows[Number(btn.dataset.simItem)].i;
    const quote = marketQuote(item);
    openSimulation(
      item.name,
      {
        unitOnly: true,
        batch: 1,
        postage: 0,
        proceeds: null,
        lines: [
          {
            name: item.name,
            source: quote.source,
            quantity: 1,
            unit_cost: quote.price,
          },
        ],
      },
      [],
      quote.at,
    );
  } else if (btn.hasAttribute("data-sim-craft")) {
    const el = btn.closest(".route");
    const { i, r } = rows[Number(el.dataset.idx)];
    const route = r || i.routes[Number(el.dataset.route)];
    const c = calc(i, route);
    const batch = summary(i, route, c);
    openSimulation(
      route.name,
      {
        unitOnly: false,
        batch: c.batch,
        postage: batch.postage,
        proceeds: batch.out,
        expectedInputs: !!route.expected_inputs || destroys(route),
        chained: !!route.stages?.length,
        yield: craftYield(i, route, c),
        lines: route.inputs,
      },
      batch.shortages,
      report.generated_at,
    );
  } else if (btn.hasAttribute("data-tsm")) {
    const el = btn.closest(".route");
    const { i, r } = rows[+el.dataset.idx];
    const latest = pricedRoute(
      i,
      r?.baseRoute || i.routes[+el.dataset.route],
    ).shopping;
    const order = latest?.orders.find((o) => o.id === Number(btn.dataset.tsm));
    const search = order && latest.capsReady && tsmSearch(order);
    if (!search) return render();
    try {
      await navigator.clipboard.writeText(search);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Select and copy the search";
    }
  } else if (btn.hasAttribute("data-copy")) {
    const el = btn.closest(".route"),
      { i, r } = rows[+el.dataset.idx],
      route = r || i.routes[+el.dataset.route];
    try {
      await navigator.clipboard.writeText(
        instructions(i, route, calc(i, route)),
      );
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Clipboard unavailable";
    }
  }
};
$("body").onchange = (e) => {
  const x = e.target,
    el = x.closest(".route");
  if (!el || !x.dataset.field) return;
  const { i, r } = rows[+el.dataset.idx],
    route = r || i.routes[+el.dataset.route];
  const settings = (prefs().calc[routeKey(i, route)] ??= {});
  if (x.dataset.field === "batch") {
    if (x.value === "" && !x.validity.badInput) delete settings.batch;
    else if (validBatch(x.valueAsNumber)) settings.batch = x.valueAsNumber;
  } else {
    settings[x.dataset.field] =
      x.type === "checkbox"
        ? x.checked
        : Math.min(+x.max, Math.max(+x.min, Math.floor(+x.value) || +x.min));
  }
  render();
};
$("batchSize").oninput = (e) => {
  const n = e.target.valueAsNumber;
  if (!validBatch(n)) return;
  saved.batchSize = n;
  render();
};
$("batchSize").onblur = (e) => {
  e.target.value = saved.batchSize;
};
for (const key of [
  "search",
  "level",
  "profession",
  "sort",
  "access",
  "route",
  "profitability",
  "pricing",
  "trainingCost",
])
  $(key).oninput = (e) => {
    prefs()[key] = e.target.value;
    prefs().page = 0;
    render();
  };
$("prev").onclick = () => {
  prefs().page--;
  render();
};
$("next").onclick = () => {
  prefs().page++;
  render();
};
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const res = await fetch("/api/report", {
      headers: etag ? { "If-None-Match": etag } : {},
      cache: "no-store",
    });
    if (res.status !== 304) {
      if (!res.ok) throw Error("HTTP " + res.status);
      report = await res.json();
      listingBook = indexListings(report.items);
      etag = res.headers.get("etag");
    }
    offline = "";
    $("connection").textContent = "Connected";
    $("connection").className = "online";
  } catch (e) {
    offline =
      "Connection lost. " +
      (report ? "Showing the last received report. " : "") +
      e.message;
    $("connection").textContent = "Offline";
    $("connection").className = "";
  } finally {
    busy = false;
    render();
  }
}
$("refresh").onclick = refresh;
window.onhashchange = setup;
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
setInterval(() => {
  if (!document.hidden) refresh();
}, 30000);
setup();
refresh();
