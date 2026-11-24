const assert = require("node:assert/strict");
const {engine} = require("./wasm.cjs");

const line = {quantity:2, lots:[[1,3,10],[1,30,30]], max_stack:20};
const base = {limit:20, yield:{min:1, max:1, netPerUnit:20}, lines:[line], settings:{}};
const optimize = changes => engine.call("optimize", {...base, ...changes});
const best = optimize({});
assert.equal(best.casts,5);
assert.equal(best.profit,70);
assert.equal(best.cost,30);
assert.equal(optimize({bankroll:12}).casts,2);
assert.equal(optimize({bankroll:0}).casts,0);
assert.equal(optimize({limit:3}).constraint,"Maximum crafts");
assert.equal(optimize({limit:100}).constraint,"Reagent stock");
assert.equal(optimize({yield:{min:1,max:1,netPerUnit:0}}).casts,0);
assert.equal(optimize({lines:[{...line,lots:[],vendor:6}]}).casts,20);
const variable = optimize({yield:{min:1,max:5,netPerUnit:10},settings:{mail:true,post:1}});
assert.deepEqual([variable.casts,variable.pieces,variable.minPieces,variable.maxPieces,variable.postage],[5,15,5,25,1]);
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
