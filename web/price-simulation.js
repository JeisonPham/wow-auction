"use strict";

importScripts("/calculations.js");
self.onmessage = ({ data }) => {
  try {
    AuctionMath.use(data.module);
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const result = data.model.optimize
      ? AuctionMath.call("optimize", data.model)
      : AuctionMath.call("simulate", data.model, data.trials, data.volatility, seed);
    self.postMessage({result});
  } catch (error) {
    self.postMessage({error: error.message});
  }
};
