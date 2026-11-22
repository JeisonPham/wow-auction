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
items[5].routes = [
  {
    ...route,
    name: "Green Lens",
    kind: "craft_disenchant",
    profession: "Engineering",
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
        quantity: 2,
        runs: 2,
        inputs: [{ name: "Ore", quantity: 6 }],
        advice: "Ada is ready.",
      },
      {
        action: "disenchant",
        name: "Ring",
        quantity: 2,
        outputs: [{ name: "Dust", quantity: 1 }],
      },
    ],
    final_inputs: [{ name: "Dust", quantity: 1 }],
    expected_inputs: true,
  },
];
let fail = false,
  copied;
w.fetch = async () => {
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
w.Worker = class {
  constructor(url) {
    const { Worker } = require("node:worker_threads");
    assert.equal(url, "/price-simulation.js");
    this.thread = new Worker(
      'const {parentPort} = require("node:worker_threads");' +
        "const self = {postMessage: value => parentPort.postMessage(value)};\n" +
        fs.readFileSync("web" + url, "utf8") +
        '\nparentPort.on("message", data => self.onmessage({data}));',
      { eval: true },
    );
    this.thread.on("message", (data) => this.onmessage({ data }));
    this.thread.on("error", (error) => this.onerror(error));
  }
  postMessage(data) {
    this.thread.postMessage(data);
  }
  terminate() {
    this.thread.terminate();
  }
};
w.eval(fs.readFileSync("web/app.js", "utf8"));
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
  await wait();
  assert.equal(d.querySelector("#batchSizeLabel").hidden, true);
  assert.equal(d.querySelectorAll("#body>tr").length, 40);
  d.querySelector(".rowname").click();
  d.querySelector("[data-sim-item]").click();
  assert.equal(d.querySelector("#sim-yield-min").disabled, true);
  assert.match(d.querySelector("#sim-inputs").textContent, /5.5cIn-game scan/);
  d.querySelector("#sim-volatility").value = 0;
  assert.match(await runSimulation(), /Median unit price5.5c/);
  d.querySelector("#sim-close").click();
  // A checked-empty reagent can have a TSM estimate but no actionable quote.
  const reagent = items[1];
  reagent.listed_units = 0;
  reagent.checked_at = at;
  d.querySelector('[data-row="1"]').click();
  assert.match(
    d.querySelector("#body").textContent,
    /current auction quote is needed/,
  );
  reagent.listed_units = null;
  reagent.checked_at = null;
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
  filter("sort", "gold_per_hour");
  assert.match(d.querySelector("#body tr").textContent, /Chained/);
  assert.match(panel.textContent, /Highest projected repeat gold per hour/);
  filter("route", "chain");
  assert.equal(d.querySelectorAll("#body>tr").length, 1);
  d.querySelector(".rowname").click();
  assert.match(d.querySelector(".route").textContent, /Disenchant 2 × Ring/);
  assert.match(
    d.querySelector(".route").textContent,
    /Craft 1 × Charm from 1 × Dust/,
  );
  d.querySelector("[data-copy]").click();
  await wait();
  assert.match(copied, /Sell the finished items to a vendor/);
  assert.equal(d.querySelector("#batchSizeLabel").hidden, false);
  assert.equal(d.querySelector("#batchSize").value, "1");
  filter("batchSize", "3");
  assert.match(d.querySelector("#head").textContent, /Batch estimate/);
  const estimate = () =>
    d.querySelector("#body tr:first-child td:last-child").textContent;
  assert.match(estimate(), /2s 49c profit3 runs · 1m 12s/);
  assert.match(estimate(), /Insufficient stock for batch/);
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
  d.querySelector(".rowname").click();
  const batch = d.querySelector('[data-field="batch"]');
  assert.equal(batch.placeholder, "3");
  assert.match(estimate(), /3 runs · 2m 5s/);
  batch.value = "2";
  batch.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.match(estimate(), /2 runs · 1m 5s/);
  filter("batchSize", "5");
  assert.match(estimate(), /2 runs · 1m 5s/);
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
  d.querySelector("[data-sim-craft]").click();
  assert.match(d.querySelector("#sim-stock").textContent, /Ore needs 6/);
  const projected = await runSimulation();
  assert.match(projected, /Mean batch cost64c/);
  assert.match(projected, /Mean batch profit1s 36c/);
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
  assert.match(estimate(), /5 runs · 4m 5s/);
  assert.match(d.querySelector(".route li").textContent, /Ore × 15/);
  d.querySelector("[data-sim-craft]").click();
  d.querySelector("#sim-volatility").value = 0;
  assert.match(await runSimulation(), /Mean batch cost1s 15c/);
  const minYield = d.querySelector("#sim-yield-min"),
    maxYield = d.querySelector("#sim-yield-max");
  assert.equal(minYield.value, "1");
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
  w.location.hash = "#opportunities";
  await wait();
  assert.equal(d.querySelector("#batchSize").value, "5");
  assert.equal(JSON.parse(w.sessionStorage.wam).batchSize, 5);
  w.location.hash = "#professions";
  await wait();
  fail = true;
  d.querySelector("#refresh").click();
  await wait();
  assert.match(d.querySelector("#notice").textContent, /Connection lost/);
  assert.equal(d.querySelectorAll(".route").length, 1);
  console.log(
    "Dashboard search, pagination, routes, batch shortage, postage, clipboard and offline retention passed",
  );
  dom.window.close();
})().catch((e) => {
  console.error(e);
  dom.window.close();
  process.exitCode = 1;
});
