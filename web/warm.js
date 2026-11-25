"use strict";

// The published market version owns all cached trials. Only the render thread's
// chosen inputs and the compiled module cross into the reusable calculation worker.
let trialCache = new Map(), trialWorker, trialRun = 0, displayedTrial;
function trialKey(model, trials, volatility) {
  const y = model.yield;
  // Per-item lots belong to the snapshot. Quantity, source and quote can vary by price basis.
  return JSON.stringify([trials,volatility,model.optimize || false,model.order || false,model.unitOnly || false,
    model.target,model.limit,model.batch,model.postage,model.proceeds,model.bankroll,model.stockSpread,
    model.settings,model.destroys,y,model.lines.map(l => [l.id,l.quantity,l.max_stack,l.source,l.unit_cost,l.cost,l.vendor,l.listed_units])]);
}
function unitModel(item) {
  return {itemId:item.id,unitOnly:true,batch:1,postage:0,proceeds:null,
    lines:[{id:item.id,name:item.name,source:"estimate",quantity:1,unit_cost:item.estimate}]};
}
function batchModel(item, route, c, batch) {
  return {itemId:item.id,routeId:routeKey(item,route),unitOnly:false,batch:c.batch,postage:batch.postage,proceeds:batch.out,
    expectedInputs:!!route.expected_inputs || destroys(route),chained:!!route.stages?.length,
    yield:craftYield(item,route,c),lines:route.inputs};
}
function savedModel(base) {
  const m = {...base};
  if (m.yield) m.yield = {...m.yield,...saved.yieldRanges?.[m.yield.key]};
  if (m.order) {
    m.stockSpread = saved.simulation?.stockSpread ?? 10;
    if (m.optimize) {
      m.limit = saved.optimizer?.limit ?? 100;
      m.bankroll = saved.optimizer?.budget ? AuctionMath.scalar.gold_to_copper(Number(saved.optimizer.budget)) : null;
    } else m.target = saved.orderTargets?.[m.yield.key] ?? m.target;
    m.lines = resolveOrderListings(m,false);
  } else if (m.proceeds != null && saved.simulation?.gold) {
    m.bankroll = AuctionMath.scalar.gold_to_copper(Number(saved.simulation.gold));
  }
  return m;
}
function* trialModels() {
  const defaults = {calc:{}};
  const views = Array.from(new Set([saved.opportunities || defaults,saved.professions || defaults]));
  // Process each item once and let the key deduplicate matching settings in the two views.
  for (const item of report.items) {
    if (item.estimate > 0) yield unitModel(item);
    for (const base of item.routes.filter(isCraft)) for (const preferences of views) {
      const c = calc(item,base,preferences);
      const r = pricedRoute(item,base,preferences);
      const order = craftOrderModel(item,r,c);
      yield {...order,optimize:true};
      yield {...order,optimize:false};
      const raw = r.forecast ? base : r;
      if (raw.inputs.every(l => Number.isFinite(l.cost) && Number.isFinite(l.unit_cost)))
        yield batchModel(item,raw,c,summary(item,raw,c));
    }
  }
}
function warmTrials(reset = false) {
  const version = ++trialRun;
  trialWorker?.terminate();
  trialWorker = null;
  if (reset) trialCache = new Map();
  if (!report || typeof Worker === "undefined") return;
  const jobs = trialModels();
  const trials = saved.simulation?.trials ?? 5000;
  const volatility = saved.simulation?.volatility ?? 10;
  function next() {
    if (version !== trialRun) return;
    const start = performance.now();
    do {
      const job = jobs.next();
      if (job.done) { trialWorker?.terminate(); trialWorker = null; return; }
      let model;
      try { model = savedModel(job.value); } catch { continue; } // Missing listing data.
      const key = trialKey(model,trials,volatility);
      if (trialCache.has(key)) continue;
      try {
        const module = trialWorker ? undefined : AuctionMath.module;
        const worker = trialWorker ??= new Worker("/price-simulation.js");
        worker.onmessage = ({data}) => {
          if (version !== trialRun) return;
          if (!data.error && !trialCache.has(key)) trialCache.set(key,data.result);
          schedule();
        };
        worker.onerror = () => { if (version === trialRun) { worker.terminate(); trialWorker=null; } };
        worker.postMessage({module,model,trials,volatility});
      } catch { trialWorker?.terminate(); trialWorker = null; }
      return;
    } while (performance.now()-start < 8);
    schedule();
  }
  function schedule() {
    if (window.requestIdleCallback) window.requestIdleCallback(next,{timeout:150});
    else setTimeout(next,0);
  }
  schedule();
}
function showPreparedTrial(base) {
  const trials = saved.simulation?.trials ?? 5000;
  let model;
  try { model = savedModel(base); } catch { return; }
  const key = trialKey(model,trials,saved.simulation?.volatility ?? 10);
  const result = trialCache.get(key);
  if (result) {
    if (model.order) resolveOrderListings(model,true);
    showSimulationResults(result,trials);
    displayedTrial = key;
  }
}

function refreshOpenSimulation() {
  const old = simulationModel;
  if (!old) return;
  const item = listingBook.get(old.itemId);
  const base = item?.routes.find(r => routeKey(item,r) === old.routeId);
  if (!item || (!old.unitOnly && !base)) { $("simulation").close(); return; }
  if (old.unitOnly) {
    openSimulation(item.name,unitModel(item),[],item.estimate_at,true);
    return;
  }
  const route = pricedRoute(item,base);
  const c = calc(item,route);
  if (old.order) {
    const model = {...craftOrderModel(item,route,c),optimize:old.optimize};
    openSimulation(item.name,model,[],report.generated_at,true);
  } else {
    const raw = route.forecast ? base : route;
    const batch = summary(item,raw,c);
    openSimulation(raw.name,batchModel(item,raw,c,batch),batch.shortages,report.generated_at,true);
  }
}
