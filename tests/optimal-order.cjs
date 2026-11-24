const assert = require("node:assert/strict");
const {engine} = require("./wasm.cjs");

const line = {quantity:2, lots:[[1,3,10],[1,30,30]], max_stack:20};
const base = {limit:20, yield:{min:1, max:1, netPerUnit:20}, lines:[line], settings:{}};
const optimize = (changes, sigma = 0, trials = 5000, seed = 71) => engine.call("optimize", {...base, ...changes}, trials, sigma, seed);
const best = optimize({});
assert.equal(best.casts,5);
assert.equal(best.profit,70);
assert.equal(best.cost,30);
assert.equal(optimize({bankroll:12}).casts,2);
assert.equal(optimize({bankroll:0}).casts,0);
assert.equal(optimize({limit:3}).feasible,3);
assert.equal(optimize({limit:100}).feasible,20);
assert.equal(optimize({yield:{min:1,max:1,netPerUnit:0}}).casts,0);
assert.equal(optimize({lines:[{...line,lots:[],vendor:6}]}).casts,20);
const variable = optimize({yield:{min:1,max:5,netPerUnit:10},settings:{mail:true,post:1}});
assert.deepEqual([variable.casts,variable.minPieces,variable.maxPieces,variable.postage],[5,5,25,1]);
assert.ok(Math.abs(variable.pieces - 15) < 0.15);
assert.throws(()=>optimize({yield:{min:1,max:2,netPerUnit:null}}),/sale value/);
assert.throws(()=>optimize({limit:0}),/Maximum crafts/);

// Independent exhaustive oracle: enumerate every combination of small mixed stacks,
// including overbuy, partial vendor top-up, budget and postage.
let seed=7;
const pick=n=>(seed=(Math.imul(seed,1664525)+1013904223)>>>0)%n;
for(let fixture=0;fixture<90;fixture++){
  const lots=Array.from({length:3},()=>[1+pick(5),1+pick(12),1+pick(3)]);
  const vendor=fixture%3===0 ? 1+pick(6) : null;
  const quantity=1+pick(3), limit=1+pick(9), budget=pick(55);
  const sale=1+pick(14);
  let profit=0, casts=0;
  for(let n=1;n<=limit;n++){
    let cheapest=Infinity;
    for(let i=0;i<=lots[0][2];i++) for(let j=0;j<=lots[1][2];j++) for(let k=0;k<=lots[2][2];k++){
      const counts=[i,j,k];
      const missing=Math.max(0,quantity*n-counts.reduce((v,c,h)=>v+c*lots[h][0],0));
      if(missing && vendor===null)continue;
      cheapest=Math.min(cheapest, counts.reduce((v,c,h)=>v+c*lots[h][1],0)+missing*(vendor||0));
    }
    const cost=cheapest+Math.ceil(quantity*n/3);
    if(cost<=budget && sale*n-cost>profit){profit=sale*n-cost;casts=n}
  }
  const result=optimize({limit,bankroll:budget,lines:[{lots,vendor,quantity,max_stack:3}],settings:{mail:true,post:1},yield:{min:1,max:1,netPerUnit:sale}});
  assert.deepEqual([result.casts,result.profit],[casts,profit],JSON.stringify({lots,vendor,quantity,limit,budget,sale}));
}
console.log("Wasm craft optimizer matches exhaustive purchases, limits, variable output, postage and zero-profit decisions.");

// At the quoted stock the best order is ten. Across uncertain markets a smaller
// committed order makes more gold. Skipped orders earn zero, with no partial purchases.
const scarce = {limit:15, stockSpread:50, lines:[{id:1, quantity:1, lots:[[1,10,10]]}],
  yield:{min:1,max:1,netPerUnit:20}};
const committed = optimize(scarce);
assert.equal(optimize({...scarce, stockSpread:0}).casts,10);
assert.ok(committed.casts < 10 && committed.casts > 4);
assert.ok(committed.fillPercent < 100 && committed.fillPercent > 50);
assert.equal(committed.winPercent,committed.fillPercent);
assert.equal(committed.p5,0);
assert.ok(Math.abs(committed.profit - committed.casts * 10 * committed.fillPercent / 100) < 1e-8);
assert.deepEqual(committed,optimize(scarce));
const order = {limit:1, lines:[{id:1,quantity:1, vendor:90,lots:[]}],
  yield:{min:1,max:1,base:1,netPerUnit:100,marketSale:true,saleItems:[{id:2,quantity:1,unit_cost:125}]}};
const volatile = optimize(order,40);
assert.equal(volatile.casts,1);
assert.ok(volatile.p5 < 0 && volatile.p95 > 0 && volatile.winPercent < 80);
assert.equal(volatile.fillPercent,100);
assert.equal(volatile.cost,90);
assert.ok(Math.abs(volatile.profit - (volatile.out-volatile.cost)) < 1e-8);
assert.deepEqual(volatile,optimize(order,40));
assert.notEqual(volatile.profit,optimize(order,40,5000,72).profit);
const vendor = optimize({...order,yield:{...order.yield,marketSale:false}},40);
assert.equal(vendor.low,10); assert.equal(vendor.high,10);
const repriced = optimize({...order,yield:{...order.yield, refreshSale:true, netPerUnit:null}});
assert.equal(repriced.profit,10); // 125c less auction deductions, floored to 100c.
const capped = optimize({...order, bankroll:90, lines:[{id:1,quantity:1,lots:[[1,88,5]]}]},30);
assert.ok(capped.cost<=90 && capped.fillPercent<100 && capped.fillPercent>0);
assert.ok(capped.winPercent<capped.fillPercent); // Occasional filled orders lose gold.
const zero = optimize({...order,bankroll:5},40);
assert.equal(zero.casts,0); assert.equal(zero.profit,0);
assert.throws(()=>optimize({},-1),/deviation/); assert.throws(()=>optimize({},10,5),/trials/);
assert.throws(()=>optimize({stockSpread:105}),/stock deviation/);
console.log("Monte Carlo craft sizes include sampled auction sales, yield, missed fills, budgets, losses and repeatable seeds.");

const tightBudget = {limit:15,bankroll:100,lines:[{id:1,quantity:1,lots:[[1,10,30]]}],
  yield:{min:1,max:1,netPerUnit:20}};
assert.equal(optimize(tightBudget).casts,10);
assert.equal(optimize(tightBudget,20).casts,9); // Price uncertainty alone changes the decision.
