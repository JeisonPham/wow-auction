# WoW Auction Monitor

A local auction scanner and market dashboard for WoW Forever. The scanner evaluates 2,051 catalog recipes across 14 professions and class skill lines, including recipes your characters have never learned. The default market is **Forever-US / Normal-Alliance**.

## Upload from your gaming PC to a hosted REST API

**WoW Auction Sync** scans the auction house and shows opportunities in-game. To send a scan to your online database, type `/reload` after the scan finishes. WoW writes the results to disk, and the Python uploader on your gaming PC sends them to your server over HTTPS. The client connects to the scanner’s REST API. The bundled server handles storage and displays the latest accepted snapshot on your dashboard.

### Connect to your server

1. Get the **server URL**, **upload token**, **region**, and **market** from your host. The upload token is the password the API uses to accept uploads. If you host the bundled scanner yourself, use the value of `WOW_UPLOAD_TOKEN` from the server’s `.env` beside `start.py`. For a new server, follow [Host on a domain](#host-on-a-domain).
2. On the gaming PC, extract the **full scanner source package** and open the folder containing `start.py`. The launcher runs with Python 3. The add-on reads auction listings in WoW, and the client uploads those saved listings, stack sizes and buyouts as soon as you reload or log out. TSM Desktop is optional.
3. Create a plain-text file named **`client.env`** beside `start.py` on the gaming PC. For the bundled scanner, use the following example. Replace `auction.example.com` with your domain and use the same region and market as your server.

```dotenv
WOW_SERVER_URL=https://auction.example.com
WOW_REGION=Forever-US
WOW_MARKET=Normal-Alliance
```

Use **one** URL setting in `client.env`, according to what your host gave you.

| What your host gave you | URL setting | What the uploader does |
| --- | --- | --- |
| The base URL of the bundled scanner | `WOW_SERVER_URL=https://auction.example.com` | Uploads to `/api/scans` and downloads the server’s targeted scan queue. |
| An exact upload endpoint, including its path | `WOW_UPLOAD_URL=https://auction.example.com/api/scans` | Posts to that exact address. Use the full path your host supplied. |

### Install or update the gaming PC add-on

From the folder containing `start.py`, run the command for your gaming PC. When prompted for **API bearer token**, paste just the token value. For unattended use, you can set `WOW_UPLOAD_TOKEN` in your private `client.env` or set `WOW_UPLOAD_TOKEN_FILE` to the path of a file containing the token.

| Platform | Install the add-on and keep uploading | Install the add-on for offline play |
| --- | --- | --- |
| Windows PowerShell | `py -3 start.py client` | `py -3 start.py install` |
| macOS or Linux | `python3 start.py client` | `python3 start.py install` |

Client mode installs or updates **WoW Auction Sync** before starting the uploader. The terminal prints the add-on folder. It preserves your scan queue and saved scans. Leave the terminal running while you play. For future updates, extract the new package and restart the uploader with the same command. Use `Ctrl+C` to stop it.

For a custom WoW installation, set `WOW_GAME_DIR` in `client.env` or pass `--wow-dir` with the game folder or its parent. You can also supply the URL directly on the command line. This Windows example uses a custom game location.

```powershell
py -3 start.py client --wow-dir "D:\Games\World of Warcraft" --server "https://auction.example.com"
```

For a host that gave you an exact endpoint, use `--upload-url "https://auction.example.com/api/scans"`. Add `--once` to send the current saved snapshot and exit.

### Save your first scan

1. Start WoW, enable **WoW Auction Sync** in the AddOns list, and visit your faction capital’s auction house. If you installed an update while logged in, type `/reload` to load it. Open the auction house and type `/wamsync opportunities`. The panel uses a recent full scan or requests one, then automatically searches for missing route prices across every page. Keep the auction house open while **Checking route prices** runs.
2. Watch **routes priced** in the panel. When chat says **Scan complete. Type /reload to save.**, type `/reload`. Results appear in-game before this step. Reloading writes the scan to `WowAuctionSync.lua` so the uploader can read it.
3. Check the uploader terminal. It polls for file changes every 15 seconds by default. With the bundled server, **accepted revision** means the server saved the upload. **unchanged revision** means the same snapshot was already there. An upload-only host may return **uploaded revision**.
4. Open your bundled dashboard at `https://auction.example.com/`. Check **Last upload** for the receipt time, then open **Market prices**, find an item you scanned, and check its **Last check**, **Checked units**, and **Checked average**. For a second confirmation, open `https://auction.example.com/api/status` and match `upload_revision` to the number in your terminal. For a custom upload-only API, use its receipt and the verification view your host provides.

**During play**, use **Recheck route** before buying or **Follow** to recheck the selected route about once a minute while the panel and auction house stay open. Type `/reload` after a completed recheck when you want the web dashboard to receive it. [In-game opportunity controls](#find-opportunities-at-the-auction-house)

### Connect the Blizzard Auction House API

1. Sign in to Battle.net, choose **Create New Client**, and enter a client name and intended use. Open **Manage Client** to copy the **Client ID** and **Client Secret**. The scanner uses the server-to-server client credentials flow. [Battle.net Developer Portal – API Access](https://develop.battle.net/access/clients)
2. On the **server**, run `python3 start.py --init-only` in the project folder. This adds the two fields to the private `.env` beside `start.py`, including on existing installations. Fill them in with your own values. Leaving both blank disables Blizzard pulls.

   ```dotenv
   WOW_BLIZZARD_CLIENT_ID=your_client_id
   WOW_BLIZZARD_CLIENT_SECRET=your_client_secret
   ```

3. Run `docker compose up -d --build --wait`. On the dashboard, **Blizzard Auction House** shows the item count, latest snapshot time, last check and any error. The same information is available under `blizzard` in `/api/status`. A successful pull needs only the server and the two credentials.
4. Open **Market prices** to see which source won for an item. The server checks Blizzard on startup and hourly, using the existing `WOW_REGION` and `WOW_MARKET`. Supported Forever markets are US, EU, KR and TW with Normal, PvP, Roleplay or Roleplay PvP rulesets and Alliance, Horde or Blackwater houses. For example, `Forever-US` and `Normal-Alliance` select ruleset 2 and house 111. [Forever auction endpoints](https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334) · [Ruleset and faction house IDs](https://hyjal.cc/auctions/us/pvp/alliance/item/279960/lodestone)

Blizzard’s planning quote is the **lowest listed buyout per unit** for the base item. The scanner divides a stack buyout by its quantity and reads the unit price directly for commodities. It skips bid-only listings and modified variants. Each quote uses the corresponding snapshot’s `Last-Modified` time. Unchanged snapshots, empty houses and failed requests preserve earlier quotes with their original timestamps. **Current listings** and TSM shopping ceilings continue to use in-game scans for purchasable quantities.

### Import Booty Bay Broker prices

The **server** can fetch Booty Bay Broker prices while your gaming PC is offline. The **gaming client** reads listings at the in-game auction house. Open **Market prices** to see both observations. **Latest available prices** compares the observation times from your scan, Blizzard, TSM and Broker for each item in the matching market. **Current listings** and TSM shopping ceilings use your in-game stack sizes, quantities and buyouts.

1. On the **server**, open the `.env` beside `compose.yaml`. Set `WOW_BROKER_URLS=auto` to build the watchlist from the bundled recipe catalog. This covers auctionable reagents, crafted outputs and disenchant materials, including unlearned recipes. The server checks shared reagents first and queries each distinct item once per pass. Booty Bay Broker requires prior written permission for automated collection with either automatic selection or a manual watchlist. [Booty Bay Broker terms, section 4](https://bootybaybroker.com/terms)

```dotenv
WOW_BROKER_URLS=auto
WOW_BROKER_DELAY_SECONDS=5
```

2. In the server project folder, run `docker compose up -d --build --wait`. Prices appear as individual pages complete. At the default five-second delay a catalog pass takes at least 2 hours 48 minutes, plus request time. The next pass starts an hour after completion. The server reads **Lowest buyout** and **Last seen** for its configured region, ruleset and faction. Missing listings leave previous observations at their original timestamps. A rate limit delays further requests, and an access denial pauses fetching until restart.
3. On the dashboard, **Booty Bay Broker prices** shows fresh coverage, the last server pull and any error. Use `docker compose logs -f dashboard` for the pull log. Expand an item to see its Broker buyout and observation time. A scan that finds zero stock updates the checked quantity. The latest recorded unit price remains available for planning.
4. On the **gaming PC**, run `py -3 start.py client` (macOS or Linux: `python3 start.py client`), scan at the auction house and type `/reload` to upload. The client uses the prices observed in WoW and works without TSM Desktop. To also upload existing TSM AppHelper estimates for planning, run `start.py client --include-tsm` with your usual Python command.

To track specific items, set `WOW_BROKER_URLS` to a space-separated list of English WoW Forever item-page URLs instead of `auto`. An empty setting disables Broker requests. For a one-time import of saved pages, `python3 start.py broker --html "Runecloth.html" --preview` shows the parsed copper price and timestamp locally. Omit `--preview` and supply the bundled server URL and upload token to send it. This manual uploader accepts the existing `client.env` settings. Older observations cannot overwrite newer prices. [Example item page](https://bootybaybroker.com/forever/item/14047/runecloth)

### Custom endpoint contract

The client sends an HTTPS POST to the exact URL with `Authorization: Bearer <token>` and `Content-Type: application/gzip`. The body is gzip-compressed JSON with `version`, `revision`, `region`, `market`, `snapshot`, and `targeted`. On success the API can return an empty 2xx response, such as `204 No Content`, or a JSON object with the matching numeric `revision` and an optional `status`. Return an HTTP error if the upload fails. The bundled scanner implements this contract at `POST /api/scans`. [Snapshot fields](wow-auction-monitor-rebuild-guide.md)

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

On the server, extract the project and run the two Docker Compose setup commands above. Initialization creates a private `.env` next to `start.py`. If you use a different region or market, set `WOW_REGION` and `WOW_MARKET` in that file before starting Compose. You can also start the server with `python3 start.py server`.

Point your domain’s DNS at the server. On that host, configure your HTTPS reverse proxy to forward the domain’s paths, including `/api/`, to `http://127.0.0.1:8765` and pass through the `Authorization` header. From the gaming PC, open `https://auction.example.com/healthz` using your own domain. The bundled service responds with `ok`. Give the gaming PC that domain’s base URL and the server’s upload token.

The bundled scanner stores the accepted snapshot at `/data/scan-upload.json.gz` inside the `dashboard-data` Docker volume and restores it after a restart. Keep the same Compose project name when updating to reuse the volume. **Last upload** shows the server receipt time. **Estimate age** tracks the TSM estimate timestamp.

Set `WOW_PORT` in the server's `.env` to change the host port. The server also fetches public TSM estimates. Set `WOW_TSM_PUBLIC=0` to disable the public TSM feed. A native server uses `python3 start.py server --native` with Rust and curl installed and stores data in `local-data/`.

### Optional Docker-hosted TSM Desktop

For an all-in-one installation, run `python3 start.py server --desktop` on the machine with the game files. Supply `--wow-dir` for a custom installation. Open **http://127.0.0.1:5800/**, sign in to TSM, select `/wow` and enable AppHelper. This optional image bundles the Linux amd64 desktop app, its browser and the watcher. It preserves the desktop profile in `tsm-profile`. Only the Forever `Interface/AddOns` mount is writable in the game directory. Set `WOW_TSM_PORT` to change the desktop port. [Browser sandbox profile sources](container/MOBY-LICENSE.txt)

## Browse crafts and plan professions

### Find opportunities at the auction house

On the gaming PC, install the updated **WoW Auction Sync** add-on using the [installation steps](#install-or-update-the-gaming-pc-add-on). At your faction capital auction house, click **Opportunities** or type `/wamsync opportunities`. It requests a full scan when you open it without a recent full snapshot. The results appear in-game as soon as the scan and calculations finish. The add-on can price routes during the same session without TSM Desktop, the uploader, or a UI reload.

- **Scan all** reads the auction house and evaluates eligible recipes across the bundled catalog, including unlearned crafts. It checks craft → vendor, craft → auction, craft → disenchant, buy → vendor and buy → disenchant. The list includes losses and unpriced crafts. Select **All margins** to toggle profitable-only results. Search by name, profession, route or `chained`.
- After the bulk scan, **Checking route prices** searches distinct items missing usable prices, including recipe inputs, outputs and disenchant materials. Items shared by more recipes go first. If the bulk request times out, the add-on keeps the previous snapshot and starts those searches automatically. The panel updates during the checks. **X of Y routes priced** counts routes with both a batch cost and proceeds under your current filters. A confirmed sellout or insufficient stock can still leave a route unpriced.
- **Recheck route** searches the current listings for that route’s raw inputs and auction sale outputs. **Recheck page** checks the distinct items behind the eight visible rows. Use these between full scans. WoW throttles full scans and individual searches. Progress is reported every ten seconds while scanning. [Auction house replication](https://warcraft.wiki.gg/wiki/API_C_AuctionHouse.ReplicateItems)
- **Follow** requests a recheck of the selected route about once a minute while the panel and auction house are open. The add-on finishes each scan before starting another. Closing either window or using `/wamsync cancel` stops following. New checks replace older prices for just those items, including an explicit empty result when the auctions sold out. A quote expires after 15 minutes. The selected priced route shows the age of its oldest auction quote.
- Set **Runs** for the batch size and **Min. profit (c)** for the copper to reserve across the batch. Select a route to see purchase quantities, production steps, projected profit, repeat gold/hour where applicable, and capped searches you can copy into TSM Shopping. Press Enter to apply a number. Confirm each purchase in-game and keep within the displayed stack quantity.

The in-game planner compares whole-stack costs with known vendor prices. It compares a direct recipe with locally priced intermediate crafts and disenchant steps up to three levels deep. For each reagent it considers the lowest unit-cost producer from the previous level and prices the combined shopping list against available stock. Other combinations can be cheaper. Auction exits use the lowest scanned ask, a 5% auction cut and a 15% sale reserve. Craft output and disenchant materials use planning quantities and expected yields. In-game margins cover purchases for the selected batch and assume no mailing charges.

To publish the new prices to the web dashboard, type `/reload` after scanning and keep the updated PC uploader running. The uploader preserves each item’s search time, including when it groups a long sweep into the API’s 128-capture limit. Older uploads use the timestamps they recorded.

### Use the web dashboard

Open **Opportunities** or **Professions** to see all crafts the planner evaluates for your market, including unlearned recipes and crafts with insufficient reagent stock. **Profit per run** defaults to **All margins**. Choose **Profitable** for gains above zero, **Break-even** for zero profit, **Loss** for negative profit, or **Unknown** when the planner lacks a cost or sale value. Check the **Stock** column separately for reagent availability.

**Price basis** defaults to **Latest available prices**. For each item, the server compares your full and targeted scans, Blizzard Auction House, TSM (public DBRecent and any uploaded Desktop AppHelper data), and Booty Bay Broker for the same market. The newest positive unit price wins, using the time the source observed it. At equal times, a targeted check wins, followed by a full scan, Blizzard, TSM Desktop, public TSM and Broker. A scan with zero stock updates availability and keeps the last known price for planning. Older prices retain their timestamps and show **Stale** after the server's freshness window (six hours by default). Expand a route to see the price source and age for each auction reagent.

Pick **Craft → vendor**, **Craft → disenchant**, or **Craft → auction** in the route filter. The table shows the cost and profit per recipe run. Expand a row for reagents, quantities, qualifications, price sources, cooldowns when known and batch calculations. Eligible direct buy-to-vendor and buy-to-disenchant routes are also supported.

### Buy reagents at a profitable price in TSM

1. Update the server, PC uploader and **WoW Auction Sync** add-on. Follow the [add-on installation steps](#install-or-update-the-gaming-pc-add-on), restart the uploader and type `/reload` to load the updated add-on. At the capital auction house run `/wamsync full`. After **Scan complete**, type `/reload` again to upload the listings. A targeted `/wamsync scan` also works when the queue covers the necessary items.
2. Open **Opportunities** or **Professions**, set **Price basis** to **Current listings** and set **Batch size (runs)**. The profit filter, rankings and costs use that batch. The scanner counts the cash needed for whole stacks, compares vendor inputs when available, and includes the selected postage. For auction sales it uses the lowest scanned unit ask after the auction cut and sale reserve. Disenchanting uses expected drops and variable-yield recipes use their planning quantity.
3. Expand the route. Under **TSM shopping ceilings**, set **Minimum batch profit (copper)**. The default reserves one copper for the entire batch. For example, a 1g vendor payout with 20s of fixed costs and a 10s profit target leaves 70s for reagents. If the only purchase is 10 ore, the ceiling is 7s per ore. With multiple reagents, the dashboard splits the same budget in proportion to the scanned cost of each purchase and rounds each ceiling down.
4. Use **Copy search** beside each reagent and paste it in TSM's Shopping search at the auction house. It matches the item name, applies the maximum unit price and includes the shopping quantity. Check the stack size before confirming each purchase. Buying extra units can exceed the batch budget. Refresh the scan and copy new searches if prices, quantities, or the target change. [TSM Shopping search filters](https://support.tradeskillmaster.com/addon/how-do-i-filter-items-in-my-groups-or-the-base-group)

**Current listings** requires auction quotes from the last 15 minutes, or sooner if the server expires quotes earlier. Missing listing detail, expired quotes or too little stock give an **Unknown** batch margin. When the scanned batch falls short of the target, the dashboard can still give a lower buy ceiling to shop for. A copied search keeps its numeric ceiling until you replace it. For large batches with many different stack sizes, the scanner estimates a purchasable combination by unit price and compares finishing stacks. Projected auction proceeds depend on finding a buyer at the modeled sale price.

Buying ceilings are available under **Current listings**.

**Max. character level** includes routes at or below your limit. It checks profession ranks, recipe and pattern learning levels, and disenchanting across every step. If a bind-on-pickup pattern comes only from quests in the catalog, the crafter must also meet the minimum level to accept a qualifying quest. Expand a route to see the pattern and its recorded level requirements. A plain buy-to-vendor route is available at level 1. Routes with an unknown level are hidden while a limit is set. Clear the field to see them again.

Choose **Highest gold per hour** to compare repeatable routes. **Time / run** counts every intermediate craft, one final recipe cast and one disenchant per piece destroyed. A recipe that produces several pieces takes one cast. **Repeat gold/hour** divides net profit by the time until the same production schedule can start again. Set **Batch size (runs)** in Opportunities or Professions to compare 1–10,000 repetitions of each route. With multiple runs, the **Batch estimate** column shows net profit, total time, gold per hour and known stock shortages. The two views share this setting and remember it on reload in the same tab. In an expanded row, **Batch size override** changes just that route in the current view. Clear the override to follow the shared setting. Shopping quantities, postage, production steps, copied instructions and craft simulations use the effective batch size. Batch timing starts with cooldowns ready, includes waits between casts of the same recipe, and ends when the last action finishes. Cooldowns can overlap other work. Travel, switching characters, buying, mailing and selling time are excluded. Shared cooldown groups, character speed bonuses and extra disenchant rolls are outside this estimate. An unrecorded cast uses a flagged three-second estimate. Buy-to-vendor flips have no timed production step.

Vendor routes use the output’s vendor sell price. Disenchant routes use the expected sale value of the materials from all crafted outputs. Both auction exits allow for a 5% auction cut and a 15% sale reserve. Prices are in copper internally. Missing input prices leave the margin unknown. A listed auction price is an estimate of resale value, and disenchant drops vary per roll. See [catalog sources and coverage](src/data/SOURCES.md).

Select **Chained paths** to find ways to produce intermediate reagents. Expand a row for a raw shopping list, ordered craft and disenchant steps, professions, and the final sale. The planner keeps a direct-purchase route for comparison and adds an intermediate route when it reduces the purchase cost or supplies missing stock. Repeated uses of the same reagent share the checked stock. Whole recipe batches and reusable surplus are counted within one final run.

The planner looks up to four intermediate sourcing levels deep. At each level it compares direct purchase with up to eight producers ranked by estimated unit cost, with up to 160 producer evaluations per final reagent. This bounds processing time on large markets and can miss other combinations. Disenchant steps use average yields. Extra crafts may be needed to finish an individual order. Expected materials reused later in the path are consumed once, and unused byproducts receive no sale credit. Batch quantities repeat the displayed plan. Price simulations vary reagent prices and the final craft’s output. Intermediate crafts follow the displayed run counts and disenchant materials use expected yields.

**Profession plans** shows the highest projected margin per craft for each profession matching the filters. Selecting **Highest gold per hour** ranks the profession plans by repeatable hourly profit. Enter your expected training and pattern spending in gold to calculate the number of crafts needed to earn it back at that margin. This calculation assumes the same prices and enough stock and buyers. The planner prefers a character who already qualifies, then a character who can train without dropping a primary profession. If slots are full it identifies the alt option and what switching on the closest character would entail. A tradeable craft can go to a separate enchanter. A bound output needs both skills on its crafter.

## Connect your characters and check stock

After the [first upload](#save-your-first-scan), add character data if you want profession recommendations.

- On each main or alt, run `/wamsync roster`, including characters with free profession slots. If prompted, expand the Skills pane sections and repeat. Open each character’s own profession windows and run `/wamsync recipes` in each one. Type `/reload` to write those records for upload.
- To scan the bundled server’s suggested items, use the base URL connection and wait for the uploader to report **Updated queue** with a positive item count. Type `/reload` to load the queue, open the auction house, run `/wamsync scan`, and type `/reload` after completion to export the results. You can also run `/wamsync full` directly at the capital auction house for a full snapshot.

The in-game status bar shows elapsed time. The add-on posts progress to chat **every 10 seconds** while a scan is active. A full scan counts listing rows, then shows progress through any individual route checks. Use `/wamsync status` for an immediate update or the last outcome in the current session. Closing the auction house or using `/wamsync cancel` during automatic route checks keeps completed searches. An item that times out counts as skipped and retains its earlier observation. Cancelling a bulk snapshot or a manual targeted scan keeps the previous completed scan.

### Saved database and upload troubleshooting

WoW writes the add-on's account data on `/reload` or logout. Look in the active WoW installation on the gaming PC.

```text
_forever_/WTF/Account/<account>/SavedVariables/WowAuctionSync.lua
```

| What you see | What to check |
| --- | --- |
| **HTTP 401: invalid bearer token** | Use the value of the host’s upload token at the prompt, without the `WOW_UPLOAD_TOKEN=` prefix or the word `Bearer`. If the uploader uses a token file or an environment variable, check that value and restart the client. |
| **HTTP 404** or an unexpected HTML response | Check the URL setting. Use the domain root with `WOW_SERVER_URL`, or the exact upload path with `WOW_UPLOAD_URL`. On a self-hosted server, verify that the reverse proxy forwards `/api/scans`. |
| **HTTP 422** with a scope mismatch | Compare `WOW_REGION` and `WOW_MARKET` in the PC’s `client.env` with the region and market shown on the server dashboard. |
| **No saved database in WowAuctionSync.lua** | Update the add-on and restart the uploader from the same extracted package. In WoW, run `/reload`, `/wamsync roster`, then `/reload` again. Check the file above for your active account. The uploader can skip an empty account file when another account has data for the selected market. |
| **Waiting for in-game data** | Run `/wamsync status` and compare its region and market with the uploader's settings. Confirm that `--wow-dir` points to the installation you play. After a roster capture or completed scan, use `/reload` and check the file path printed by the uploader. |
| **Waiting for TSM Desktop AppHelper prices** | Update the PC files and restart with `start.py client` to upload saved auction-house scans. If you opted into TSM estimates, confirm that AppHelper has synced the selected market. |
| A route still shows **Unknown** after upload | Choose **Latest available prices**. Expand the route to identify a reagent with **No recorded auction price** or a missing sale value. In **Market prices**, compare **Latest unit price** with **Checked units** for that item. |
| **Scan complete** in chat but no new checked prices on the dashboard | Type `/reload` and keep the PC uploader running. After an upload receipt, open **Market prices** and check **Checked average** and **Checked units** for a scanned item. |

For an existing portable bundle, use `python3 client/sync.py sync --bundle scan.json.gz --server URL` with the server token in the environment.

## Simulate auction house reagent prices

In **Market prices**, expand a reagent and select **Simulate unit price**. In **Professions**, expand a craft, set its batch size and mailing options, and select **Simulate craft batch**. The simulation opens with the prices shown in that report. Reopen it after a refresh to use newer quotes.

Choose a standard deviation and a trial count, then click **Run simulation**. The defaults are 10% of each unit quote and 5,000 trials. The spread is your assumption about price variability. Each trial draws independently from a normal distribution centered on each auction quote and redraws negative prices. At high volatility this raises the simulated mean above the quote. The report shows the mean, median, 5th–95th percentile range, and distribution of simulated outcomes.

For a craft, set **Min. pieces per craft** and **Max. pieces per craft**. The simulator samples a whole number independently for every final craft in every trial, with equal odds across the range. Equal bounds give a fixed output. The add-on exports the recipe’s in-game limits when available. Start the updated client on the gaming PC, reload WoW, open the profession, run `/wamsync recipes`, then `/reload` to send them. Heavy Dynamite starts with its **1–5 pieces per craft** range. Three is its bundled planning quantity. The simulator assumes equal odds because its inputs provide bounds without probabilities. You can override the simulation bounds per recipe in the current tab.

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
node tests/shopping.cjs
lua addon/tests/scanner.lua
lua addon/tests/opportunities.lua
cargo build --release --locked
```

The network integration test uses a temporary data directory and an ephemeral loopback port. It skips when the environment forbids opening a listener. `pandoc-lua` can also run the Lua fixture. Run `cargo test --locked live_forever_market -- --ignored` for a live public-feed check. The optional dashboard interaction fixture uses Node and jsdom 16.7, and runs with `node tests/dashboard.cjs` when jsdom is available.

See `wow-auction-monitor-rebuild-guide.md` for the API, configuration, wire format, pricing formulas and player workflow. Its original release checksum and test counts describe the reference release. This source package is an independent rebuild.
