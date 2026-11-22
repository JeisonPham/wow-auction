# WoW Auction Monitor

A local auction scanner and market dashboard for WoW Forever. The scanner evaluates 2,051 catalog recipes across 14 professions and class skill lines, including recipes your characters have never learned. The default market is **Forever-US / Normal-Alliance**.

If your server is already running, go to [install or update the gaming PC add-on](#connect-your-characters-and-check-stock). If the uploader says **No saved database**, see [saved database and upload troubleshooting](#saved-database-and-upload-troubleshooting).

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

From the project folder with Docker running, initialize the server token on first use and start the dashboard.

```sh
python3 start.py --init-only
docker compose up -d --build --wait
```

On Windows, use `py -3 start.py --init-only`. Initialization finishes silently and creates `.env` beside `start.py` if the file is missing. Use its `WOW_UPLOAD_TOKEN` value at the gaming PC's bearer-token prompt. For subsequent server updates, run just the Compose command. The `--wait` flag makes the command return after the dashboard passes its health check.

Open **http://127.0.0.1:8765/**. For a local upload test, use **http://127.0.0.1:8765/api/scans** as the client's upload URL. Run `docker compose logs -f dashboard` to follow the logs, or `docker compose down` to stop the scanner and keep its data.

### Host on a domain

To host the included API and dashboard yourself, run `python3 start.py server` on the server with Docker running. Route your domain’s HTTPS traffic to the scanner on host loopback port 8765. The first launch creates a private `.env` containing `WOW_UPLOAD_TOKEN`. Keep the existing Compose project name to reuse the `dashboard-data` volume. The server retains the last accepted upload across restarts. On the dashboard, **Last upload** shows receipt time and **Estimate age** shows price freshness.

Set `WOW_PORT` in the server's `.env` to change the host port. The server also fetches public TSM estimates. Set `WOW_TSM_PUBLIC=0` to use only uploaded estimates. A native server uses `python3 start.py server --native` with Rust and curl installed and stores data in `local-data/`.

### Optional Docker-hosted TSM Desktop

For an all-in-one installation, run `python3 start.py server --desktop` on the machine with the game files. Supply `--wow-dir` for a custom installation. Open **http://127.0.0.1:5800/**, sign in to TSM, select `/wow` and enable AppHelper. This optional image bundles the Linux amd64 desktop app, its browser and the watcher. It preserves the desktop profile in `tsm-profile`. Only the Forever `Interface/AddOns` mount is writable in the game directory. Set `WOW_TSM_PORT` to change the desktop port. [Browser sandbox profile sources](container/MOBY-LICENSE.txt)

## Browse crafts and plan professions

Open **Opportunities** or **Professions** to see all crafts the planner evaluates for your market, including unlearned recipes and crafts with insufficient reagent stock. **Profit per run** defaults to **All margins**. Choose **Profitable** for gains above zero, **Break-even** for zero profit, **Loss** for negative profit, or **Unknown** when the planner lacks a cost or sale value. Check the **Stock** column separately for reagent availability.

Pick **Craft → vendor**, **Craft → disenchant**, or **Craft → auction** in the route filter. The table shows the cost and profit per recipe run. Expand a row for reagents, quantities, qualifications, price sources, cooldowns when known and batch calculations. Eligible direct buy-to-vendor and buy-to-disenchant routes are also supported.

**Max. character level** includes routes at or below your limit. It checks profession ranks, recipe and pattern learning levels, and disenchanting across every step. If a bind-on-pickup pattern comes only from quests in the catalog, the crafter must also meet the minimum level to accept a qualifying quest. Expand a route to see the pattern and its recorded level requirements. A plain buy-to-vendor route is available at level 1. Routes with an unknown level are hidden while a limit is set. Clear the field to see them again.

Choose **Highest gold per hour** to compare repeatable routes. **Time / run** counts every intermediate craft, one final recipe cast and one disenchant per piece destroyed. A recipe that produces several pieces takes one cast. **Repeat gold/hour** divides net profit by the time until the same production schedule can start again. Set **Batch size (runs)** in Opportunities or Professions to compare 1–10,000 repetitions of each route. With multiple runs, the **Batch estimate** column shows net profit, total time, gold per hour and known stock shortages. The two views share this setting and remember it on reload in the same tab. In an expanded row, **Batch size override** changes just that route in the current view. Clear the override to follow the shared setting. Shopping quantities, postage, production steps, copied instructions and craft simulations use the effective batch size. Batch timing starts with cooldowns ready, includes waits between casts of the same recipe, and ends when the last action finishes. Cooldowns can overlap other work. Travel, switching characters, buying, mailing and selling time are excluded. Shared cooldown groups, character speed bonuses and extra disenchant rolls are outside this estimate. An unrecorded cast uses a flagged three-second estimate. Buy-to-vendor flips have no timed production step.

Vendor routes use the output’s vendor sell price. Disenchant routes use the expected sale value of the materials from all crafted outputs. Both auction exits allow for a 5% auction cut and a 15% sale reserve. Prices are in copper internally. Missing input prices leave the margin unknown. A listed auction price is an estimate of resale value, and disenchant drops vary per roll. See [catalog sources and coverage](src/data/SOURCES.md).

Select **Chained paths** to find ways to produce intermediate reagents. Expand a row for a raw shopping list, ordered craft and disenchant steps, professions, and the final sale. The planner keeps a direct-purchase route for comparison and adds an intermediate route when it reduces the purchase cost or supplies missing stock. Repeated uses of the same reagent share the checked stock. Whole recipe batches and reusable surplus are counted within one final run.

The planner looks up to four intermediate sourcing levels deep. At each level it compares direct purchase with up to eight producers ranked by estimated unit cost, with up to 160 producer evaluations per final reagent. This bounds processing time on large markets and can miss other combinations. Disenchant steps use average yields. Extra crafts may be needed to finish an individual order. Expected materials reused later in the path are consumed once, and unused byproducts receive no sale credit. Batch quantities repeat the displayed plan. Price simulations vary reagent prices and the final craft’s output. Intermediate crafts follow the displayed run counts and disenchant materials use expected yields.

**Profession plans** shows the highest projected margin per craft for each profession matching the filters. Selecting **Highest gold per hour** ranks the profession plans by repeatable hourly profit. Enter your expected training and pattern spending in gold to calculate the number of crafts needed to earn it back at that margin. This calculation assumes the same prices and enough stock and buyers. The planner prefers a character who already qualifies, then a character who can train without dropping a primary profession. If slots are full it identifies the alt option and what switching on the closest character would entail. A tradeable craft can go to a separate enchanter. A bound output needs both skills on its crafter.

## Connect your characters and check stock

### Install or update the gaming PC add-on

Extract the current scanner package on the gaming PC. Run the commands below from that folder, using the path to your active `_forever_` installation. The installer copies **WoW Auction Sync** into `Interface/AddOns` and preserves the existing scan queue. If an older uploader is running, stop it with `Ctrl+C` and restart it from the updated folder.

On macOS, these commands use the default game path. Replace the example URL with your scanner's domain.

```sh
python3 client/sync.py install --wow-dir "/Applications/World of Warcraft/_forever_"
python3 start.py client --wow-dir "/Applications/World of Warcraft/_forever_" --server https://auction.example.com
```

On Windows, use PowerShell and replace the game path and server URL with yours.

```powershell
$game = 'C:\Program Files (x86)\World of Warcraft\_forever_'
py -3 client/sync.py install --wow-dir "$game"
py -3 start.py client --wow-dir "$game" --server https://auction.example.com
```

These commands use the bundled server's base URL so the PC can download targeted scan queues. If your host supplied a full upload endpoint instead, use the [upload-only client command](#upload-from-your-gaming-pc-to-a-hosted-rest-api).

### Save your first scan

1. Enable **WoW Auction Sync** in WoW. If you updated it while logged in, type `/reload` to load the new code.
2. On each main or alt, run `/wamsync roster`, including characters with free profession slots. If prompted, expand the Skills pane sections and repeat. Open each character's own profession windows and run `/wamsync recipes` in each one. Type `/reload` to write those records to disk.
3. At your faction capital's auction house, run `/wamsync full` and keep the auction house open. When chat says **Scan complete. Type /reload to save.**, type `/reload`. The running PC uploader checks for changes every 15 seconds by default. Check its terminal for the upload receipt and the dashboard's **Last upload** time for confirmation.
4. For a targeted scan, wait for the uploader to report **Updated queue** with a positive item count. Type `/reload` to load the queue, open the auction house, run `/wamsync scan`, and type `/reload` after completion to export the results.

The in-game status bar shows elapsed time. The add-on posts progress to chat **every 10 seconds** while a scan is active. A full scan first waits for listings, then counts rows read. A targeted scan counts items checked and shows the current item ID. Use `/wamsync status` for an immediate update or the last outcome in the current session. Closing the auction house, running `/wamsync cancel`, or reaching a timeout discards the unfinished scan and keeps the previous completed observations.

### Saved database and upload troubleshooting

WoW writes the add-on's account data on `/reload` or logout. Look in the active WoW installation on the gaming PC.

```text
_forever_/WTF/Account/<account>/SavedVariables/WowAuctionSync.lua
```

| What you see | What to check |
| --- | --- |
| **No saved database in WowAuctionSync.lua** | Update the add-on and restart the uploader from the same extracted package. In WoW, run `/reload`, `/wamsync roster`, then `/reload` again. Check the file above for your active account. The updated uploader can skip an empty account file when another account or TSM has data for the selected market. |
| **Waiting for in-game data** | Run `/wamsync status` and compare its region and market with the uploader's settings. Confirm that `--wow-dir` points to the installation you play. After a roster capture or completed scan, use `/reload` and check the file path printed by the uploader. |
| **Waiting for TSM Desktop AppHelper prices** | Open TSM Desktop and check that AppHelper is enabled and has synced the selected Forever market. The `start.py client` watcher needs a populated price book for that market before uploading. |
| **Scan complete** in chat but no new checked prices on the dashboard | Type `/reload` and keep the PC uploader running. After an upload receipt, open **Market prices** and check **Checked average** and **Checked units** for a scanned item. |

For an existing portable bundle, use `python3 client/sync.py sync --bundle scan.json.gz --server URL` with the server token in the environment.

## Simulate auction house reagent prices

In **Market prices**, expand a reagent and select **Simulate unit price**. In **Professions**, expand a craft, set its batch size and mailing options, and select **Simulate craft batch**. The simulation opens with the prices shown in that report. Reopen it after a refresh to use newer quotes.

Choose a standard deviation and a trial count, then click **Run simulation**. The defaults are 10% of each unit quote and 5,000 trials. The spread is your assumption about price variability. Each trial draws independently from a normal distribution centered on each auction quote and redraws negative prices. At high volatility this raises the simulated mean above the quote. The report shows the mean, median, 5th–95th percentile range, and distribution of simulated outcomes.

For a craft, set **Min. pieces per craft** and **Max. pieces per craft**. The simulator samples a whole number independently for every final craft in every trial, with equal odds across the range. Equal bounds give a fixed output. The add-on exports the recipe’s in-game limits when available. Reinstall the add-on on the gaming PC, open the profession, run `/wamsync recipes`, then `/reload` to send them. Heavy Dynamite starts with its **1–5 pieces per craft** range. Three is its bundled planning quantity. The simulator assumes equal odds because its inputs provide bounds without probabilities. You can override the simulation bounds per recipe in the current tab.

One sampled price per reagent applies to the whole batch. For each trial the simulator values the actual number of pieces at the route's unit sale value, including auction deductions where applicable. It also adjusts return-mail stacks and the time for disenchanting the final pieces. The results show the batch output range, profit range, chance of positive profit and mean batch gold/hour when the necessary prices and timing are available. Supply limits and disenchant material averages follow the displayed plan. The route table retains its planning quantity.

### Size a craft order with the Kelly criterion

Open **Simulate craft batch** on a route with a sale value, enter your available **Starting gold for Kelly sizing**, and run the simulation. **Suggested spend at current quotes** shows the cost of the recommended whole batches and how much gold you would keep. **Full Kelly target** shows the percentage and gold amount before rounding and stock limits. A simulation batch of one lets you size the order in individual crafts.

For each trial the scanner divides its net profit by its cost to get the return per copper spent, including postage. It picks the fraction `f` from 0 to 1 that maximizes the average of `log(1 + f × return)`. Keeping all your gold is an option. If increasing the stake offers no expected log growth, the suggested spend is zero. A trial with zero cost has no percentage return, so sizing is unavailable for that simulation.

For the whole-batch recommendation, the scanner compares the feasible batch counts immediately below and above the Kelly target. It uses current reagent quotes, reserves return postage for the maximum craft yield and caps purchases at the gold entered and known reagent stock. Unchecked stock is assumed available. The sizing model scales the selected batch's percentage returns across the order. Changing the simulation batch size changes the number of independent craft yields in each sampled return. Each route is sized on its own against the gold entered.

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
