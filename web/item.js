"use strict";

const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const observedNumber = n => n == null ? "—" : n.toLocaleString(undefined, {maximumFractionDigits: 1});
function itemHref(id) {
  return "/item?" + new URLSearchParams({item: id, from: routePage?.from || view()});
}
function itemLink(id, name) {
  return '<a class="item-link" href="' + esc(itemHref(id)) + '">' + esc(name) + '</a>';
}

function weekCalendar(item) {
  const cells = {...report.empty_calendar, ...item.calendar};
  const head = weekdays.map(day => '<th scope="col">' + day.slice(0,3) + '</th>').join("");
  const body = Array.from({length:24}, (_,hour) => {
    const columns = weekdays.map((day, index) => {
      const cell = cells[index*24 + hour];
      if (!cell) return '<td class="unobserved" aria-label="No observation">—</td>';
      const [price,units,listings,prices,stocks,counts] = cell;
      const coverage = day + " " + utcHour(hour) + " UTC · " + prices + " price, " + counts + " listing-count and " + stocks + " unit observations";
      return '<td title="' + esc(coverage) + '"><span>' + money(price) + '</span><small>' +
        observedNumber(listings) + ' listings · ' + observedNumber(units) + ' units</small></td>';
    }).join("");
    return '<tr><th scope="row">' + utcHour(hour) + '</th>' + columns + '</tr>';
  }).join("");
  return '<section class="route-panel week-calendar"><h2>Weekday and hour</h2>' +
    '<p>Median unit price, auction listings and listed units over the last 28 days, in UTC. A dash means no observation for that measure. Zero means a scan found no stock.</p>' +
    (Object.keys(cells).length ? "" : "<p>No price or listing observations in the last 28 days.</p>") +
    '<div class="item-table-scroll" tabindex="0" aria-label="Weekday and hour table"><table><thead><tr><th scope="col">UTC</th>' +
    head + '</tr></thead><tbody>' + body + '</tbody></table></div></section>';
}

let listingPage = 0;
function listingPanel(item) {
  const book = item.listing_snapshot;
  if (!book) return '<section class="route-panel"><h2>Auction listings</h2><p>No listing snapshot has been recorded.</p></section>';
  const tiers = item.listing_detail?.tiers ?? [];
  const size = 40;
  listingPage = Math.min(listingPage, Math.max(0, Math.ceil(tiers.length/size)-1));
  const start = listingPage*size;
  const body = tiers.slice(start,start+size).map(([stack,buyout,count,unit,units,total]) =>
    '<tr>' + [money(unit),observedNumber(stack),money(buyout),observedNumber(count),observedNumber(units),observedNumber(total)].map(v=>'<td>'+v+'</td>').join("")+'</tr>'
  ).join("");
  const pages = tiers.length > size ? '<div class="listing-pager"><button data-list-page="prev" ' + (!start ? "disabled" : "") +
    '>Previous</button><span>' + (start+1) + '–' + Math.min(start+size,tiers.length) + ' of ' + tiers.length +
    '</span><button data-list-page="next" ' + (start+size>=tiers.length ? "disabled" : "") + '>Next</button></div>' : '';
  return '<section class="route-panel"><h2>Auction listings</h2><p>' + esc(book.source) + ' · ' + esc(timestamp(book.observed_at)) +
    (book.stale ? ' · Stale' : '') + '</p>' + (body ? '<div class="item-table-scroll"><table><thead><tr>' +
      ["Unit price","Stack size","Stack buyout","Listings","Units","Cumulative units"].map(v=>'<th scope="col">'+v+'</th>').join("") +
      '</tr></thead><tbody>'+body+'</tbody></table></div>'+pages :
      '<p>'+(book.available === 0 ? "This scan found no listings." : "This scan recorded stock without individual stack prices.")+'</p>') + '</section>';
}

function renderItemPage() {
  const item = listingBook.get(routePage.item);
  const page = $("routePage");
  document.querySelector("h1").textContent = item?.name || (report ? "Item unavailable" : "Item details");
  document.title = (item?.name || "Item details") + " · WoW Auction Monitor";
  if (!item) {
    page.innerHTML = '<p role="status">' + (report ? "This item is absent from the latest market report." : offline || "Preparing market data…") + '</p>';
    return;
  }
  rows = [{i:item}];
  const fact = (label,value) => '<div><dt>'+label+'</dt><dd>'+value+'</dd></div>';
  const book = item.listing_snapshot, detail = item.listing_detail;
  const links = item.routes.map(r => '<li><a href="'+esc(routeHref(item,r,"market"))+'">'+esc(routeLabel(r)+" · "+r.name)+'</a></li>').join("");
  let trend = "";
  if (item.charts?.daily) {
    const key = "item-detail/" + item.id;
    prepareTiming(key, [], null, false);
    trend = '<section class="route-panel"><h2>Daily price trend</h2>' +
      dailyPriceChart([], key, key, item.charts.daily) + '</section>';
  }
  page.innerHTML = '<div class="item-report"><p class="route-subtitle">Item #' + item.id + ' · '+esc(report.region)+' / '+esc(report.market)+'</p>' +
    '<dl class="route-metrics">'+fact("Latest unit quote",money(item.estimate))+fact("Lowest listed ask",money(detail?.lowest))+
    fact("Unit-weighted mean ask",money(detail?.mean))+fact("Auction listings",observedNumber(detail?.count))+fact("Listed units",observedNumber(book?.available))+'</dl>'+
    '<p class="hint">'+esc(priceObservation(item))+(item.estimate_at ? ' · '+esc(timestamp(item.estimate_at)) : '')+'</p>'+
    (item.vendor_buy != null || item.vendor_sell != null ? '<p>Vendor purchase · '+money(item.vendor_buy)+' &nbsp; Vendor payout · '+money(item.vendor_sell)+'</p>' : '') +
    marketSimulationButton(item,0)+listingPanel(item)+weekCalendar(item)+trend+(links ? '<section class="route-panel"><h2>Routes</h2><ul>'+links+'</ul></section>' : '')+'</div>';
}
