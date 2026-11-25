"use strict";

const inspectedAsks = new WeakMap();
const rateLabel = value => value == null ? "—" : value.toLocaleString(undefined, {maximumSignificantDigits: 3});

function supplyDemandPanel(item) {
  const profile = item.supply_demand;
  const points = profile?.points ?? [];
  const book = item.listing_snapshot;
  const supplyNote = book
    ? book.source + " · " + timestamp(book.observed_at) + (book.stale ? " · Stale" : "")
    : "No listing snapshot recorded.";
  const coverage = profile?.pairs
    ? profile.pairs.toLocaleString() + (profile.pairs === 1 ? " scan pair" : " scan pairs") +
      " · " + rateLabel(profile.seconds / 3600) + " observed hours in the last 28 days."
    : "Demand needs two same-source scans in consecutive hours, starting with priced stock and taken 30–90 minutes apart.";
  const demandNote = "Estimated demand counts units that disappeared at or above the selected ask per observed hour. Cancellations and repricing can raise this estimate. New listings can mask sales.";
  let graph = "";
  if (points.length) {
    graph = '<figure class="sd-chart"><figcaption><span class="sd-supply">Listed supply · units</span>' +
      '<span class="sd-demand">Estimated demand · units/hour</span></figcaption>' +
      '<div class="sd-grid"><div class="sd-y" aria-hidden="true"><span></span><span></span><span>0</span></div>' +
      '<div class="sd-plot"><svg viewBox="0 0 1000 200" preserveAspectRatio="none" role="img" aria-label="Cumulative listed supply and estimated demand by unit ask">' +
      '<path class="sd-supply"></path><path class="sd-demand"></path></svg><i class="sd-guide"></i>' +
      '<i class="sd-dot sd-supply"></i><i class="sd-dot sd-demand"></i></div>' +
      '<div class="sd-x" aria-hidden="true"></div></div>' +
      '<label class="sd-control">Inspect unit ask <input type="range" min="0" step="1" max="' + (points.length-1) + '"></label>' +
      '<dl class="sd-values"><div><dt>Unit ask</dt><dd></dd></div><div><dt>Listed at or below</dt><dd></dd></div>' +
      '<div><dt>Removed at or above</dt><dd></dd></div></dl></figure>';
  } else {
    const message = book?.available === 0 ? "The latest scan found zero listed units."
      : "No priced listing levels are available yet.";
    graph = '<p class="chart-empty">' + message + '</p>';
  }
  return '<section class="route-panel supply-demand"><h2>Supply and demand</h2>' + graph +
    '<p class="hint">Supply · ' + esc(supplyNote) + '</p><p class="hint">' + esc(coverage) +
    '</p>' + (points.length ? '<p class="hint">' + demandNote + '</p>' : '') + '</section>';
}

function bindSupplyDemand(page, item) {
  const chart = page.querySelector(".sd-chart");
  if (!chart) return;
  const points = item.supply_demand.points;
  const plot = chart.querySelector(".sd-plot");
  const slider = chart.querySelector("input");
  const first = points[0][0], last = points[points.length-1][0];
  const log = last / first >= 100;
  const pos = price => first === last ? .5 : log ? Math.log(price / first) / Math.log(last / first) : (price-first)/(last-first);
  // Both distributions arrive sorted and cumulative. Only drawing coordinates are computed here.
  const xs = points.map(p => pos(p[0]));
  const peak = Math.max(1, points[points.length-1][1] ?? 0, points[0][2] ?? 0);
  const y = value => 200 * (1 - value / peak);
  const xLabels = chart.querySelector(".sd-x");
  const center = log ? Math.sqrt(first * last) : (first + last) / 2;
  for (const price of first === last ? [first] : [first,center,last]) {
    const span = document.createElement("span");
    span.textContent = money(price);
    xLabels.append(span);
  }
  xLabels.classList.toggle("single", first === last);
  chart.querySelector(".sd-control").firstChild.textContent = log ? "Inspect unit ask · log price axis " : "Inspect unit ask ";
  const ticks = chart.querySelectorAll(".sd-y span");
  ticks[0].textContent = rateLabel(peak);
  ticks[1].textContent = rateLabel(peak / 2);
  const paths = plot.querySelectorAll("path");
  for (const [series, path] of Array.from(paths).entries()) {
    const field = series + 1;
    if (points[0][field] == null) continue;
    let d = "M" + xs[0]*1000 + " " + y(points[0][field]);
    for (let i = 1; i < points.length; i++) {
      const horizontal = "H" + (xs[i]*1000).toFixed(2);
      const vertical = "V" + y(points[i][field]).toFixed(2);
      d += field === 1 ? horizontal + vertical : vertical + horizontal;
    }
    path.setAttribute("d",d);
  }
  const dots = plot.querySelectorAll(".sd-dot");
  const guide = plot.querySelector(".sd-guide");
  const values = chart.querySelectorAll("dd");
  function inspect(index) {
    const [price,supply,demand] = points[index];
    const x = (100 * xs[index]) + "%";
    guide.style.left = x;
    for (const [i,amount] of [supply,demand].entries()) {
      dots[i].hidden = amount == null;
      dots[i].style.left = x;
      if (amount != null) dots[i].style.top = (y(amount)/2) + "%";
    }
    values[0].textContent = money(price);
    values[1].textContent = supply == null ? "Unavailable" : observedNumber(supply) + " units";
    values[2].textContent = demand == null ? "Awaiting history" : rateLabel(demand) + " units/hour";
    slider.value = index;
    slider.setAttribute("aria-valuetext", values[0].textContent + ", listed supply " + values[1].textContent + ", estimated demand " + values[2].textContent);
    inspectedAsks.set(item,index);
  }
  function inspectPointer(event) {
    const rect = plot.getBoundingClientRect();
    if (!rect.width) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    let lo = 0, hi = xs.length-1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (fraction > (xs[mid] + xs[mid+1]) / 2) lo = mid+1;
      else hi = mid;
    }
    inspect(lo);
  }
  plot.onpointermove = plot.onpointerdown = inspectPointer;
  slider.oninput = () => inspect(slider.valueAsNumber);
  const lowest = points.findIndex(p => p[1] > 0);
  inspect(inspectedAsks.get(item) ?? Math.max(0,lowest));
}
