const fs = require("fs"),
  assert = require("assert/strict"),
  { JSDOM } = require("jsdom");
const dom = new JSDOM(fs.readFileSync("web/index.html", "utf8"), {
  url: "http://localhost/",
  runScripts: "outside-only",
});
const w = dom.window,
  d = w.document,
  at = Math.floor(Date.now() / 1000);
const route = {
  kind: "craft",
  name: "Buckle",
  ready: true,
  quantity: 1,
  quantity_min: 1,
  quantity_max: 1,
  profit: 83,
  timing: {
    active_seconds: 5,
    elapsed_seconds: 5,
    repeat_seconds: 60,
    gold_per_hour: 0.498,
  },
  cost: 17,
  proceeds: 100,
  stock: "verified",
  recipe_id: "b",
  profession: "Blacksmithing",
  requirements: { profession: "Blacksmithing", character_level: 20 },
  required_character_level: 20,
  characters: ["Ada"],
  inputs: [
    {
      id: 1001,
      name: "Ore",
      quantity: 3,
      cost: 17,
      unit_cost: 5.5,
      listed_units: 4,
      max_stack: 20,
      source: "checked",
    },
  ],
};
const items = Array.from({ length: 43 }, (_, n) => ({
  id: 2000 + n,
  name: n ? "Ore " + n : "Buckle",
  estimate: 7,
  checked_price: n ? null : 5.5,
  checked_at: n ? null : at,
  listed_units: n ? null : 4,
  routes: n ? [] : [route],
}));
Object.assign(items[0], {
  estimate_source: "Booty Bay Broker",
  estimate_at: at + 1,
  broker_price: { price: 7, observed_at: at + 1 },
});
items[5].routes = [
  {
    ...route,
    name: "Green Lens",
    kind: "craft_disenchant",
    profession: "Engineering",
    required_character_level: null,
    ready: false,
    advice: "Level an alt with Engineering.",
    profit: 500,
    timing: {
      active_seconds: 8,
      elapsed_seconds: 8,
      repeat_seconds: 1000,
      gold_per_hour: 0.18,
    },
    characters: [],
  },
];
items[6].routes = [
  {
    ...route,
    name: "Charm",
    required_character_level: 35,
    timing: {
      active_seconds: 24,
      elapsed_seconds: 24,
      repeat_seconds: 24,
      gold_per_hour: 1.245,
    },
    stages: [
      {
        action: "craft",
        name: "Ring",
        item: 9001,
        quantity: 2,
        runs: 2,
        inputs: [{ id:1001, name: "Ore", quantity: 6 }],
        requirements: {
          pattern: "Plans: Ring",
          pattern_character_level: 30,
          pattern_quest_level: 35,
        },
        advice: "Ada is ready.",
      },
      {
        action: "disenchant",
        name: "Ring",
        item: 9001,
        quantity: 2,
        outputs: [{ id:9002, name: "Dust", quantity: 1 }],
      },
    ],
    final_inputs: [{ id:9002, name: "Dust", quantity: 1 }],
    expected_inputs: true,
  },
];
items[40].id = 1001;
items[41].id = 9001;
items[42].id = 9002;
let fail = false,
  copied;
const historicDay = (Math.floor(at / 86400) - 4) * 86400;
let historyHits = 0, reportHits = 0;
let orderBook = {1001: {source: "Blizzard Auction House", observed_at: at, available: 7, lots: [[1, 2, 4], [3, 15, 1]]}};
w.TextEncoder = TextEncoder;
w.TextDecoder = TextDecoder;
w.WebAssembly = WebAssembly;
w.fetch = async (url) => {
  if (url === "/auction.wasm") return new Response(require("./wasm.cjs").bytes, {headers:{"Content-Type":"application/wasm"}});
  if (url !== "/api/dashboard") { historyHits++; throw Error("Unexpected page request " + url); }
  // The native endpoint supplies all item books and hourly observations together.
  for (const item of items) {
    item.hours = [];
    item.listing_snapshot = orderBook[item.id];
    for (let day=0;day<3;day++) for (const [h,unit] of [[8,3],[18,8]]) {
      const price = item.id===1001 ? unit : 10*unit;
      item.hours.push([historicDay+day*86400+h*3600, price, 100, 50, [[100,price,1]]]);
    }
  }
  reportHits++;
  if (fail) throw Error("Offline");
  return {
    ok: true,
    headers: { get: () => null },
    json: async () => ({
      generated_at: at,
      uploaded_at: at,
      desktop_port: 5800,
      catalog: { recipes: 2051, characters: 1, build: "fixture" },
      region: "Forever-US",
      market: "Normal-Alliance",
      tsm: { count: 43, source: "Desktop AppHelper", observed_at: at },
      blizzard: {enabled: true, total: 19, latest_at: at - 60, last_pull_at: at},
      booty_bay_broker: {total: 2, fresh: 1, latest_at: at - 60},
      items,
    }),
  };
};
w.navigator.clipboard = {
  writeText: async (s) => {
    copied = s;
  },
};
// Supply the dialog and worker APIs missing in jsdom, running the real worker code.
const dialog = d.querySelector("#simulation");
dialog.showModal = () => dialog.setAttribute("open", "");
dialog.close = () => {
  dialog.removeAttribute("open");
  dialog.dispatchEvent(new w.Event("close"));
};
let preparedUnitPrice = false;
w.Worker = class {
  constructor(url) {
    const { Worker } = require("node:worker_threads");
    assert.equal(url, "/price-simulation.js");
    this.thread = new Worker(
      'const {parentPort} = require("node:worker_threads");' +
        "const self = {postMessage: value => parentPort.postMessage(value)};\n" +
        "const importScripts = path => require('node:vm').runInThisContext(require('node:fs').readFileSync('web' + path, 'utf8'));\n" +
        fs.readFileSync("web" + url, "utf8") +
        '\nparentPort.on("message", data => self.onmessage({data}));',
      { eval: true },
    );
    this.thread.on("message", (data) => {
      this.onmessage({ data });
      if (!data.error && this.job?.unitOnly && this.job.itemId === 2000) preparedUnitPrice = true;
    });
    this.thread.on("error", (error) => this.onerror(error));
    this.thread.unref();
  }
  postMessage(data) {
    this.job = data.model;
    this.thread.postMessage(data);
  }
  terminate() {
    this.thread.terminate();
  }
};
w.eval(
  ["web/calculations.js", "web/shopping.js", "web/history.js", "web/supply-demand.js", "web/item.js", "web/route.js", "web/craft-order.js", "web/warm.js", "web/app.js"]
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n"),
);
// jsdom does not load a second document when following a link.
function visit(href) {
  w.history.pushState(null,"",new URL(href,w.location.href).href);
  d.querySelector("#body").replaceChildren();
  d.querySelector("#routePage").replaceChildren();
  w.onhashchange();
}
function visitRoute() {
  const a = d.querySelector("a.rowname");
  assert.equal(new URL(a.href).pathname, "/route");
  visit(a.href);
}
const wait = () => new Promise((r) => setTimeout(r, 5));
async function runSimulation() {
  d.querySelector("#sim-form button").click();
  for (let n = 0; n < 300 && !d.querySelector("#sim-result dl"); n++)
    await wait();
  assert.match(
    d.querySelector("#sim-status").textContent,
    /5,000 trials completed/,
  );
  return d.querySelector("#sim-result").textContent;
}
(async () => {
  for(let i=0;i<200 && !d.querySelector("#body>tr");i++) await wait();
  assert.equal(d.querySelector("#batchSizeLabel").hidden, true);
  assert.equal(d.querySelector("#profitabilityLabel").hidden, true);
  assert.equal(d.querySelectorAll("#body>tr").length, 40);
  assert.equal(d.querySelector("#blizzard-stats").hidden, false);
  assert.equal(d.querySelector("#blizzard-count").textContent, "19 items");
  assert.match(d.querySelector("#blizzard-observed").textContent, /Latest snapshot.*Last check/);
  assert.equal(d.querySelector("#broker-stats").hidden, false);
  assert.equal(d.querySelector("#broker-count").textContent, "1 of 2 fresh");
  d.querySelector(".rowname").click();
  assert.match(d.querySelector("#body").textContent, /Booty Bay Broker lowest buyout 7c/);
  for (let i = 0; i < 400 && !preparedUnitPrice; i++) await wait();
  assert.ok(preparedUnitPrice, "the snapshot starts unit-price trials in the background");
  d.querySelector("[data-sim-item]").click();
  assert.match(d.querySelector("#sim-result").textContent, /Mean unit price/);
  assert.equal(d.querySelector("#sim-gold").disabled, true);
  assert.equal(d.querySelector("#sim-yield-min").disabled, true);
  assert.match(d.querySelector("#sim-inputs").textContent, /7cBooty Bay Broker/);
  d.querySelector("#sim-volatility").value = 0;
  assert.match(await runSimulation(), /Median unit price7c/);
  d.querySelector("#sim-close").click();
  // A checked-empty reagent keeps its older price for planning and simulation.
  const reagent = items[1];
  reagent.listed_units = 0;
  reagent.checked_at = at;
  reagent.estimate_at = at - 86400;
  reagent.estimate_source = "Desktop AppHelper";
  reagent.estimate_stale = true;
  d.querySelector('[data-row="1"]').click();
  assert.match(d.querySelector("#body").textContent, /Desktop AppHelper · 1d · Stale/);
  d.querySelector("#refresh").click();
  await wait();
  d.querySelector('[data-sim-item="1"]').click();
  assert.match(
    d.querySelector("#sim-inputs").textContent,
    /7cDesktop AppHelper/,
  );
  d.querySelector("#sim-close").click();
  d.querySelector("#next").click();
  assert.equal(d.querySelectorAll("#body>tr").length, 3);
  w.location.hash = "#professions";
  await wait();
  assert.equal(d.querySelector("#pricing").value, "forecast");
  assert.match(d.querySelector("#body").textContent, /profitable trials/);
  const planning = d.querySelector("#pricing");
  planning.value = "estimates";
  planning.dispatchEvent(new w.Event("input"));
  const panel = d.querySelector("#training");
  assert.match(panel.textContent, /2,051 recipes checked/);
  assert.match(panel.textContent, /Level an alt with Engineering/);
  const filter = (id, value) => {
    const el = d.querySelector("#" + id);
    el.value = value;
    el.oninput({ target: el });
  };
  assert.equal(new URL(d.querySelector("#tsm-desktop").href).port, "5800");
  assert.match(d.querySelector("#client-upload").textContent, /Last upload/);
  filter("level", "19");
  assert.equal(d.querySelectorAll(".rowname").length, 0);
  filter("level", "20");
  assert.equal(d.querySelectorAll(".rowname").length, 1);
  assert.match(
    d.querySelector("#body").textContent,
    /Buckle.*Character level 20/,
  );
  assert.doesNotMatch(panel.textContent, /Level an alt with Engineering/);
  filter("level", "35");
  assert.equal(d.querySelectorAll(".rowname").length, 2);
  assert.match(
    d.querySelector("#body").textContent,
    /Chained.*Character level 35/,
  );
  filter("level", "");
  filter("sort", "level");
  const sorted = [...d.querySelectorAll("#body tr")];
  assert.equal(sorted.length, 3);
  assert.match(sorted[0].textContent, /Character level 20/);
  assert.match(sorted[1].textContent, /Character level 35/);
  assert.match(sorted[2].textContent, /Character level unknown/);
  filter("sort", "gold_per_hour");
  assert.match(d.querySelector("#body tr").textContent, /Chained/);
  assert.match(panel.textContent, /Highest projected repeat gold per hour/);
  filter("route", "chain");
  assert.equal(d.querySelectorAll("#body>tr").length, 1);
  visitRoute();
  assert.match(d.querySelector(".route").textContent, /Disenchant 2 × Ring/);
  assert.match(
    d.querySelector(".route").textContent,
    /Plans: Ring · Level 30 to learn · Level 35 to accept the pattern quest/,
  );
  assert.match(
    d.querySelector(".route").textContent,
    /Craft 1 × Charm from 1 × Dust/,
  );
  await wait();
  assert.equal(d.querySelectorAll(".material-card .hourly-chart").length, 4);
  assert.match(d.querySelector(".material-grid").textContent, /Intermediate craft · Disenchanted/);
  const historyBeforeMode = historyHits;
  d.querySelector('[data-period="daily"]').click();
  assert.equal(d.querySelectorAll(".material-card .hour-slider[max='27']").length, 4);
  assert.match(d.querySelector(".material-card").textContent, /2 sampled hours/);
  assert.equal(historyHits, historyBeforeMode);
  d.querySelector('[data-period="hourly"]').click();
  d.querySelector("[data-copy]").click();
  await wait();
  assert.match(copied, /Sell the finished items to a vendor/);
  assert.equal(d.querySelector("#batchSizeLabel").hidden, false);
  assert.equal(d.querySelector("#batchSize").value, "1");
  filter("batchSize", "3");
  const estimate = () => d.querySelector(".route").textContent;
  assert.match(estimate(), /Batch profit2s 49c/);
  assert.match(estimate(), /Batch time1m 12s/);
  assert.match(estimate(), /Stock shortage/);
  assert.match(d.querySelector(".route").textContent, /Disenchant 6 × Ring/);
  d.querySelector("[data-copy]").click();
  await wait();
  assert.match(copied, /Runs: 3/);
  assert.match(copied, /Craft 3 × Charm/);
  for (const invalid of ["0", "10001", "2.5", ""]) {
    filter("batchSize", invalid);
    d.querySelector("#batchSize").dispatchEvent(new w.Event("blur"));
    assert.equal(d.querySelector("#batchSize").value, "3");
  }
  visit(d.querySelector("#routeBack").href);
  assert.equal(d.querySelector("#route").value, "chain");
  filter("route", "");
  filter("trainingCost", "1");
  assert.match(panel.textContent, /20 profitable crafts/);
  filter("route", "craft_disenchant");
  filter("access", "training");
  assert.equal(d.querySelectorAll("#body>tr").length, 1);
  assert.match(d.querySelector("#body").textContent, /Craft → disenchant/);
  filter("access", "ready");
  assert.equal(d.querySelectorAll("#body>tr").length, 0);
  filter("route", "");
  filter("access", "");
  const search = d.querySelector("#search");
  search.value = "BUCK";
  search.oninput({ target: search });
  assert.equal(d.querySelectorAll("#body>tr").length, 1);
  visitRoute();
  const batch = d.querySelector('[data-field="batch"]');
  assert.equal(batch.placeholder, "3");
  assert.match(estimate(), /Batch time2m 5s/);
  batch.value = "2";
  batch.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.match(estimate(), /Batch time1m 5s/);
  filter("batchSize", "5");
  assert.match(estimate(), /Batch time1m 5s/);
  assert.match(d.body.textContent, /Stock shortage · Ore needs 6, checked 4/);
  d.querySelector('[data-field="mail"]').click();
  d.querySelector("[data-copy]").click();
  await wait();
  assert.match(copied, /Postage: 30c/);
  assert.match(copied, /Profit: 1s 36c/);
  assert.match(
    copied,
    /Estimated batch time 1m 5s \(10s casting, 55s cooldown wait\)/,
  );
  assert.match(copied, /Batch profit per hour 0.75 g\/h/);
  assert.match(copied, /Ada/);
  d.querySelector("[data-sim-order]").click();
  assert.equal(d.querySelector("#sim-target").value, "2");
  assert.equal(d.querySelector("#sim-gold").disabled, true);
  d.querySelector("#sim-stock-spread").value = 0;
  d.querySelector("#sim-volatility").value = 0;
  const filledOrder = await runSimulation();
  assert.match(filledOrder, /Median cost21c/);
  assert.match(filledOrder, /5,000 \/ 5,000 \(100.0%\)/);
  assert.match(d.querySelector("#sim-inputs").textContent, /7 units · Blizzard Auction House/);
  d.querySelector("#sim-target").value = "3";
  assert.match(await runSimulation(), /No trial could fill this order/);
  dialog.close();
  d.querySelector("[data-optimize]").click();
  assert.equal(d.querySelector("#sim-trials").disabled, false);
  assert.equal(d.querySelector("#sim-stock-spread").disabled, false);
  d.querySelector("#sim-budget").value = "0.0040"; // Ore and postage fit one cast.
  d.querySelector("#sim-form button").click();
  for (let n=0;n<300 && !d.querySelector("#sim-result dl");n++) await wait();
  assert.match(d.querySelector("#sim-result").textContent, /Crafts1Finished pieces per filled order1/);
  assert.match(d.querySelector("#sim-result").textContent, /Chance of filling within budget100.0%/);
  assert.match(d.querySelector("#sim-status").textContent, /5,000 trials completed/);
  dialog.close();
  d.querySelector("[data-sim-order]").click();
  dialog.close();
  orderBook = {1001: null};
  d.querySelector("#refresh").click();
  await wait();
  d.querySelector("[data-sim-order]").click();
  d.querySelector("#sim-form button").click();
  await wait();
  assert.match(d.querySelector("#sim-status").textContent, /Recorded stack prices needed for Ore/);
  assert.equal(d.querySelector("#sim-result").textContent, "");
  dialog.close();
  d.querySelector("[data-sim-craft]").click();
  assert.match(d.querySelector("#sim-stock").textContent, /Ore needs 6/);
  const bankroll = d.querySelector("#sim-gold");
  assert.equal(bankroll.disabled, false);
  bankroll.value = "1.0001";
  const projected = await runSimulation();
  assert.match(projected, /Mean batch cost64c/);
  assert.match(projected, /Mean batch profit1s 36c/);
  assert.match(
    projected,
    /Full Kelly target before rounding or stock limits1g 1c \(100%/,
  );
  assert.match(projected, /Suggested spend at current quotes0c/);
  assert.match(projected, /Checked reagent stock limits this order/);
  d.querySelector("#sim-volatility").value = 25;
  d.querySelector("#sim-volatility").dispatchEvent(
    new w.Event("input", { bubbles: true }),
  );
  assert.equal(d.querySelector("#sim-result").textContent, "");
  await runSimulation();
  assert.equal(d.querySelectorAll(".sim-bars span").length, 20);
  d.querySelector("#sim-close").click();
  const override = d.querySelector('[data-field="batch"]');
  override.value = "";
  override.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.match(estimate(), /Batch time4m 5s/);
  assert.match(d.querySelector(".cost-list li").textContent, /Ore × 15/);
  d.querySelector("[data-sim-craft]").click();
  d.querySelector("#sim-volatility").value = 0;
  assert.match(await runSimulation(), /Mean batch cost1s 15c/);
  const minYield = d.querySelector("#sim-yield-min"),
    maxYield = d.querySelector("#sim-yield-max");
  assert.equal(minYield.value, "1");
  assert.equal(bankroll.value, "1.0001");
  assert.equal(maxYield.value, "1");
  minYield.value = "6";
  maxYield.value = "5";
  d.querySelector("#sim-form button").click();
  assert.match(d.querySelector("#sim-status").textContent, /Minimum pieces/);
  minYield.value = "1";
  minYield.dispatchEvent(new w.Event("input", { bubbles: true }));
  const variableProfit = await runSimulation();
  assert.match(variableProfit, /Mean batch output/);
  assert.match(variableProfit, /Middle 90% of batch profit/);
  assert.match(variableProfit, /Batch profit distribution/);
  d.querySelector("#sim-close").click();
  d.querySelector("[data-sim-craft]").click();
  assert.equal(maxYield.value, "5");
  d.querySelector("#sim-close").click();
  visit("/#opportunities");
  await wait();
  filter("pricing", "estimates");
  filter("level", "20");
  assert.equal(d.querySelectorAll(".rowname").length, 1);
  d.querySelector("#refresh").click();
  await wait();
  assert.equal(d.querySelectorAll(".rowname").length, 1);
  assert.match(d.querySelector("#body").textContent, /Buckle/);
  assert.equal(d.querySelector("#batchSize").value, "5");
  assert.equal(JSON.parse(w.sessionStorage.wam).batchSize, 5);
  w.location.hash = "#professions";
  await wait();
  fail = true;
  d.querySelector("#refresh").click();
  await wait();
  assert.match(d.querySelector("#notice").textContent, /Connection lost/);
  assert.equal(d.querySelectorAll("a.rowname").length, 1);

  const marginCases = [
    ["Margin gain", "craft", 12, "insufficient"],
    ["Margin even", "craft_disenchant", 0, "verified"],
    ["Margin loss", "craft_auction", -9, "estimated"],
    ["Margin unknown", "craft", null, "insufficient"],
    ["Margin buy", "vendor", -3, "verified"],
  ];
  for (const [index, [name, kind, profit, stock]] of marginCases.entries()) {
    items.push({
      id: 3000 + index,
      name,
      routes: [
        {
          ...route,
          name,
          kind,
          profit,
          stock,
          proceeds: profit == null ? null : route.cost + profit,
        },
      ],
    });
  }
  fail = false;
  d.querySelector("#refresh").click();
  await wait();
  for (const view of ["professions", "opportunities"]) {
    w.location.hash = "#" + view;
    await wait();
    filter("search", "Margin");
    filter("level", "");
    filter("sort", "profit");
    assert.equal(d.querySelector("#profitabilityLabel").hidden, false);
    assert.equal(d.querySelector("#profitability").value, "");
    const visibleMargins = () =>
      [...d.querySelectorAll("#body tr td:nth-child(4)")].map(
        (td) => td.textContent,
      );
    assert.deepEqual(visibleMargins(), ["12c", "0c", "−9c", "Unknown"]);
    for (const [value, expected] of [
      ["profit", "12c"],
      ["even", "0c"],
      ["unknown", "Unknown"],
      ["loss", "−9c"],
    ]) {
      filter("profitability", value);
      assert.deepEqual(visibleMargins(), [expected]);
    }
    filter("route", "craft");
    assert.deepEqual(visibleMargins(), []);
    filter("route", "");
  }
  filter("profitability", "");
  w.location.hash = "#professions";
  await wait();
  assert.equal(d.querySelector("#profitability").value, "loss");
  assert.match(d.querySelector("#body").textContent, /Margin loss/);
  // Current prices come from whole scanned stacks and the capped TSM search
  // must be derived from the same batch and postage used by the profit filter.
  visit("/#opportunities");
  await wait();
  filter("pricing", "listings");
  filter("search", "Buckle");
  filter("batchSize", "1");
  const buckle = items[0];
  buckle.vendor_sell = 100;
  const ore = {
    id: 1001,
    name: "Ore",
    lots: [[2, 11, 2]],
    listed_units: 4,
    checked_at: at,
    routes: [],
  };
  items[items.findIndex(i => i.id === 1001)] = ore;
  d.querySelector("#refresh").click();
  await wait();
  filter("profitability", "profit");
  assert.equal(d.querySelector("#body tr td:nth-child(4)").textContent, "78c");
  visitRoute();
  assert.match(d.querySelector(".route").textContent, /Ore × 4 · max 24c each/);
  d.querySelector("[data-tsm]").click();
  await wait();
  assert.equal(copied, "Ore/exact/24c/x4");
  const target = d.querySelector('[data-field="minProfit"]');
  target.value = 80;
  target.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.match(d.querySelector(".route").textContent, /Wait for lower/);
  assert.match(d.querySelector(".route").textContent, /max 5c each/);
  filter("batchSize", "2");
  const shoppingRoute = w.location.href;
  visit(d.querySelector("#routeBack").href);
  assert.equal(d.querySelectorAll(".rowname").length, 0);
  filter("profitability", "unknown");
  visit(shoppingRoute);
  assert.match(
    d.querySelector(".route").textContent,
    /Insufficient listed quantity/,
  );
  assert.equal(d.querySelector("[data-tsm]"), null);
  filter("batchSize", "1");
  ore.checked_at = at - 901;
  d.querySelector("#refresh").click();
  await wait();
  assert.match(d.querySelector(".route").textContent, /fresh listing scan/);
  assert.equal(d.querySelector("[data-tsm]"), null);
  ore.purchase_depth = {source: "Blizzard Auction House", observed_at: at,
    available: 10, levels: [[5,3,1], [10,8,1]]};
  d.querySelector("#refresh").click();
  await wait();
  filter("profitability", "");
  filter("pricing", "percentile");
  assert.equal(d.querySelector("#floorLabel").hidden, false);
  assert.match(estimate(), /Batch profit91c/);
  assert.match(d.querySelector(".route").textContent, /P30 · 10 units listed · Blizzard/);
  await wait();
  const firstHits = historyHits;
  assert.equal(firstHits,0);
  assert.match(d.querySelector(".route").textContent, /08:00 UTC · 9c median per batch/);
  assert.match(d.querySelector(".route").textContent, /Sell · Any hour · 1s 0c at vendor prices/);
  assert.match(d.querySelector(".route").textContent, /Hourly medians and sampled days/);
  const chart = () => d.querySelector(".hourly-chart");
  const slider = () => chart().querySelector(".hour-slider");
  const bar = hour => chart().querySelector('[data-hour="' + hour + '"]');
  const readout = () => chart().querySelector(".hour-readout").textContent;
  assert.equal(chart().querySelectorAll("[data-hour]").length, 24);
  assert.equal(slider().value, "8");
  assert.equal(chart().querySelectorAll(".vendor-rule").length, 1);
  assert.ok(bar(8).querySelector("[data-best]"));
  bar(18).firstElementChild.dispatchEvent(new w.MouseEvent("pointerover", {bubbles:true}));
  assert.equal(slider().value, "18");
  assert.match(readout(), /18:00 UTC.*Batch cost 24c · 3 sampled days.*Sale proceeds 1s 0c · fixed vendor price/);
  bar(13).click();
  assert.equal(slider().value, "13");
  assert.match(readout(), /13:00 UTC.*No sample/);
  assert.equal(bar(13).firstElementChild.style.visibility, "hidden");
  slider().focus();
  slider().value = "8";
  slider().dispatchEvent(new w.Event("input", {bubbles: true}));
  assert.match(slider().getAttribute("aria-valuetext"), /08:00 UTC.*9c.*lowest batch cost/);
  d.querySelector("#refresh").click();
  await wait();
  assert.equal(slider(), d.activeElement);
  assert.equal(historyHits, firstHits);
  bar(18).click();
  await wait();
  assert.equal(slider().value, "18");
  assert.equal(historyHits, firstHits);
  d.querySelector("[data-sim-craft]").click();
  assert.match(d.querySelector("#sim-inputs").textContent, /P30 · Blizzard/);
  dialog.close();
  filter("batchSize", "2");
  assert.match(estimate(), /Batch profit1s 52c/);
  assert.match(d.querySelector(".route").textContent, /P60 · 10 units/);
  filter("batchSize", "1");
  filter("floor", "90");
  assert.match(d.querySelector(".route").textContent, /P90 · 10 units/);
  filter("batchSize", "4");
  assert.match(estimate(), /Batch profit—/);
  assert.match(d.querySelector(".route").textContent, /Insufficient supply/);
  assert.equal(d.querySelector("[data-tsm]"), null);
  visit("/#market");
  await wait();
  filter("search", "1001");
  d.querySelector(".rowname").click();
  await wait();
  assert.match(d.querySelector(".detail").textContent, /Lowest unit price · 08:00 UTC · 3c median per unit/);
  assert.match(d.querySelector(".detail").textContent, /Highest unit price · 18:00 UTC · 8c median per unit/);
  assert.equal(chart().querySelectorAll("[data-metric]").length, 1);
  assert.equal(chart().querySelectorAll("[data-best]").length, 2);
  bar(18).click();
  assert.match(readout(), /18:00 UTC.*Unit price 8c · 3 sampled days · highest unit price/);
  assert.equal(chart().querySelector(".vendor-rule"), null);
  for (const query of [
    "exit=craft_auction&path=direct&recipe=b",
    "exit=craft&path=chain&recipe=b",
    "exit=craft&path=direct&recipe=other",
  ]) {
    visit("/route?item=2000&" + query);
    assert.equal(d.querySelector("h1").textContent, "Route unavailable");
    assert.equal(d.querySelector(".route-metrics"), null);
  }
  // The optimizer uses last-known stack depth even when the live shopping view has expired.
  buckle.routes.push({...route, kind:"craft_auction", recipe_id:"sale-test", net_unit_value:1});
  orderBook = {
    1001:{source:"In-game full scan", observed_at:at-86400, stale:true, available:6, lots:[[1,10,6]]},
    2000:{source:"Blizzard Auction House", observed_at:at+2, stale:false, available:1, lots:[[1,100,1]]},
  };
  d.querySelector("#refresh").click();
  await wait();
  visit("/route?item=2000&exit=craft_auction&path=direct&recipe=sale-test");
  d.querySelector("[data-optimize]").click();
  for (const [id,value] of Object.entries({"sim-limit":2, "sim-volatility":0, "sim-stock-spread":0,
    "sim-yield-min":1, "sim-yield-max":1, "sim-budget":""})) d.getElementById(id).value = value;
  assert.match(await runSimulation(), /Expected net profit across all trials1s 1c/);
  assert.match(d.querySelector("#sim-inputs").textContent,/In-game full scan · Stale/);
  assert.match(d.querySelector("#sim-sales").textContent,/Blizzard Auction House/);
  dialog.close();
  // Internal item links and Back use the same published version without network reads.
  const beforeItem = reportHits;
  const oldPath = w.location.href;
  const link = d.querySelector('.material-card a[href^="/item?"]');
  const linkedItem = items.find(item => item.id === Number(new URL(link.href).searchParams.get("item")));
  linkedItem.supply_demand = {points:[[2,5,8],[5,20,3]],pairs:2,seconds:7200};
  link.click();
  assert.equal(w.location.pathname,"/item");
  assert.match(d.querySelector(".item-report").textContent,/Auction listings/);
  assert.equal(d.querySelectorAll(".sd-plot path[d]").length,2);
  const priceControl = d.querySelector(".sd-control input");
  assert.match(priceControl.getAttribute("aria-valuetext"), /2c.*5 units.*8 units\/hour/);
  priceControl.value = 1;
  priceControl.dispatchEvent(new w.Event("input", {bubbles:true}));
  assert.match(priceControl.getAttribute("aria-valuetext"), /5c.*20 units.*3 units\/hour/);
  assert.equal(d.querySelectorAll(".week-calendar tbody tr").length,24);
  assert.equal(d.querySelectorAll(".week-calendar tbody td").length,168);
  assert.equal(reportHits,beforeItem);
  assert.equal(historyHits,0);
  w.history.back();
  for (let i=0;i<100 && w.location.href!==oldPath;i++) await wait();
  assert.equal(w.location.href,oldPath);
  assert.ok(d.querySelector(".route-report"));
  assert.equal(reportHits,beforeItem);
  console.log(
    "Dashboard search, pagination, profit filters, routes, batch shortage, postage, clipboard and offline retention passed",
  );
  dom.window.close();
})().catch((e) => {
  console.error(e);
  dom.window.close();
  process.exitCode = 1;
});
