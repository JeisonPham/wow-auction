# WoW Auction Monitor

A local auction scanner and market dashboard for WoW Forever. The scanner evaluates 2,051 catalog recipes across 14 professions and class skill lines, including recipes your characters have never learned. The default market is **Forever-US / Normal-Alliance**.

## Upload from your gaming PC to a hosted REST API

Run TSM Desktop on the gaming PC and enable AppHelper for your Forever installation and market. From the extracted project folder, run the following in PowerShell. Replace the example URL with the **full HTTPS upload endpoint** supplied by your host, including its path.

```powershell
py -3 start.py client --upload-url "https://auction.example.com/api/scans"
```

On macOS or Linux use `python3` in place of `py -3`. Enter the API’s bearer token at the prompt. For a custom game location, add `--wow-dir "D:\Games\World of Warcraft\_forever_"`. The client waits for a populated AppHelper price book, uploads the first snapshot, and checks for changes every 15 seconds while running. Add `--once` for a single upload.

**Endpoint contract.** The client sends an HTTPS POST to the exact URL with `Authorization: Bearer <token>` and `Content-Type: application/gzip`. The body is gzip-compressed scanner JSON with `version`, `revision`, `region`, `market`, `snapshot`, and `targeted`. On success the API can return an empty 2xx response, such as `204 No Content`, or a JSON object with the matching numeric `revision` and an optional `status`. Return an HTTP error if the upload fails. The bundled scanner implements this contract at `POST /api/scans`. The [rebuild guide](wow-auction-monitor-rebuild-guide.md) describes the snapshot fields.

For repeated launches, put `WOW_UPLOAD_URL=https://auction.example.com/api/scans` in a private `client.env` next to `start.py` and run `py -3 start.py client`. For unattended use, also set `WOW_UPLOAD_TOKEN` or `WOW_UPLOAD_TOKEN_FILE`. You can set `WOW_GAME_DIR`, `WOW_REGION` and `WOW_MARKET` in the same file. The market must match the API's configuration. The uploader sends the selected price book and supported scanner exports. TSM sign-in stays on the PC. [TSM setup guide](https://support.tradeskillmaster.com/tsm-desktop-application/how-do-i-set-up-the-tsm-desktop-application)

**In-game scan queue.** If the hosted domain runs the bundled scanner and you use its targeted scans, pass the scanner’s **base URL** with `--server https://auction.example.com` or set `WOW_SERVER_URL` in the client configuration. This mode posts to `/api/scans` and polls `/api/scan-queue` when the add-on is installed. The full-endpoint mode makes only upload requests.

## Hosting the bundled scanner

### Test locally with Docker Compose

From the project folder with Docker running, use:

```sh
docker compose up -d --wait
```

On a fresh checkout, run `python3 start.py --init-only` first (`py -3 start.py --init-only` on Windows) to generate the upload token in `.env`. Compose builds the dashboard image from the local Dockerfile on each `up`. The command returns once the dashboard passes its health check.

Open **http://127.0.0.1:8765/**. For a local upload test, use **http://127.0.0.1:8765/api/scans** as the client's upload URL. Run `docker compose logs -f dashboard` to follow the logs, or `docker compose down` to stop the scanner and keep its data.

### Host on a domain

To host the included API and dashboard yourself, run `python3 start.py server` on the server with Docker running. Route your domain’s HTTPS traffic to the scanner on host loopback port 8765. The first launch creates a private `.env` containing `WOW_UPLOAD_TOKEN`. Keep the existing Compose project name to reuse the `dashboard-data` volume. The server retains the last accepted upload across restarts. On the dashboard, **Last upload** shows receipt time and **Estimate age** shows price freshness.

Set `WOW_PORT` in the server's `.env` to change the host port. The server also fetches public TSM estimates. Set `WOW_TSM_PUBLIC=0` to use only uploaded estimates. A native server uses `python3 start.py server --native` with Rust and curl installed and stores data in `local-data/`.

### Optional Docker-hosted TSM Desktop

For an all-in-one installation, run `python3 start.py server --desktop` on the machine with the game files. Supply `--wow-dir` for a custom installation. Open **http://127.0.0.1:5800/**, sign in to TSM, select `/wow` and enable AppHelper. This optional image bundles the Linux amd64 desktop app, its browser and the watcher. It preserves the desktop profile in `tsm-profile`. Only the Forever `Interface/AddOns` mount is writable in the game directory. Set `WOW_TSM_PORT` to change the desktop port. [Browser sandbox profile sources](container/MOBY-LICENSE.txt)

## Find profitable crafts and plan professions

Open **Professions** to evaluate the full catalog, or **Opportunities** for positive margins with enough known stock or estimated availability. Pick **Craft → vendor**, **Craft → disenchant**, or **Craft → auction** in the route filter. The table shows the cost and profit per recipe run. Expand a row for reagents, quantities, qualifications, price sources, cooldowns when known and batch calculations. Eligible direct buy-to-vendor and buy-to-disenchant routes are also supported.

Choose **Highest gold per hour** to compare repeatable routes. **Time / run** counts every intermediate craft, one final recipe cast and one disenchant per piece destroyed. A recipe that produces several pieces takes one cast. **Repeat gold/hour** divides net profit by the time until the same production schedule can start again. Set **Batch size (runs)** in Opportunities or Professions to compare 1–10,000 repetitions of each route. With multiple runs, the **Batch estimate** column shows net profit, total time, gold per hour and known stock shortages. The two views share this setting and remember it on reload in the same tab. In an expanded row, **Batch size override** changes just that route in the current view. Clear the override to follow the shared setting. Shopping quantities, postage, production steps, copied instructions and craft simulations use the effective batch size. Batch timing starts with cooldowns ready, includes waits between casts of the same recipe, and ends when the last action finishes. Cooldowns can overlap other work. Travel, switching characters, buying, mailing and selling time are excluded. Shared cooldown groups, character speed bonuses and extra disenchant rolls are outside this estimate. An unrecorded cast uses a flagged three-second estimate. Buy-to-vendor flips have no timed production step.

Vendor routes use the output’s vendor sell price. Disenchant routes use the expected sale value of the materials from all crafted outputs. Both auction exits allow for a 5% auction cut and a 15% sale reserve. Prices are in copper internally. Missing input prices leave the margin unknown. A listed auction price is an estimate of resale value, and disenchant drops vary per roll. See [catalog sources and coverage](src/data/SOURCES.md).

Select **Chained paths** to find ways to produce intermediate reagents. Expand a row for a raw shopping list, ordered craft and disenchant steps, professions, and the final sale. The planner keeps a direct-purchase route for comparison and adds an intermediate route when it reduces the purchase cost or supplies missing stock. Repeated uses of the same reagent share the checked stock. Whole recipe batches and reusable surplus are counted within one final run.

The planner looks up to four intermediate sourcing levels deep. At each level it compares direct purchase with up to eight producers ranked by estimated unit cost, with up to 160 producer evaluations per final reagent. This bounds processing time on large markets and can miss other combinations. Disenchant steps use average yields. Extra crafts may be needed to finish an individual order. Expected materials reused later in the path are consumed once, and unused byproducts receive no sale credit. Batch quantities repeat the displayed plan. Price simulations vary reagent prices and the final craft’s output. Intermediate crafts follow the displayed run counts and disenchant materials use expected yields.

**Profession plans** shows the highest projected margin per craft for each profession matching the filters. Selecting **Highest gold per hour** ranks the profession plans by repeatable hourly profit. Enter your expected training and pattern spending in gold to calculate the number of crafts needed to earn it back at that margin. This calculation assumes the same prices and enough stock and buyers. The planner prefers a character who already qualifies, then a character who can train without dropping a primary profession. If slots are full it identifies the alt option and what switching on the closest character would entail. A tradeable craft can go to a separate enchanter. A bound output needs both skills on its crafter.

## Connect your characters and check stock

Install or update the bundled add-on on the gaming PC. For the default Mac path, run this from the scanner folder.

```sh
python3 client/sync.py install --wow-dir "/Applications/World of Warcraft/_forever_"
```

On Windows, use PowerShell and your actual game location.

```powershell
$game = 'C:\Program Files (x86)\World of Warcraft\_forever_'
py -3 client/sync.py install --wow-dir "$game"
py -3 start.py client --wow-dir "$game" --server https://auction.example.com
```

1. Enable **WoW Auction Sync**. On each main or alt, run `/wamsync roster` and `/reload`. Include characters with empty profession slots. If prompted, expand the sections in the Skills pane and run the command again.
2. Open each character’s own profession window, run `/wamsync recipes`, then `/reload`. This identifies ready-to-craft recipes and refines the catalog with in-game data.
3. At a faction capital auction house, run `/wamsync full`. Wait for completion, then `/reload`. When the watcher reports a queue, reload to load it, open the auction house, run `/wamsync scan`, wait for completion and reload to export the results.

The gaming PC uploader includes the add-on exports in the next database update and retrieves the scan queue in scanner base URL mode when the add-on is installed. For an existing portable bundle, use `python3 client/sync.py sync --bundle scan.json.gz --server URL` with the server token in the environment.

## Simulate auction house reagent prices

In **Market prices**, expand a reagent and select **Simulate unit price**. In **Professions**, expand a craft, set its batch size and mailing options, and select **Simulate craft batch**. The simulation opens with the prices shown in that report. Reopen it after a refresh to use newer quotes.

Choose a standard deviation and a trial count, then click **Run simulation**. The defaults are 10% of each unit quote and 5,000 trials. The spread is your assumption about price variability. Each trial draws independently from a normal distribution centered on each auction quote and redraws negative prices. At high volatility this raises the simulated mean above the quote. The report shows the mean, median, 5th–95th percentile range, and distribution of simulated outcomes.

For a craft, set **Min. pieces per craft** and **Max. pieces per craft**. The simulator samples a whole number independently for every final craft in every trial, with equal odds across the range. Equal bounds give a fixed output. The add-on exports the recipe’s in-game limits when available. Reinstall the add-on on the gaming PC, open the profession, run `/wamsync recipes`, then `/reload` to send them. Heavy Dynamite starts with its **1–5 pieces per craft** range. Three is its bundled planning quantity. The simulator assumes equal odds because its inputs provide bounds without probabilities. You can override the simulation bounds per recipe in the current tab.

One sampled price per reagent applies to the whole batch. For each trial the simulator values the actual number of pieces at the route's unit sale value, including auction deductions where applicable. It also adjusts return-mail stacks and the time for disenchanting the final pieces. The results show the batch output range, profit range, chance of positive profit and mean batch gold/hour when the necessary prices and timing are available. Supply limits and disenchant material averages follow the displayed plan. The route table retains its planning quantity.

## Verify the build

```sh
cargo test --locked
cargo build --locked
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s client -v
node tests/price-simulation.cjs
lua addon/tests/scanner.lua
cargo build --release --locked
```

The network integration test uses a temporary data directory and an ephemeral loopback port. It skips when the environment forbids opening a listener. `pandoc-lua` can also run the Lua fixture. Run `cargo test --locked live_forever_market -- --ignored` for a live public-feed check. The optional dashboard interaction fixture uses Node and jsdom 16.7, and runs with `node tests/dashboard.cjs` when jsdom is available.

See `wow-auction-monitor-rebuild-guide.md` for the API, configuration, wire format, pricing formulas and player workflow. Its original release checksum and test counts describe the reference release. This source package is an independent rebuild.

# wow-auction
