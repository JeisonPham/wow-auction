# WoW Auction Monitor
## Local rebuild guide for version 0.3.0

WoW Auction Monitor helps a WoW Forever player answer three questions. What is an item worth in my market? How much stock did I actually see at the auction house? Can I earn gold by vendoring an item, crafting a learned recipe, or disenchanting equipment? It combines TradeSkillMaster (TSM) price estimates with observations from the player's own game client. The player performs scans, purchases, crafting, mailing, and sales in game.

**To run the same project**, start with section 1 and the companion archive `wow-auction-monitor-docker.zip`. Despite its name, the ZIP contains the full source, locked dependencies manifest, and tests. **To write your own implementation**, use the component map, wire format, pricing rules, and acceptance cases below. The separate download page distributes release files. The dashboard itself runs on your machine.

### 1. Build and open the existing project

You need Docker with Linux containers and Docker Compose on the host. Python 3.9+ is used for the companion on the gaming PC. WoW, the add-on, and the TSM desktop app are optional for starting the market dashboard. A fresh source build needs access to the Rust dependencies and container base images. Live public prices require outbound HTTPS to `public-data.tradeskillmaster.com`.

1. Extract `wow-auction-monitor-docker.zip`. Open a terminal in the extracted `wow-auction-monitor` folder, alongside `Cargo.toml`, `Dockerfile`, and `compose.yaml`. Use the Compose file **inside the ZIP** for source builds. The separately downloadable Compose file uses an already-loaded image.
2. Create the upload token once in this folder. This command preserves an existing `.env`. Use `python3` on macOS/Linux or `py -3` on Windows.

   ```sh
   python3 -c "import os,secrets; f=os.fdopen(os.open('.env',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600),'w'); f.write('WOW_UPLOAD_TOKEN='+secrets.token_hex(32)+'\n'); f.close()"
   ```

3. Build and start. The Dockerfile compiles for the builder's architecture, including x86-64 and ARM64.

   ```sh
   docker compose up -d --build
   docker compose ps
   curl -fsS http://127.0.0.1:8765/healthz
   ```

   The health endpoint should print `ok`. Open **http://127.0.0.1:8765/** on the host. On a new installation the market tab fills when the first public feed fetch succeeds. An empty opportunities tab is expected until the server has item or recipe data.

4. For a prebuilt Linux x86-64 installation, load the release archive once and start the service with the same token setup.

   ```sh
   docker load -i wow-auction-monitor-linux-amd64.tar.gz
   docker compose up -d --no-build --pull never
   ```

If the host is a separate server, run the following in a terminal on the gaming PC and leave it open. Use **http://127.0.0.1:8875/** for both the browser and uploader. Replace `user@your-server` with your SSH destination.

```sh
ssh -NT -o ExitOnForwardFailure=yes -L 8875:127.0.0.1:8765 user@your-server
```

### 2. Components and ownership

| Component | Source in the ZIP | Responsibility |
| --- | --- | --- |
| Rust service | `src/main.rs`, `src/lib.rs`, `src/service.rs` | Load config, restore state, schedule updates, serve HTTP and the embedded web UI. |
| Market data and interchange | `src/feed.rs`, `src/scan.rs` | Fetch and validate public CSV, validate version-1 gzip JSON uploads, enforce timestamp and size limits. |
| Planner | `src/planner.rs`, `src/disenchant.rs` | Resolve prices and quantities, calculate routes, select the next targeted scan. |
| Browser dashboard | `web/index.html`, `web/app.css`, `web/app.js` | Render reports, filter routes, calculate batches and mail, copy instructions. No frontend build step. |
| In-game add-on | `addon/WowAuctionSync/{WowAuctionSync.toc,Queue.lua,Scanner.lua,Recipes.lua}` | Observe game APIs after player action and commit completed scans and learned profession profiles to SavedVariables. |
| Gaming PC companion | `client/{sync.py,snapshot.py,lua_data.py,disenchant.py}` | Install the add-on, read saved files, import optional TSM data, upload a snapshot and write the next queue. Uses the Python standard library. |
| Build and tests | `Cargo.toml`, `Cargo.lock`, `Dockerfile`, `compose.yaml`, `tests/`, `client/test_sync.py`, `addon/tests/scanner.lua` | Reproduce the service and exercise pricing, data interchange, persistence, and scanner behavior. |

The Rust crate uses edition 2021 and declares Rust 1.85 as its minimum. The Dockerfile builds with `rust:1.93.1-trixie` and runs on `buildpack-deps:trixie-curl` as UID/GID 10001. The locked dependency set includes `tiny_http`, `serde`, `serde_json`, `csv`, `chrono`, `flate2`, `fs2`, `tempfile`, and `subtle`. The server embeds the web assets in the binary. Its persistent state consists of files in one directory.

**The data cycle.** The host can fetch TSM prices by itself. The add-on writes a completed observation in memory. A UI reload or logout flushes it to disk. Python reads the saved files, posts one market-scoped snapshot, and downloads the next item IDs to `Queue.lua`. A further UI reload makes that queue visible in game. The player opens the auction house and scans it. The browser only reads the resulting report, so it needs neither a game installation nor the upload token.

### 3. Configure the host and preserve its data

| Setting | Default | Meaning |
| --- | --- | --- |
| `WOW_REGION` / `WOW_MARKET` | `Forever-US` / `Normal-Alliance` | One region, ruleset/realm, and faction per service. Match the uploader exactly. Use a separate volume per market. |
| `WOW_UPLOAD_TOKEN` | Required by Compose | Shared secret for uploads and personal queue reads. The host accepts 32–512 printable non-space ASCII characters. |
| `WOW_UPLOAD_TOKEN_FILE` | Optional | Native server and Python client can read a file containing only the token. It takes precedence. The supplied Compose file passes the environment token. |
| `WOW_MAX_AGE_SECONDS` | `21600` | Six-hour window for actionable estimates and observations. Accepted range is 1–31,536,000 seconds. |
| `WOW_TSM_PUBLIC` | `1` | Set to `0` for an offline or desktop-upload-only market. The server also accepts `true` and `false`. |
| `WOW_PORT` / `WOW_IMAGE` | `8765` / `wow-auction-monitor:local` | Compose host port and image tag. The port binds to host loopback. |
| `WOW_BIND` / `WOW_DATA_DIR` | Native `0.0.0.0:8765` / `.` | Native listener and storage path. Compose keeps data at `/data` in the named `dashboard-data` volume. |

The service holds an exclusive lock on `dashboard.lock`. It writes the normalized upload to `scan-upload.json.gz` and caches the public feed in `tsm-public.json`. Replace files through a same-directory temporary file, flush and sync it, rename, then sync the directory on Unix before publishing new report data. Restore the last valid upload at startup. An invalid or mismatched upload stops startup with an error. An invalid public cache triggers a fresh fetch. Read requests share cached, serialized views. Recompute after upload, feed refresh, or data expiry.

Compose uses `restart: unless-stopped` and a `curl` health check against `/healthz`. An ordinary `docker compose down` retains the volume. For a restorable copy, preserve the volume and the upload token separately. `docker compose logs --tail 30 dashboard` shows startup and feed errors. The dashboard and reports are readable by anyone who can reach the listener. Use the loopback/SSH setup above, or put viewer authentication on your HTTPS proxy and preserve the uploader's bearer header.

For a native development run, from the project root in a POSIX shell, load the generated token and start the binary on loopback. A native build needs Cargo, a Rust toolchain, and a linker. Live feed fetching also needs `curl` and a working TLS trust store.

```sh
cargo build --locked
set -a
. ./.env
set +a
WOW_BIND=127.0.0.1:8765 WOW_DATA_DIR=./local-data cargo run --locked -- serve
```

### 4. Market observations and price precedence

| Source | What it establishes | Timestamp and coverage |
| --- | --- | --- |
| Public TSM DBRecent | Estimated unit price in copper and item name. Listing count and stock stay unknown. | One upstream `updatedAt` for a complete realm/faction CSV. |
| TSM desktop AppHelper | Estimated unit price and estimated auction count. A count of auctions cannot determine units in those auctions. | One matching realm block with a `downloadTime`. |
| Completed full scan | Aggregate buyout, units, and auction count for eligible base items. A missing item in a fresh full scan means zero checked units. | One game capture time, market-wide coverage. |
| Completed targeted scan | Positive aggregates or an explicit zero for each checked ID. Other items keep their other source of coverage. | One capture time and an explicit coverage map. |

The public feed URL is `https://public-data.tradeskillmaster.com/forever/{region}/realm/{realm}-{faction}/items.csv`, using lowercase components. The default suffix is `/forever/us/realm/normal-alliance/items.csv`. Use an RFC-compatible CSV reader and require unique `itemId`, `name`, `recent`, and `updatedAt` column names, unique positive item IDs, and one identical RFC 3339 timestamp across the rows. Skip empty or zero prices. Reject malformed, mixed-time, empty-priced, or oversized feeds. Limits are 16 MiB and 250,000 rows. Check every 30 minutes and retry failures after two minutes. Keep the last successful feed on failure or timestamp rollback.

Select **one whole estimate book** by its upstream time. The desktop book wins a tie because it can supply auction counts. A missing item in the selected book has no estimate. Preserve the source, time, and count for a stale book, and clear its actionable prices. Compare age to the original observation time, with a five-minute allowance for future clock skew. A repeat download of old data keeps its old age.

For each item, use the newest fresh targeted check if it covers that item and is at least as recent as the full check. Otherwise use a fresh full check, or leave physical stock unknown. **`null` means unchecked, `0` means checked and empty, and a positive value is the observed unit count.** A checked-empty item has no checked unit price. Names come from uploaded item metadata, then the public feed, then the fallback `Item {id}`.

### 5. Run or recreate the scanner and uploader

On the gaming PC, extract the ZIP so `client` and `addon` are sibling folders. The following PowerShell instructions assume the SSH tunnel from section 1. For a dashboard on the same PC, change the URL to port 8765. Enter the server's existing upload token at the prompt.

```powershell
$game = 'C:\Program Files (x86)\World of Warcraft\_forever_'
py -3 client/sync.py install --wow-dir "$game"
$env:WOW_UPLOAD_TOKEN = [Net.NetworkCredential]::new('', (Read-Host 'Server upload token' -AsSecureString)).Password
py -3 client/sync.py sync --wow-dir "$game" --server http://127.0.0.1:8875 --watch
```

1. Enable **WoW Auction Sync** and type `/reload`. At your faction capital's auction house, use `/wamsync full`. Keep the window open until the chat completion message. Type `/reload` to save.
2. Open each character's own profession window. Type `/wamsync recipes`, then `/reload`. This gives the planner the learned recipes, crafters, and eligible enchanters.
3. When the watcher announces a new queue, type `/reload` to load it. At the auction house, use `/wamsync scan`. Wait for completion, then `/reload` to send the new observations.
4. `/wamsync status` reports the market and activity. `/wamsync cancel` discards an unfinished scan. `/wam` is an alias when the older monitor add-on is absent.

**In-game behavior.** The add-on targets Forever interface 16001. Its manifest declares `WowAuctionSyncDB` and loads `Queue.lua`, `Scanner.lua`, then `Recipes.lua`. Scope is computed from the game region, ruleset, and player faction. Require an open auction house in a supported faction capital and allow one scan at a time. Full scans call `C_AuctionHouse.ReplicateItems`. Read up to 250 rows per frame, retry missing item/link information, skip bid-only listings and modified item variants, and commit only a complete result. Targeted scans process queued IDs serially using the game's throttle and pagination APIs. Accept complete results for the matching commodity or item key, deduplicate returned auction IDs when available, and record a zero for each checked empty item. Commodity totals are unit price times quantity. Noncommodity rows already carry total buyout. Queue expiry, cancellation, timeout, or closing the window discards unfinished work.

**SavedVariables.** `WowAuctionSyncDB.version` is 1. The keys `markets[market]` and `targeted[market]` hold the last committed full and targeted records respectively. Each record carries `region`, `capturedAt`, and `items[id] = {quantity,totalBuyout,auctions}`. A targeted record also carries `checked[id]` and `complete=true`. `profiles[region .. "/" .. market]` holds `characters` and `itemInfo`. Cache names, item levels, class, quality, equipment type, max stack, and vendor sell prices when the game supplies them. Record learned recipes from the player's own profession using minimum output quantity, fixed required reagent slots, merged quantities for repeated reagents, crafter and profession rank. Ignore optional slots and skip recipes with ambiguous required alternatives. Record station, tools, and skill/source information when available.

**Desktop behavior.** Watch `WTF/Account/*/SavedVariables/{WowAuctionSync,WowAuctionMonitor}.lua`, the TSM AppHelper realm file, and the installed TSM disenchant tables. Parse data literals without running Lua. Merge only the requested scope. Choose the latest full scan, deduplicate targeted captures, and merge consistent recipes across characters. Fingerprint inputs by path, modification time, and size. If a file changes during export, retry. Use the maximum input modification time in Unix microseconds as the revision. The AppHelper reader selects `AUCTIONDB_NON_COMMODITY_DATA` for the matching region and market, decodes base-32 `marketValueRecent` and `numAuctions`, and accepts base item IDs.

POST a deterministic gzip snapshot, verify the returned revision, then fetch the personal queue. The watcher polls every 15 seconds by default, including queue reads when the local snapshot is unchanged. The queue writer checks scope, revision, freshness, and ID uniqueness. It atomically replaces only the generated `Queue.lua` with `WowAuctionSyncQueue = {region,market,generatedAt,expiresAt,items}`. Reinstalling preserves the existing queue. Use `--poll SECONDS` to change the interval, omit `--watch` to sync once, and pass `--region` and `--market` for a nondefault scope. An existing version-1 portable export can be sent with `python3 client/sync.py sync --bundle scan.json.gz --server http://127.0.0.1:8765`. The client accepts HTTPS, or HTTP over loopback, and refuses redirects.

**Compatibility detail.** The add-on emits the combined ruleset label `Roleplay PvP` with a space. The version-0.3.0 server's realm URL validation only accepts alphanumeric slug segments separated by hyphens. That particular scope needs a consistent display-name-to-feed-slug mapping across components. The default `Forever-US / Normal-Alliance` is consistent across all three.

### 6. HTTP API and version-1 wire format

| Method and path | Access | Response or effect |
| --- | --- | --- |
| `GET /`, `/app.css`, `/app.js` | Viewer | Static assets embedded in the executable. |
| `GET /healthz` | Viewer | `200`, plain text `ok` and a newline. Process health remains independent of upstream price availability. |
| `GET /api/status` | Viewer | `responsive`, region, market, upload revision, report generation time, active TSM source/state/count/time/error, public-feed enablement and last check time. |
| `GET /api/report` | Viewer | `region`, `market`, `generated_at`, `upload_revision`, `status`, `tsm`, `items`, `scan_queue`, `queue_estimate_at`. |
| `GET /api/candidates` | Viewer | `{items, tsm, upload_revision}`. Here `items` is an array of shortlisted IDs. |
| `POST /api/scans` | Bearer token | `Content-Type: application/gzip`. On success, `202` with `{status,revision}`. Status is `accepted` or `unchanged`. |
| `GET /api/scan-queue` | Bearer token | `{region,market,items,estimate_at,expires_at,upload_revision}`. Returns `503` until the first accepted upload. An empty queue after an upload is valid. |

Read routes also support HEAD. JSON read views share a generation ETag and return `304` for a matching `If-None-Match`. Upload and personal queue routes require exactly one `Authorization: Bearer <token>` header. Handle a bad token with `401`, unsupported upload type with `415`, oversized compressed data with `413`, invalid bundles or wrong scope with `422`, and stale or conflicting revisions with `409`. If saving fails, return `503` and keep serving the previous snapshot. HTTP errors use a JSON `error` string.

**Minimal wire example.** The following JSON is the body *before* gzip. The ZIP's `tests/test_host.py` generates a larger example with current timestamps. In this fixed example, item 1001 has four units across two auctions, item 1002 was checked and empty, and any item outside this capture has unknown stock until another current observation covers it. Use current times for a live freshness test.

```json
{
  "version": 1,
  "region": "Forever-US",
  "market": "Normal-Alliance",
  "revision": 1700000010000000,
  "snapshot": {
    "estimate_at": 1700000000,
    "estimate_prices": {
      "1001": {"total_buyout": 7, "units": 1, "auctions": 6, "observed_at": 1700000000}
    }
  },
  "targeted": [{
    "captured_at": 1700000010,
    "prices": {
      "1001": {"total_buyout": 22, "units": 4, "auctions": 2, "observed_at": 1700000010}
    },
    "listed_units": {"1001": 4, "1002": 0}
  }]
}
```

| Snapshot fields | Shape and meaning |
| --- | --- |
| `newest_price_at`, `prices` | Full-scan time and item-ID map of price records. Each record's `observed_at` matches the book. |
| `estimate_at`, `estimate_prices` | Desktop estimate book. Encode the unit estimate in `total_buyout`, set `units=1`, and put the estimated auction count in `auctions`. |
| `items`, `tsm_item_count` | Item-ID map with `name`, `vendor_sell` and optional `vendor_buy`, `max_stack`, `level`, `class`, `quality`, `inventory_slot`, `inventory_type`, `no_disenchant`. Item count must match the map after normalization. |
| `recipes`, `recipe_requirements` | Each recipe has a string `id`, `name`, `output` item ID, `quantity`, `mats: [[item_id,quantity],…]` and optional `characters`. Requirements are keyed by recipe ID and carry `profession` plus optional skill, character level, pattern, source, recipe items, tools, station, and secondary-profession flag. |
| `professions`, `character_levels`, `complete_rosters` | Character → profession → rank, character → level, and names with complete rosters. |
| `disenchant`, `non_disenchantable` | Expected-yield rules by equipment class, quality and level range, and the set of excluded item IDs. Distinguish absent exclusions from a known empty set. |
| `local_scan_failed`, `warnings` | Mark a partial or diagnostically failed legacy export. Reject an upload that sets the failure flag or carries warnings. |

Accept **one gzip member**, at most 32 MiB compressed and 128 MiB expanded. The version, market, region, revision and snapshot are required. Times are UTC Unix seconds except for the positive microsecond revision. Item IDs are positive 32-bit integers, and copper/count values must fit the exact Lua integer range through 2⁵³−1. Validate observation times, duplicate map keys, positive price records, matching quantities, and scope. Full/targeted auction counts cannot exceed units. Default missing snapshot collections to empty. Cap a price book or item map at 500,000 entries, recipes at 50,000, targeted captures at 128, and checked IDs per targeted capture at 100,000.

An identical normalized upload with the same revision is idempotent, including after restart. Reject the same revision with different contents and all lower revisions. A newer file revision also cannot rewind any of the full scan, desktop estimate, or newest targeted observation. An expired source may disappear. Sort targeted captures newest first and publish the accepted revision only after durable storage succeeds.

### 7. Calculation rules

Keep the original integer copper and quantities. Round only at the specified step. A checked unit price is a **weighted average** across the captured listings. The UI cannot promise the exact price of the cheapest auction or execution at the calculated price.

| Route | Cost and proceeds for one run | Eligibility |
| --- | --- | --- |
| Auction purchase → vendor | Cost is the rounded-up cost of one auction unit. Proceeds equal known vendor sell value. | Keep a vendor route when its current or preliminary estimated profit is positive. |
| Learned recipe → vendor | Price each required material, round up each line, then sum. Proceeds equal vendor sell value × recipe output quantity. | Retain learned fixed-ingredient recipes even when unprofitable or incompletely priced. Show known requirements and crafters. |
| Auction purchase → disenchant → auction materials | Cost is one equipment unit. Gross is the sum of expected material yield × material unit price. Net proceeds are `floor(gross × 0.95 × 0.85)`. Profit is net proceeds minus cost. | Require eligible equipment, a recorded qualified enchanter, recognized yield and exclusion tables, and prices for every output. Display a route only with positive current profit and no known input shortage. |

**Reagent pricing.** For quantity `q`, an observed auction costs `ceil(total_buyout × q / units)`. When an item is unchecked, use fresh DBRecent as a preliminary price. For a craft input, choose a known vendor buy price if it is cheaper or equal, the auction quote is missing, or observed auction stock fails to cover the line. Buy the entire line at that source. Uploaded portable metadata can supply vendor buy prices. The new in-game companion collects vendor *sell* prices. A required component with no quote leaves the total unknown. A known shortage takes precedence when combining stock states. Mark a craft or vendor purchase verified when its total cost is known and all inputs have sufficient checked stock or vendor supply.

**Disenchanting.** Read installed `TradeSkillMaster/LibTSMData/Destroy/Disenchant.lua` and `Item/NonDisenchantable.lua`. Import `DATA.Forever` yields and the applicable exclusion sets, including `All`. Unknown conditions or missing tables disable this route. Accept weapons/armor (class 2/4), quality 2–4, a valid equipment slot or type, positive item level, and a matching inclusive level band. Exclude shirts, tabards, flagged items, and conflicting duplicate yield bands. Use `amountOfMats` as expected quantity, which already incorporates drop probability. Apply the 5% AH cut and separate 15% sale reserve once. Select characters with Enchanting rank at least the highest recorded requirement, or a positive rank if unknown. Mark verified only when the input has positive checked stock and every output has a checked price. A verified quote still has random drops and future sale-price risk.

**Targeted queue.** Rank positive preliminary profits from the active estimate book, highest first, breaking ties by output item ID. Each candidate contributes its whole set of auction-dependent inputs. A disenchant candidate contributes the equipment and all expected material IDs. Add complete sets while their union fits **250 distinct IDs**. Skip a set that would overflow and continue with the next candidate. Return unique IDs sorted numerically. A nonempty queue carries the estimate time and expires after the configured age. An empty queue has zero estimate and expiry timestamps.

**Worked acceptance case.** In `tests/test_host.py`, item 1001 is ore with four checked units and 22 copper in aggregate buyout. It costs 5.5 copper per unit. A learned buckle requires three ore and vendors for 100 copper. The reagent line costs `ceil(22 × 3 / 4) = 17` copper. Four checked units cover one craft, so the report shows **verified, 83 copper profit, next queue [1001]**. Two crafts need six ore, so the browser should flag the batch shortage. The fixture also checks that item 1002 shows zero units and item 1003 shows unknown units despite a desktop estimate of 15 auctions.

For an independent disenchant test, one 50-copper item with an expected yield of 1.5 materials priced at 100 copper gives `floor(150 × 0.95 × 0.85) − 50 = 71` copper expected profit. A price supplied only by DBRecent keeps the route estimated.

### 8. Browser behavior

| View | Rows and controls |
| --- | --- |
| **Market prices** (`#market`) | One row per item with item name/ID, TSM unit estimate, checked average buyout, checked units, and last check age. Expand for source/time, estimated and checked auction counts, and vendor payout. Sort by name, highest TSM price, or most units. |
| **Opportunities** (`#opportunities`) | Include routes with positive current profit and stock other than known-insufficient. An estimate may qualify. Show item, route/profession, cost, profit, and verified/estimated status. Sort by profit, name, or stock. |
| **Professions** (`#professions`) | Show craft and available disenchant routes, with known requirements, characters, inputs and outputs. Learned crafts with losses or missing prices stay inspectable. Sort by profit, name, or required character level. |

Use a dark navy background, lighter panels, gold accents, a serif page heading, and a centered, responsive layout. The header includes connection state, Refresh, region and market. Summary cards show TSM count/source, age of the upstream observation, and the number of items with in-game coverage. Zero-stock checked items count toward coverage.

All views support partial case-insensitive name or ID searches and 40 items per page. Route views add profession and maximum character-level filters. Expanding an item exposes routes, per-reagent quantities, source, unit cost, line totals, known requirements, and eligible characters. Use distinct displays for unknown and zero. Format money with 100 copper per silver and 100 silver per gold. Preserve filters, pagination, open rows and calculator selections in browser session storage.

The calculator accepts batches of 1–10,000. Multiply the already rounded per-run cost and proceeds by batch size. For optional mailing to an alt, count each reagent's stacks separately using its known maximum or an editable default of 20. Default postage is 30 copper per stack. Optional return mail uses output stacks for crafts or the chosen return-stack count for disenchant materials. Add postage to batch cost and warn when checked stock falls short. **Copy Markdown** exports the chosen route, quantity, crafter/requirements, ingredients or expected drops, steps, price basis, postage, stock warning, and totals.

Fetch `/api/report` on initial load, manual refresh, returning to the visible tab, and every 30 seconds while visible. Prevent overlapping requests and retain the last report on connection loss. Display fetch errors or stale-feed status. Support keyboard tab navigation, labeled inputs, visible focus, and narrow screens with scrollable tables.

### 9. Reimplementation order and verification

| Milestone | Demonstration that it works |
| --- | --- |
| 1. Host and public market | Build a single binary serving the static app, `/healthz` and `/api/report`. A fixture CSV populates item prices before any upload. Counts and stock from this public source stay unknown. |
| 2. Upload and restore | Send a v1 bundle with a valid token, repeat it, and restart. The revision and report survive. Reject wrong market, bad token, invalid gzip, and conflicting revisions. |
| 3. Pricing and planning | Reproduce the 83-copper buckle, 71-copper disenchant, zero-stock, unchecked, tie-breaking, stale-source, and complete-set queue cases. |
| 4. Companion loop | In a temporary game directory, install the add-on, import a saved fixture and a matching AppHelper block, upload, fetch the generated queue, and confirm reinstall preserves it. |
| 5. Browser and live game | Confirm filters and batching, clipboard instructions, refresh and offline states. In a real Forever client, perform a full scan and a learned-recipe capture, reload, receive a queue, then perform a targeted scan and inspect updated stock. |

From the extracted project root, run the following. The Python host integration tests start a **temporary isolated server**, generate their own token and bundle, and exercise a real HTTP upload and restart. They need the debug binary built first. Lua 5.4 can run the add-on mock fixture.

```sh
cargo test --locked
cargo build --locked
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 -m unittest discover -s client -p 'test_*.py' -v
lua addon/tests/scanner.lua
cargo build --release --locked
```

For an internet-enabled end-to-end check of public TSM data, use `cargo test --locked live_forever_market -- --ignored` or, in a POSIX shell, `WAM_TEST_LIVE=1 python3 -m unittest discover -s tests -p 'test_host.py' -v`. Set `WAM_BINARY` to point the Python host tests at a different compiled binary.

**Verification of this release.** The 30 files in the source ZIP matched the project byte for byte. A clean extraction built the release binary with Rust 1.93.1 and reported `wow-auction-monitor 0.3.0`. All 11 offline Rust tests, seven offline Python tests, and the Lua scanner/profession fixture passed. The Compose file validated and dashboard interaction checks passed. Live TSM availability, a Docker container launch, and execution inside a real WoW client remain unverified in this environment.

**Scope of the release.** The dashboard keeps the latest accepted snapshot and public cache. Historical charts, a catalog of unlearned training recipes, and automatic auction transactions are outside this version. A clean installation can show public estimates immediately after a successful fetch. Personal crafting and disenchanting depend on the uploaded profiles, metadata, and current quotes described above.

Source archive SHA-256: `c8fe438e1c78e839d246d122887f8e4321c8568661dd538ee062f5e1b23d3b88`.
