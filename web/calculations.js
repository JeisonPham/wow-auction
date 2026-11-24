"use strict";

// Both the page and its worker use the same compiled Rust module. Each has private linear memory.
const AuctionMath = (() => {
  let instance, module, pending;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  function use(compiled) {
    module = compiled;
    instance = new WebAssembly.Instance(compiled).exports;
  }
  async function load() {
    if (instance) return;
    if (!pending) pending = (async () => {
      const response = await fetch("/auction.wasm");
      if (!response.ok) throw Error("Could not load the auction calculation engine.");
      const compiled = WebAssembly.compileStreaming
        ? await WebAssembly.compileStreaming(response)
        : await WebAssembly.compile(await response.arrayBuffer());
      use(compiled);
    })().finally(() => { pending = null; });
    return pending;
  }
  function call(op, ...args) {
    const bytes = encoder.encode(JSON.stringify({ op, args }));
    const start = instance.reserve_input(bytes.length);
    new Uint8Array(instance.memory.buffer, start, bytes.length).set(bytes);
    const length = instance.calculate();
    const output = new Uint8Array(instance.memory.buffer, instance.output_ptr(), length);
    const message = JSON.parse(decoder.decode(output));
    if (message.error) throw Error(message.error);
    return message.result;
  }
  return { use, load, call, get module() { return module; }, get scalar() { return instance; } };
})();
