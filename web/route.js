"use strict";

function readRouteAddress() {
  if (location.pathname !== "/route") return null;
  const q = new URLSearchParams(location.search);
  return {
    item: Number(q.get("item")),
    kind: q.get("exit"),
    recipe: q.get("recipe") ?? "",
    path: q.get("path") || "direct",
    from: Object.hasOwn(titles, q.get("from"))
      ? q.get("from")
      : "opportunities",
  };
}

function routeHref(item, route, from) {
  const q = new URLSearchParams({ item: item.id, exit: route.kind });
  if (route.recipe_id != null) q.set("recipe", route.recipe_id);
  q.set("path", route.stages?.length ? "chain" : "direct");
  q.set("from", from);
  return "/route?" + q;
}

function routeMaterials(item, route, batch) {
  const materials = new Map();
  function add(id, name, role, purchase) {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const material = materials.get(id) || {
      id,
      name: name || listingBook.get(id)?.name || "Item " + id,
      roles: new Set(),
    };
    material.roles.add(role);
    if (purchase) material.purchase = purchase;
    materials.set(id, material);
  }
  for (const line of route.inputs) add(line.id, line.name, "Purchase", line);
  for (const stage of route.stages || []) {
    for (const line of stage.inputs || [])
      add(line.id, line.name, "Stage ingredient");
    add(
      stage.item,
      stage.name,
      stage.action === "disenchant" ? "Disenchanted" : "Intermediate craft",
    );
    for (const line of stage.outputs || [])
      add(line.id, line.name, "Disenchant material");
  }
  for (const line of route.final_inputs || [])
    add(line.id, line.name, "Final ingredient");
  add(
    item.id,
    item.name,
    destroys(route)
      ? "Disenchanted"
      : route.kind === "craft_auction"
        ? "Auction sale"
        : "Vendor sale",
  );
  for (const line of route.outputs || [])
    add(line.id, line.name, "Disenchant sale");
  return [...materials.values()].map((m) => ({
    ...m,
    need: m.purchase ? AuctionMath.scalar.batch_units(m.purchase.quantity, batch) : 1,
  }));
}

function historyForMaterials(materials, route) {
  const sorted = [...materials].sort((a, b) => a.id - b.id);
  const requests = [];
  for (let i = 0; i < sorted.length; i += 128) {
    const pairs = sorted.slice(i, i + 128).map((m) => m.id + ":" + m.need);
    requests.push(
      "/api/price-history?items=" +
        pairs.join(",") +
        (route.percentileMode ? "&floor=" + Number(prefs().floor || 0) : ""),
    );
  }
  return requests.join("|");
}

function materialCard(material, route, history, daily) {
  const { id, name, roles, purchase, need } = material;
  const i = listingBook.get(id);
  const entry = timingCache.get(history);
  const samples = (entry?.data?.items[id] || [])
    .filter((row) => row[1] != null)
    .map(([t, v]) => [t, v]);
  const stock =
    i?.purchase_depth ??
    (i?.checked_at
      ? { available: i.listed_units, observed_at: i.checked_at }
      : null);
  let chart = "";
  if (samples.length) {
    const low = bestHour(samples, false),
      high = bestHour(samples, true);
    chart = daily
      ? dailyPriceChart(samples, history, "daily/" + id)
      : hourlyChart([["Unit price", low]], history, "material/" + id, high);
  } else if (entry?.data) {
    chart =
      '<p class="chart-empty">No auction prices recorded for this item in the last 28 days.</p>';
  } else {
    chart =
      '<p class="chart-empty">' +
      (entry?.error ? "Price history unavailable." : "Loading price history…") +
      "</p>";
  }
  return `<section class="material-card">
    <p class="material-role">${esc([...roles].join(" · "))}</p>
    <h3>${esc(name)} <small>#${id}</small></h3>
    <dl class="material-facts">
      ${purchase ? `<div><dt>Batch purchase</dt><dd>${esc(need.toLocaleString())} × ${money(purchase.unit_cost)} <small>${esc(lineBasis(purchase, route))}</small></dd></div>` : ""}
      <div><dt>Latest auction price</dt><dd>${money(i?.estimate)} <small>${esc(priceObservation(i))}</small></dd></div>
      ${stock?.available != null ? `<div><dt>Listed units</dt><dd>${stock.available.toLocaleString()} <small>${esc(age(stock.observed_at))}</small></dd></div>` : ""}
      ${i?.vendor_buy != null ? `<div><dt>Vendor purchase</dt><dd>${money(i.vendor_buy)} each</dd></div>` : ""}
      ${i?.vendor_sell != null ? `<div><dt>Vendor payout</dt><dd>${money(i.vendor_sell)} each</dd></div>` : ""}
    </dl>${chart}</section>`;
}

function purchaseBreakdown(r, c) {
  const amounts = AuctionMath.call("breakdown", r.inputs, c.batch);
  const lines = r.inputs.map((l, j) => {
    const {cost, share} = amounts[j];
    return `<li><div class="cost-label"><span>${esc(l.name)} × ${(AuctionMath.scalar.batch_units(l.quantity, c.batch)).toLocaleString()}</span>
      <strong>${money(cost)}${share != null ? " · " + Math.round(share) + "%" : ""}</strong></div>
      ${share != null ? `<div class="cost-track"><i style="width:${share}%"></i></div>` : ""}
      <small>${esc(lineBasis(l, r))} · ${money(l.unit_cost)} each</small></li>`;
  });
  return '<ul class="cost-list">' + lines.join("") + "</ul>";
}

function fullRoute(item, r) {
  const c = calc(item, r),
    b = summary(item, r, c);
  const materials = routeMaterials(item, r, c.batch);
  const history = historyForMaterials(materials, r);
  const daily = prefs().chartPeriod === "daily";
  const override = prefs().calc[routeKey(item, r)]?.batch;
  const field = (key, label, max) =>
    `<label>${label}<input type="number" data-field="${key}" min="${key === "post" ? 0 : 1}" max="${max}" value="${c[key]}"></label>`;
  const toggle = (key, label) =>
    `<label><input type="checkbox" data-field="${key}" ${c[key] ? "checked" : ""}>${label}</label>`;
  const metric = (label, value, cls = "") =>
    `<div><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;
  const production = r.stages?.length ? pathSteps(r, c.batch) : [steps(r)];
  const expected = (r.outputs || []).map(
    (l) =>
      `<li>${esc(l.name)} × ${(AuctionMath.scalar.batch_units(l.quantity, c.batch)).toLocaleString(undefined, { maximumFractionDigits: 4 })} expected · ${money(l.unit_cost)} each</li>`,
  );
  return {
    history,
    html: `<div class="route route-report" data-idx="0" data-route="0">
    <p class="route-subtitle">${esc([routeLabel(r), r.name !== item.name ? r.name : "", r.profession, c.batch.toLocaleString() + (c.batch === 1 ? " run" : " runs")].filter(Boolean).join(" · "))}</p>
    <dl class="route-metrics">
      ${metric("Batch profit", money(b.net), profitability(b.net))}
      ${metric("Batch cost", money(b.cost))}${metric("Sale proceeds", money(b.out))}
      ${metric("Batch time", duration(b.seconds))}${metric("Batch gold per hour", hourly(b.goldPerHour))}
    </dl>
    <div class="route-actions">${isCraft(r) ? '<button class="sim-launch" aria-haspopup="dialog" data-sim-order>Estimate cost for a quantity</button><button class="sim-launch" aria-haspopup="dialog" data-optimize>Find optimal craft quantity</button>' + craftSimulationButton(r) : ""}<button data-copy>Copy Markdown</button></div>
    <div class="route-columns">
      <section class="route-panel"><h2>Production plan</h2>
        <ol class="production-list">${production.map((s) => "<li>" + esc(s) + "</li>").join("")}</ol>
        ${isCraft(r) ? `<p>Planned output · ${(AuctionMath.scalar.batch_units(r.quantity, c.batch)).toLocaleString()} × ${esc(item.name)}${r.quantity_min != null && r.quantity_max !== r.quantity_min ? " · " + r.quantity_min + "–" + r.quantity_max + " per craft" : ""}</p>` : ""}
        ${expected.length ? "<h3>Expected disenchant materials</h3><ul>" + expected.join("") + "</ul>" : ""}
        ${r.expected_inputs || destroys(r) ? '<p class="hint">Disenchant yields are averages. ' + esc(report.catalog?.disenchant_source || "") + "</p>" : ""}
        <h3>Character requirements</h3>
        <p>${esc([r.required_character_level == null ? "Character level unknown" : "Level " + r.required_character_level, reqText(r)].filter(Boolean).join(" · "))}</p>
        ${r.characters?.length ? "<p>Eligible characters · " + esc(r.characters.join(", ")) + "</p>" : ""}
        ${r.advice ? "<p>" + esc(r.advice) + "</p>" : ""}
      </section>
      <section class="route-panel"><h2>Purchase breakdown</h2>${purchaseBreakdown(r, c)}
        <p class="hint">${esc(r.stock)} · ${esc(basisText(r))}</p>
        ${b.shortages.length ? '<p class="estimated">Stock shortage · ' + esc(b.shortages.join(" / ")) + "</p>" : ""}
        <h3>Batch settings</h3><div class="route-fields">
          <label>Batch size override<input type="number" data-field="batch" min="1" max="10000" placeholder="${saved.batchSize}" value="${validBatch(override) ? override : ""}"></label>
          ${toggle("mail", "Mail to alt")}${
            c.mail
              ? field("stack", "Default stack", 100000) +
                field("post", "Postage (copper)", 100000) +
                (r.kind !== "vendor"
                  ? toggle("back", "Include return mail")
                  : "") +
                (c.back && destroys(r)
                  ? field("returns", "Return stacks", 10000)
                  : "")
              : ""
          }
        </div><p>Postage · ${money(b.postage)}</p>
        ${r.timing ? "<p>" + esc(batchTiming(r, b)) + '</p><p class="hint">' + esc(timingBasis(r)) + "</p>" : ""}
      </section>
    </div>
    ${r.shopping ? '<section class="route-panel">' + shoppingPanel(r, c, field) + "</section>" : ""}
    <h2>Crafting and selling hours</h2>${timingPanel(item, r, c, history)}
    <div class="material-heading"><h2>Materials and outputs</h2><div role="group" aria-label="Material chart period">
      <button data-period="hourly" aria-pressed="${!daily}">Hour of day</button>
      <button data-period="daily" aria-pressed="${daily}">Daily trend</button></div></div>
    <div class="material-grid">${materials.map((m) => materialCard(m, r, history, daily)).join("")}</div>
  </div>`,
  };
}

function renderRoutePage(preserveDraft) {
  const page = $("routePage");
  const item = listingBook.get(routePage.item);
  const base = item?.routes.find(
    (r) =>
      r.kind === routePage.kind &&
      String(r.recipe_id ?? "") === routePage.recipe &&
      (r.stages?.length ? "chain" : "direct") === routePage.path,
  );
  if (!base) {
    document.querySelector("h1").textContent = report
      ? "Route unavailable"
      : "Route details";
    document.title = "Route details · WoW Auction Monitor";
    page.innerHTML =
      '<p role="status">' +
      (report
        ? "This route is absent from the latest market report."
        : offline
          ? "The server report could not be loaded. Use Refresh to retry."
          : "Loading market report…") +
      "</p>";
    return;
  }
  const r = pricedRoute(item, base);
  rows = [{ i: item, r }];
  document.querySelector("h1").textContent = item.name;
  document.title = item.name + " · " + routeLabel(r) + " · WoW Auction Monitor";
  const active = document.activeElement;
  const chart = active.closest(".hourly-chart")?.dataset.chartKey;
  const field = page.contains(active) && active.dataset.field;
  const draft = preserveDraft && field && active.value;
  const openTables = [...page.querySelectorAll("details")].map((d) => d.open);
  const result = fullRoute(item, r);
  page.innerHTML = result.html;
  page
    .querySelectorAll("details")
    .forEach((d, i) => (d.open = !!openTables[i]));
  if (chart) {
    [...page.querySelectorAll(".hourly-chart")]
      .find((el) => el.dataset.chartKey === chart)
      ?.querySelector(".hour-slider")
      .focus({ preventScroll: true });
  } else if (field && active.type === "number") {
    const input = page.querySelector('[data-field="' + field + '"]');
    if (input) {
      if (preserveDraft) input.value = draft;
      input.focus({ preventScroll: true });
    }
  }
  const entry = timingCache.get(result.history);
  if (!entry || (!entry.loading && !entry.error && Date.now() - entry.fetchedAt >= 300_000))
    void loadTiming(result.history, true);
}
