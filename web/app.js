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
let routePage;
function view() {
  if (routePage?.detail) return "market";
  if (routePage) return routePage.from === "market" ? "opportunities" : routePage.from;
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
  listingPage = 0;
  routePage = readRouteAddress();
  document.body.classList.toggle("route-view", !!routePage);
  document.body.classList.toggle("item-view", !!routePage?.detail);
  if (!routePage) document.title = titles[view()] + " · WoW Auction Monitor";
  $("routePage").hidden = $("routeBack").hidden = !routePage;
  if (routePage) {
    $("routeBack").href = "/#" + routePage.from;
    $("routeBack").textContent = "← " + titles[routePage.from];
  }
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
  $("pricing").value = p.pricing || "forecast";
  $("floor").value = p.floor || "0";
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
          ["estimate", "Highest latest price"],
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
    (AuctionMath.scalar.batch_units(n, batch)).toLocaleString(undefined, { maximumFractionDigits: 4 });
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
  const byHour = prefs().sort === "gold_per_hour";
  const list = rows.length ? AuctionMath.call("training", rows.map(({r}) => ({
    kind:r.kind, profit:r.profit, score:byHour ? r.timing?.gold_per_hour : r.profit,
    ready:r.ready, stock:r.stock, profession:r.profession,
  }))).map(index => rows[index]) : [];
  const trainingGold = Number(prefs().trainingCost);
  const payback = (profit) =>
    trainingGold > 0 && Number.isFinite(trainingGold)
      ? " · " +
        AuctionMath.scalar.training_runs(trainingGold, profit).toLocaleString() +
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
              '<a href="' + esc(routeHref(i, r, "professions")) + '">' + esc(i.name) + '</a>' +
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
function render(preserveDraft = false) {
  const v = view(),
    p = prefs(),
    market = v === "market",
    items = report?.items || [],
    tsm = report?.tsm || {};
  $("floorLabel").hidden = market || p.pricing !== "percentile";
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
    if (report.catalog?.desktop_at && tsm.source !== "Desktop AppHelper") {
      $("source").textContent += " · Desktop last synced " + timestamp(report.catalog.desktop_at);
    }
    $("client-upload").textContent = report.uploaded_at
      ? "Last upload " + timestamp(report.uploaded_at)
      : "Awaiting first client upload";
    $("age").textContent = age(tsm.observed_at);
    $("observed").textContent = timestamp(tsm.observed_at);
    const blizzard = report.blizzard;
    $("blizzard-stats").hidden = !blizzard?.enabled;
    if (blizzard?.enabled) {
      $("blizzard-count").textContent = blizzard.total.toLocaleString() + " items";
      const info = [];
      if (blizzard.latest_at) info.push("Latest snapshot " + timestamp(blizzard.latest_at));
      info.push(blizzard.last_pull_at ? "Last check " + timestamp(blizzard.last_pull_at) : "Waiting for first check");
      if (blizzard.error) info.push(blizzard.error);
      $("blizzard-observed").textContent = info.join(" · ");
    }
    const broker = report.booty_bay_broker;
    $("broker-stats").hidden = !(broker?.total || broker?.configured_items);
    if (!$("broker-stats").hidden) {
      $("broker-count").textContent = broker.fresh + " of " + broker.total + " fresh";
      const info = [];
      if (broker.latest_at) info.push("Latest observation " + timestamp(broker.latest_at));
      if (broker.configured_items) info.push(broker.last_pull_at
        ? "Last server pull " + timestamp(broker.last_pull_at)
        : "Server checking " + broker.configured_items.toLocaleString() + " items");
      if (broker.pull_error) info.push(broker.pull_error);
      $("broker-observed").textContent = info.join(" · ");
    }
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
      ? "The latest TSM update is stale. Each item shows the newest price available for this market."
      : "");
  $("notice").hidden = !notice;
  $("notice").textContent = notice;
  rows = [];
  if (routePage) {
    if (routePage.detail) renderItemPage();
    else renderRoutePage(preserveDraft);
    save();
    return;
  }
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
          "Latest unit price",
          "Checked average",
          "Checked units",
          "Last check",
        ]
      : [
          "Item",
          "Route",
          (!p.pricing || p.pricing === "forecast") ? "Mean cost / run" : "Cost / run",
          (!p.pricing || p.pricing === "forecast") ? "Mean profit / run" : "Profit / run",
          "Time / run",
          "Repeat gold/hour",
          "Stock",
          ...(showBatch ? ["Batch estimate"] : []),
        ]
    )
      .map((s) => "<th>" + s + "</th>")
      .join("") +
    "</tr>";
  const focusedHour = document.activeElement.closest(".hourly-chart")?.dataset.chartKey;
  $("body").innerHTML = rows
    .slice(start, start + 40)
    .map(({ i, r, key }, j) => {
      const open = market && !!p.open[key],
        idx = start + j;
      const cells = market
        ? [
            money(i.estimate) + (i.estimate_source ? "<br><small>" + esc(priceObservation(i)) + "</small>" : ""),
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
                : AuctionMath.scalar.unit_value(r.shopping.cost, calc(i, r).batch),
            ),
            '<span class="' +
              profitability(r.profit) +
              '">' +
              (r.profit == null ? "Unknown" : money(r.profit)) +
              "</span>" + (r.forecast?.winPercent != null ? "<br><small>" + r.forecast.winPercent.toFixed(1) + "% profitable trials</small>" : ""),
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
      const title = esc(i.name) + ' <span class="id">#' + i.id + '</span>';
      const rowLink = market
        ? '<button class="rowname" data-row="' + idx + '" aria-expanded="' + open + '">' +
          (open ? "▾ " : "▸ ") + title + '</button>'
        : '<a class="rowname" aria-label="' + esc(i.name + " · " + routeLabel(r)) + '" href="' + esc(routeHref(i, r, v)) + '">' + title + '</a>';
      return (
        (market ? '<tr>' : '<tr class="route-row">') + '<td>' + rowLink + (market ? ' ' + itemLink(i.id, "Prices and listings") : '') + '</td>' +
        cells.map((x) => "<td>" + x + "</td>").join("") +
        "</tr>" +
        (open
          ? '<tr><td colspan="' +
            (cells.length + 1) +
            '"><div class="detail"><p class="hint">' +
            esc(i.estimate_source || (i.estimate != null ? tsm.source : "No recorded auction price")) +
            " · " +
            timestamp(i.estimate_at ?? (i.estimate != null ? tsm.observed_at : null)) +
            (i.broker_price ? " · Booty Bay Broker lowest buyout " + money(i.broker_price.price) +
              " seen " + timestamp(i.broker_price.observed_at) : "") +
            " · Estimated auctions " +
            esc(i.estimated_auctions) +
            " · Checked auctions " +
            esc(i.checked_auctions) +
            " · Vendor payout " +
            money(i.vendor_sell) +
            "</p>" +
            (market ? marketHistory(i) + marketSimulationButton(i, idx) : "") +
            (i.routes.length ? '<h3>Routes</h3><ul class="item-routes">' +
              i.routes.map(route => '<li><a href="' + esc(routeHref(i, route, "market")) + '">' +
                esc(route.name + " · " + routeLabel(route)) + '</a></li>').join("") + '</ul>' : "") +
            "</div></td></tr>"
          : "")
      );
    })
    .join("");
  if (focusedHour) {
    const chart = [...$("body").querySelectorAll(".hourly-chart")].find(el => el.dataset.chartKey === focusedHour);
    chart?.querySelector(".hour-slider").focus({preventScroll: true});
  }
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
function priceObservation(item) {
  if (item?.estimate == null) return "No recorded auction price";
  return [
    item.estimate_source,
    item.estimate_at ? age(item.estimate_at) : "",
    item.estimate_stale ? "Stale" : "",
  ].filter(Boolean).join(" · ");
}
function lineBasis(line, route) {
  if (route.percentileMode && line.quote_status) {
    if (line.source === "vendor" || line.source === "bound") return line.source;
    if (line.source === "percentile") {
      return "P" + (+line.percentile.toFixed(2)) + " · " + line.depth.available.toLocaleString()
        + " units listed · " + line.depth.source + " · " + age(line.depth.observed_at);
    }
    if (line.quote_status === "insufficient") return "Insufficient supply · " + line.depth.source + " · " + age(line.depth.observed_at);
    if (line.quote_status === "budget_overflow") return "Purchase budget exceeds the copper limit";
    return "No price levels · Planning estimate · " + priceObservation(listingBook.get(line.id));
  }
  if (route.shopping || !["estimate", "checked"].includes(line.source)) return line.source;
  return priceObservation(listingBook.get(line.id));
}
function marketSimulationButton(item, idx) {
  return item.estimate > 0
    ? '<button class="sim-launch" aria-haspopup="dialog" data-sim-item="' +
        idx +
        '">Simulate unit price</button>'
    : '<p class="hint">No auction price has been recorded for this item.</p>';
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
const defaultSimAssumptions = $("sim-assumptions").textContent;
function clearSimulation() {
  simulationWorker?.terminate();
  simulationWorker = null;
  $("sim-result").replaceChildren();
  $("sim-status").textContent = "";
}
function craftYield(item, route, c) {
  if (route.forecast) route = route.baseRoute;
  return {
    key: "recipe/" + (route.recipe_id || item.id),
    min: route.quantity_min ?? route.quantity,
    max: route.quantity_max ?? route.quantity,
    base: route.quantity,
    netPerUnit:
      route.net_unit_value ??
      (route.proceeds == null ? null : AuctionMath.scalar.unit_value(route.proceeds, route.quantity)),
    marketSale: route.kind === "craft_auction" || destroys(route),
    saleItems: route.kind === "craft_auction"
      ? [{id: item.id, name: item.name, quantity: route.quantity, unit_cost: item.estimate ?? null}]
      : (route.outputs || []),
    timing: route.timing,
    returnStack:
      c.mail && c.back && !destroys(route) ? item.max_stack || c.stack : null,
    post: c.post,
  };
}
function openSimulation(name, model, shortages, at, preserveDraft = false) {
  const draft = preserveDraft ? [...$("sim-form").querySelectorAll("input")].map(el=>[el,el.value]) : null;
  clearSimulation();
  simulationModel = model;
  displayedTrial = null;
  $("sim-title").textContent =
    name + (model.optimize ? " · Optimal craft quantity" : model.order ? " · Crafting cost" : model.unitOnly ? " · Unit price" : " · Craft batch");
  $("sim-context").textContent = model.optimize
    ? "Compare whole-craft quantities across the same simulated markets. The recommendation maximizes average total profit, including skipped orders."
    : model.order
    ? "Enter the number of finished pieces you want. Each trial rolls the output of each cast until it reaches your target. Every whole number in the yield range is equally likely." +
      (model.chained ? " Intermediate steps use the route’s planned inputs and expected yields." : "")
    : model.unitOnly
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
      " pieces per final craft. Each cast rolls independently with equal odds for each whole number. Auction sale prices vary with the price deviation. Vendor prices are fixed." +
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
  $("sim-limit-label").hidden = $("sim-limit").disabled = !model.optimize;
  $("sim-budget-label").hidden = $("sim-budget").disabled = !model.optimize;
  $("sim-limit").value = saved.optimizer?.limit ?? 100;
  $("sim-budget").value = saved.optimizer?.budget ?? "";
  $("sim-form").querySelector("button").textContent = model.optimize ? "Find best quantity" : "Run simulation";
  $("sim-target-label").hidden = $("sim-target").disabled = !model.order || !!model.optimize;
  $("sim-stock-spread-label").hidden = $("sim-stock-spread").disabled = !model.order;
  $("sim-target").value = model.order ? (saved.orderTargets?.[model.yield.key] ?? model.target) : "";
  $("sim-stock-spread").value = saved.simulation?.stockSpread ?? 10;
  $("sim-columns").innerHTML = (model.order
    ? ["Reagent", "Per cast", "Auction listings", "Vendor / unit"]
    : ["Item", "Quantity", "Quote per unit", "Source"]).map(label => "<th>" + label + "</th>").join("");
  $("sim-sales").textContent = "";
  $("sim-assumptions").textContent = model.optimize
    ? "Auction prices and stock vary around their last observations. Each cast rolls its yield. Vendor prices are fixed. A trial skips the whole order if stock or gold runs short, earning zero. Filled orders include losses and assume all output sells. A tie favors fewer crafts."
    : model.order
    ? "Prices and listed stack counts vary independently around the last recorded in-game or Blizzard snapshot. Older observations are marked Stale. Each reagent gets its own normal price and stock draws. Purchases use whole stacks, cheapest per unit first, and can use a vendor at a fixed price. Reagent cost excludes postage."
    : defaultSimAssumptions;
  $("sim-inputs").innerHTML = model.order ? orderInputTable(model.lines) : model.lines
    .map(
      (line) =>
        "<tr><td>" +
        esc(line.name) +
        "</td><td>" +
        (AuctionMath.scalar.batch_units(line.quantity, model.batch)).toLocaleString() +
        "</td><td>" +
        money(line.unit_cost) +
        "</td><td>" +
        esc(
          {
            percentile: line.source === "percentile" ? "P" + (+line.percentile.toFixed(2)) + " · " + line.depth.source : "Quantity percentile",
            checked: "In-game scan",
            estimate: listingBook.get(line.id)?.estimate_source || report.tsm.source,
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
  if (draft) {
    for (const [el,value] of draft) if (!el.disabled) el.value = value;
    $("sim-status").textContent = "Market data updated. Run with the latest quotes.";
    return;
  }
  $("simulation").showModal();
  if (model.optimize) $("sim-limit").focus();
  else if (model.order) $("sim-target").focus();
  showPreparedTrial(model);
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
  if (simulationModel.optimize) {
    $("sim-status").textContent = trials.toLocaleString() + " trials completed.";
    $("sim-result").innerHTML = optimizationResults(result);
    $("sim-status").scrollIntoView?.({ block: "start" });
    return;
  }
  $("sim-status").textContent = trials.toLocaleString() + " trials completed.";
  if (simulationModel.order) {
    $("sim-result").innerHTML = orderResults(result, trials, simulationModel.lines);
    $("sim-status").scrollIntoView?.({ block: "start" });
    return;
  }
  const { average, median, p5, p95, profitChance } = result;
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
      ["Trials with positive profit", result.profitPercent.toFixed(1) + "%"],
    );
  }
  if (result.goldPerHour != null)
    stats.push(["Mean batch gold/hour", hourly(result.goldPerHour)]);
  $("sim-result").innerHTML =
    (result.kelly
      ? kellyResults(result.kelly, simulationModel.batch) +
        "<h3>Simulated batch</h3>"
      : "") +
    simulationStats(stats) + simulationDistribution(result);
}
function simulationDistribution({ low, high, bars, chartMetric }) {
  return low === high
      ? ""
      : "<p>" +
        chartMetric +
        " distribution</p>" +
        '<div class="sim-bars" aria-hidden="true">' +
        bars
          .map(({count, from, to, height}) => {
            const range = money(from) + " – " + money(to);
            return (
              '<span title="' +
              range +
              " · " +
              count.toLocaleString() +
              ' trials" style="height:' +
              height +
              '%"></span>'
            );
          })
          .join("") +
        '</div><div class="sim-axis"><span>Min ' +
        money(low) +
        "</span><span>Max " +
        money(high) +
        "</span></div>";
}
$("sim-close").onclick = () => $("simulation").close();
$("simulation").onclose = () => {
  clearSimulation();
  simulationModel = null;
  if (report && view() !== "market" && (prefs().pricing || "forecast") === "forecast") render(true);
  if (report) { warmCustomRoutes(); warmTrials(); }
};
$("sim-form").oninput = () => { displayedTrial = null; clearSimulation(); };
$("sim-form").onsubmit = async (event) => {
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
    model.bankroll = AuctionMath.scalar.gold_to_copper(gold.valueAsNumber);
    if (!Number.isSafeInteger(model.bankroll) || model.bankroll < 0) {
      $("sim-status").textContent =
        "Starting gold exceeds the supported copper range.";
      return;
    }
  }
  saved.simulation = { ...saved.simulation, volatility, trials };
  if (model.optimize) {
    model.limit = $("sim-limit").valueAsNumber;
    const budget = $("sim-budget");
    model.bankroll = budget.value === "" ? null : AuctionMath.scalar.gold_to_copper(budget.valueAsNumber);
    if (model.bankroll != null && !Number.isSafeInteger(model.bankroll)) {
      $("sim-status").textContent = "Gold budget exceeds the supported range.";
      return;
    }
    saved.optimizer = {limit: model.limit, budget: budget.value};
  } else if (model.order) {
    model.target = $("sim-target").valueAsNumber;
    (saved.orderTargets ??= {})[model.yield.key] = model.target;
  }
  if (model.order) {
    model.stockSpread = $("sim-stock-spread").valueAsNumber;
    saved.simulation.stockSpread = model.stockSpread;
  }
  if (!gold.disabled) saved.simulation.gold = gold.value;
  save();
  if (model.order) {
    try {
      model.lines = resolveOrderListings(model,true);
    } catch (error) {
      $("sim-status").textContent = error.message;
      return;
    }
  }
  const cache = trialCache;
  const key = trialKey(model,trials,volatility);
  if (cache.has(key) && displayedTrial !== key) {
    displayedTrial = key;
    showSimulationResults(cache.get(key),trials);
    return;
  }
  $("sim-status").textContent = model.optimize ? "Simulating markets and comparing craft sizes…" : "Running simulation…";
  try {
    const worker = new Worker("/price-simulation.js");
    simulationWorker = worker;
    worker.onmessage = ({ data }) => {
      if (simulationWorker !== worker) return;
      clearSimulation();
      if (data.error) $("sim-status").textContent = data.error;
      else {
        cache.set(key,data.result);
        displayedTrial = key;
        showSimulationResults(data.result,trials);
      }
    };
    worker.onerror = () => {
      if (simulationWorker !== worker) return;
      clearSimulation();
      $("sim-status").textContent =
        "Simulation interrupted. Run it again to retry.";
    };
    worker.postMessage({ model, trials, volatility, module: AuctionMath.module });
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
function calc(i, r, preferences = prefs()) {
  const settings = preferences.calc[routeKey(i, r)];
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
let routeQuotes = new WeakMap(), forecastQuotes = new WeakMap();
function pricedRoute(i, r, preferences = prefs()) {
  const basis = preferences.pricing || "forecast";
  if (basis === "forecast") return forecastRoute(i, r);
  if (!["listings", "percentile"].includes(basis)) return r;
  const c = calc(i, r, preferences);
  const age = basis === "percentile" ? (report.depth_max_age ?? 21600) : (report.shopping_max_age ?? 900);
  const cutoff = AuctionMath.scalar.quote_cutoff(Date.now(), age);
  const epoch = AuctionMath.scalar.freshness_epoch(cutoff, basis === "percentile");
  const key = JSON.stringify([basis, c, preferences.floor, epoch]);
  let variants = routeQuotes.get(r);
  if (!variants) routeQuotes.set(r, variants = new WeakMap());
  const cached = variants.get(preferences);
  if (cached?.key === key) return cached.route;
  const patch = AuctionMath.call("priceRoute", itemForPricing(i), routeForPricing(r), c, basis, Number(preferences.floor || 0), cutoff);
  const route = {...r, ...patch, baseRoute:r};
  variants.set(preferences, {key, route});
  return route;
}
function forecastRoute(item, route) {
  const sigma = saved.simulation?.volatility ?? 10;
  const key = "recipe/" + (route.recipe_id || item.id);
  const range = isCraft(route) && saved.yieldRanges?.[key];
  const cacheKey = ["forecast", sigma, range?.min, range?.max].join("/");
  const cached = forecastQuotes.get(route);
  if (cached?.key === cacheKey) return cached.route;
  const output = craftYield(item, route, {mail: false});
  if (range) Object.assign(output, range);
  const model = {batch: 1, lines: route.inputs, proceeds: route.proceeds, yield: output};
  // Repeatable screening trials keep the table stable when filtering or navigating.
  const forecast = sigma === 10 && !range && route.screening ? route.screening : AuctionMath.call("forecast", model, 512, sigma, item.id);
  const timing = route.timing && {...route.timing, gold_per_hour: forecast.repeatGoldPerHour};
  const priced = {
    ...route, forecast, baseRoute: route, timing,
    cost: forecast.cost, proceeds: forecast.proceeds, profit: forecast.profit,
  };
  forecastQuotes.set(route, {key: cacheKey, route: priced});
  return priced;
}
function basisText(r) {
  if (r.forecast) return "Monte Carlo forecast from 512 one-run trials at " + (saved.simulation?.volatility ?? 10) + "% price deviation. Assumes the quoted inputs can be bought.";
  if (r.percentileMode) return "Quantity percentile budgets each reagent at its selected unit price.";
  return r.shopping ? "Current listing prices for this batch." : "Latest available prices. In-game prices are unit-weighted averages.";
}
function summary(i, r, c) {
  return AuctionMath.call("summary", itemForPricing(i), routeForPricing(r), c);
}
function batchTiming(r, b) {
  if (!r.timing) return "";
  const wait = b.wait;
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
        AuctionMath.scalar.batch_units(l.quantity, c.batch) +
        " (" +
        lineBasis(l, r) +
        ", " +
        money(l.unit_cost) +
        " each, " +
        money(l.cost == null ? null : AuctionMath.scalar.batch_units(l.cost, c.batch)) +
        " total)",
    ),
    ...(r.outputs || []).map(
      (l) =>
        "- Expected " +
        l.name +
        " × " +
        AuctionMath.scalar.batch_units(l.quantity, c.batch) +
        " (" +
        lineBasis(l, r) +
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
      " · " + basisText(r) + " " +
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
          money(AuctionMath.scalar.batch_units(o.cap, o.units)) +
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
const main = document.querySelector("main");
bindHourlyCharts(main);
main.onclick = async (e) => {
  const btn = e.target.closest("button");
  if (!btn) {
    const row = e.target.closest(".route-row");
    if (row && !e.target.closest("a") && !window.getSelection()?.toString() &&
        !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) navigateDashboard(row.querySelector("a").href);
    return;
  }
  if (btn.dataset.listPage) {
    listingPage += btn.dataset.listPage === "next" ? 1 : -1;
    renderItemPage();
    $("routePage").querySelector('[data-list-page="' + btn.dataset.listPage + '"]:not(:disabled)')?.focus({preventScroll:true});
  } else if (btn.dataset.period) {
    prefs().chartPeriod = btn.dataset.period;
    render();
    $("routePage").querySelector('[data-period="' + btn.dataset.period + '"]').focus({preventScroll:true});
  } else if (btn.dataset.row != null) {
    const key = rows[+btn.dataset.row].key;
    prefs().open[key] = !prefs().open[key];
    render();
    document.querySelector('[data-row="' + btn.dataset.row + '"]')?.focus();

  } else if (btn.hasAttribute("data-sim-item")) {
    const item = rows[Number(btn.dataset.simItem)].i;
    openSimulation(
      item.name,
      unitModel(item),
      [],
      item.estimate_at,
    );
  } else if (btn.hasAttribute("data-sim-order") || btn.hasAttribute("data-optimize")) {
    const { i, r } = rows[Number(btn.closest(".route").dataset.idx)];
    const model = craftOrderModel(i, r, calc(i, r));
    model.optimize = btn.hasAttribute("data-optimize");
    openSimulation(i.name, model, [], report.generated_at);
  } else if (btn.hasAttribute("data-sim-craft")) {
    const el = btn.closest(".route");
    const { i, r } = rows[Number(el.dataset.idx)];
    const route = r?.forecast ? r.baseRoute : r || i.routes[Number(el.dataset.route)];
    const c = calc(i, route);
    const batch = summary(i, route, c);
    openSimulation(
      route.name,
      batchModel(i,route,c,batch),
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
main.onchange = (e) => {
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
  warmCustomRoutes();
  warmTrials();
  render();
};
$("batchSize").oninput = (e) => {
  const n = e.target.valueAsNumber;
  if (!validBatch(n)) return;
  saved.batchSize = n;
  warmCustomRoutes();
  warmTrials();
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
  "floor",
  "trainingCost",
])
  $(key).oninput = (e) => {
    prefs()[key] = e.target.value;
    if (key === "floor" || key === "pricing") { warmCustomRoutes(); warmTrials(); }
    if (!routePage) prefs().page = 0;
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
    await AuctionMath.load();
    const res = await fetch("/api/dashboard", {
      headers: etag ? { "If-None-Match": etag } : {},
      cache: "no-store",
    });
    if (res.status === 202) {
      $("connection").textContent = "Preparing dashboard…";
      setTimeout(refresh, 1000);
      return;
    }
    if (res.status !== 304) {
      if (!res.ok) throw Error("HTTP " + res.status);
      const next = await res.json();
      listingBook = indexListings(next.items);
      routeQuotes = new WeakMap();
      forecastQuotes = new WeakMap();
      report = next;
      warmTrials(true);
      refreshOpenSimulation();
      timingCache.clear();
      archivedSeries.clear();
      warmCustomRoutes();
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
    render(true);
  }
}
$("refresh").onclick = refresh;
let lastAddress = location.href;
function locationChanged() {
  if (lastAddress === location.href) return;
  lastAddress = location.href;
  setup();
}
function navigateDashboard(href) {
  if (location.href === href) return;
  history.pushState(null,"",href);
  locationChanged();
  if (document.querySelector("h1")) {
    document.querySelector("h1").setAttribute("tabindex","-1");
    document.querySelector("h1").focus({preventScroll:true});
  }
  document.documentElement.scrollTop = 0;
}
document.addEventListener("click", event => {
  const anchor = event.target.closest?.("a[href]");
  if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
      event.shiftKey || event.altKey || anchor.target || anchor.hasAttribute("download")) return;
  const url = new URL(anchor.href);
  if (url.origin !== location.origin || !["/","/item","/route"].includes(url.pathname)) return;
  event.preventDefault();
  navigateDashboard(url.href);
});
window.onhashchange = locationChanged;
window.onpopstate = locationChanged;
window.addEventListener("pagehide", () => { ++trialRun; trialWorker?.terminate(); trialWorker = null; });

window.addEventListener("pageshow", event => {
  if (!event.persisted) return;
  try { saved = JSON.parse(sessionStorage.wam || JSON.stringify(saved)); } catch {}
  setup();
  warmTrials();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
setInterval(() => {
  if (!document.hidden) refresh();
}, 30000);
setup();
refresh();
