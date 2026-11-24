const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = process.env.CARGO_TARGET_DIR || "target";
const files = ["debug", "release"].flatMap(profile => {
  const dir = path.join(root, profile, "build");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.startsWith("wow-auction-monitor-"))
    .map(n => path.join(dir, n, "out", "auction.wasm")).filter(f => fs.existsSync(f)) : [];
});
files.sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
if (!files.length) throw Error("Run cargo build --locked first to compile the dashboard Wasm.");
const bytes = fs.readFileSync(files[0]);
const engine = vm.runInNewContext(fs.readFileSync("web/calculations.js","utf8") + ";AuctionMath", {TextEncoder, TextDecoder});
engine.use(new WebAssembly.Module(bytes));
module.exports = {bytes, engine};
