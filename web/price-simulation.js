"use strict";

importScripts("/calculations.js");
self.onmessage = ({ data }) => {
  try {
    if (data.module) AuctionMath.use(data.module);
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const result = AuctionMath.call(data.model.optimize ? "optimize" : "simulate",
      data.model, data.trials, data.volatility, seed);
    self.postMessage({result});
  } catch (error) {
    self.postMessage({error: error.message});
  }
};
