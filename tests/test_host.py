"""Black-box checks for a real native HTTP server and on-disk restart."""

import gzip
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.token = secrets.token_hex(32)
        self.proc = None
        self.addCleanup(self.stop)
        self.start()

    def start(self, **options):
        env = dict(
            os.environ,
            WOW_BIND="127.0.0.1:0",
            WOW_UPLOAD_TOKEN=self.token,
            WOW_TSM_PUBLIC="0",
            WOW_DATA_DIR=self.temp.name,
            WOW_REGION="Forever-US",
            WOW_MARKET="Normal-Alliance",
            WOW_BROKER_URLS="",
            WOW_BLIZZARD_CLIENT_ID="",
            WOW_BLIZZARD_CLIENT_SECRET="",
        )
        env.update(options)
        env.pop("WOW_UPLOAD_TOKEN_FILE", None)
        self.proc = subprocess.Popen(
            [
                os.environ.get(
                    "WAM_BINARY", str(ROOT / "target/debug/wow-auction-monitor")
                ),
                "serve",
            ],
            env=env,
            stderr=subprocess.PIPE,
            text=True,
        )
        message = self.proc.stderr.readline().strip()
        if "Operation not permitted" in message or "Permission denied" in message:
            self.skipTest("Host environment blocks local listeners: " + message)
        self.assertIn("listening on", message)
        self.url = "http://" + message.split()[-1]

    def stop(self):
        if self.proc:
            self.proc.terminate()
            self.proc.wait(timeout=5)
            self.proc.stderr.close()
            self.proc = None

    def req(self, path, body=None, token=None, method=None, headers=None):
        h = dict(headers or {})
        if token:
            h["Authorization"] = "Bearer " + token
        r = urllib.request.Request(self.url + path, data=body, headers=h, method=method)
        try:
            response = urllib.request.urlopen(r, timeout=5)
        except HTTPError as e:
            response = e
        with response:
            return response.status, response.read(), response.headers

    def test_routes_and_restore(self):
        self.assertEqual(self.req("/healthz")[:2], (200, b"ok\n"))
        self.assertEqual(self.req("/api/scan-queue")[0], 401)
        self.assertEqual(self.req("/api/scan-queue", token=self.token)[0], 503)
        at = int(time.time())
        price = dict(total_buyout=22, units=4, auctions=2, observed_at=at)
        bundle = dict(
            version=1,
            revision=at * 1000000,
            region="Forever-US",
            market="Normal-Alliance",
            snapshot=dict(
                estimate_at=at,
                estimate_prices={
                    "1001": dict(price, total_buyout=7, units=1, auctions=6)
                },
                items={"2000": {"name": "Buckle", "vendor_sell": 100}},
                recipes=[
                    dict(
                        id="b", name="Buckle", quantity=1, output=2000, mats=[[1001, 3]]
                    )
                ],
            ),
            targeted=[
                dict(
                    captured_at=at,
                    prices={"1001": dict(price, lots=[[2, 11, 2]])},
                    listed_units={"1001": 4, "1002": 0},
                )
            ],
        )

        def post(b, mime="application/gzip"):
            return self.req(
                "/api/scans",
                gzip.compress(json.dumps(b).encode()),
                self.token,
                headers={"Content-Type": mime},
            )

        self.assertEqual(post(bundle, "application/json")[0], 415)
        self.assertEqual(post(dict(bundle, market="Other-Horde"))[0], 422)
        self.assertEqual(post(bundle)[0], 202)
        self.assertEqual(json.loads(post(bundle)[1])["status"], "unchanged")
        self.assertEqual(post(dict(bundle, targeted=[]))[0], 409)
        self.assertEqual(
            self.req(
                "/api/scans",
                b"bad",
                self.token,
                headers={"Content-Type": "application/gzip"},
            )[0],
            422,
        )
        code, data, headers = self.req("/api/report")
        self.assertEqual(code, 200)
        r = json.loads(data)
        self.assertEqual(next(i["lots"] for i in r["items"] if i["id"] == 1001), [[2, 11, 2]])
        self.assertIn(b"/shopping.js", self.req("/")[1])
        self.assertIn(b"quoteShoppingBatch", self.req("/shopping.js")[1])
        self.assertIn(1001, r["scan_queue"])
        self.assertEqual(
            next(
                route["profit"]
                for i in r["items"]
                if i["id"] == 2000
                for route in i["routes"]
                if route["kind"] == "craft" and route["recipe_id"] == "b"
            ),
            83,
        )
        self.assertEqual(
            self.req("/api/report", headers={"If-None-Match": headers["ETag"]})[0], 304
        )
        self.assertEqual(self.req("/api/report", method="HEAD")[:2], (200, b""))
        self.stop()
        self.start()
        self.assertEqual(json.loads(post(bundle)[1])["status"], "unchanged")
        self.assertEqual(
            json.loads(self.req("/api/scan-queue", token=self.token)[1])["items"],
            r["scan_queue"],
        )

    def test_purchase_depth_and_hourly_history_without_dashboard_requests(self):
        now = int(time.time())
        # Two daily windows across three complete days, uploaded without any dashboard visits.
        day = (now // 86400 - 4) * 86400
        ore, legacy, absent = (810001, 810002, 810003)
        def upload(revision, at, base):
            lots = [[5, base * 5, 2], [1, base, 70], [1, 10 * base, 20]]
            prices = {ore: dict(total_buyout=280 * base, units=100, auctions=92,
                                observed_at=at, lots=lots),
                      legacy: dict(total_buyout=30, units=10, auctions=1, observed_at=at)}
            bundle = dict(version=1, revision=revision, region="Forever-US", market="Normal-Alliance",
                          snapshot={}, targeted=[dict(captured_at=at, prices=prices,
                            listed_units={ore: 100, legacy: 10, absent: 0})])
            res = self.req("/api/scans", gzip.compress(json.dumps(bundle).encode()), self.token,
                           headers={"Content-Type": "application/gzip"})
            self.assertEqual(res[0], 202, res[1])
        for d in range(3):
            for k, (h, price) in enumerate(((8, 2), (18, 7))):
                upload(2*d+k+1, day+d*86400+h*3600, price)
        upload(7, now, 2)
        upload(7, now, 2)
        self.stop()
        self.start()

        def quote(item, need, floor=0):
            code, data, _ = self.req(f"/api/purchase-quote?item={item}&quantity={need}&floor={floor}")
            self.assertEqual(code, 200, data)
            return json.loads(data)

        for need, floor, rank, unit in [(1, 0, 1, 2), (80, 0, 80, 2), (81, 0, 81, 20),
                                         (1, 90, 90, 20), (100, 0, 100, 20)]:
            q = quote(ore, need, floor)
            self.assertEqual((q["status"], q["source"], q["available"], q["rank"], q["unit_price"], q["budget"]),
                             ("priced", "In-game item check", 100, rank, unit, unit * need))
        self.assertEqual(quote(ore, 101)["status"], "insufficient")
        self.assertEqual(quote(legacy, 1)["status"], "no_price_levels")
        self.assertEqual(quote(absent, 1)["available"], 0)
        self.assertEqual(quote(810100, 1)["status"], "no_depth")
        for args in ("item=0&quantity=1", "item=1&quantity=0", "item=1&quantity=2&floor=101"):
            self.assertEqual(self.req("/api/purchase-quote?" + args)[0], 400)
        def series(need, floor):
            data = json.loads(self.req(f"/api/price-history?items={ore}:{need},{legacy}&floor={floor}")[1])
            self.assertEqual((data["timezone"], data["days"]), ("UTC", 28))
            return data["items"][str(ore)]
        hourly = series(80, 0)
        self.assertEqual(len(hourly), 7)
        self.assertEqual(hourly[:2], [[day+8*3600, 5.6, 160], [day+18*3600, 19.6, 560]])
        self.assertEqual(series(81, 0)[0][2], 1620)
        self.assertIsNone(series(101, 0)[0][2])
        self.assertEqual(series(1, 90)[0][2], 20)
        self.assertEqual(self.req("/api/price-history?items=1,1")[0], 400)

    def test_broker_import_and_freshness(self):
        at = int(time.time()) - 10
        url = "/api/bootybay/prices"
        mime = {"Content-Type": "application/json"}
        page = Path(self.temp.name) / "copper.html"
        page.write_text(f'''<link rel="canonical" href="https://bootybaybroker.com/forever/item/2840/copper-bar">
            <table><tr><th>Market</th><th>Lowest buyout</th><th>Last seen</th></tr>
            <tr><td>US PvE Alliance</td><td>13c</td><td><time datetime="{
                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))}">Today</time></td></tr></table>''')
        command = [sys.executable, str(ROOT / "start.py"), "broker", "--html", str(page), "--server", self.url,
                   "--region", "Forever-US", "--market", "Normal-Alliance"]
        env = dict(os.environ, WOW_UPLOAD_TOKEN=self.token, WOW_UPLOAD_TOKEN_FILE="")
        for updated in [1, 0]:
            output = subprocess.check_output(command, env=env, text=True)
            self.assertIn(f"{updated} prices updated", output)
        payload = {"region": "Forever-US", "market": "Normal-Alliance", "items": {
            "2840": {"price": 15, "observed_at": at-1}, "14047": {"price": 2, "observed_at": at-25000}}}
        data = json.dumps(payload).encode()
        self.assertEqual(self.req(url, data, headers=mime)[0], 401)
        self.assertEqual(json.loads(self.req(url, data, self.token, headers=mime)[1])["updated"], 1)
        payload["items"]["2840"]["observed_at"] = at
        self.assertEqual(self.req(url, json.dumps(payload).encode(), self.token, headers=mime)[0], 409)
        payload["market"] = "PvP-Horde"
        self.assertEqual(self.req(url, json.dumps(payload).encode(), self.token, headers=mime)[0], 422)
        self.stop()
        self.start()
        report = json.loads(self.req("/api/report")[1])
        items = {i["id"]: i for i in report["items"]}
        self.assertEqual(report["booty_bay_broker"]["fresh"], 1)
        self.assertIsNone(report["upload_revision"])
        self.assertEqual(items[2840]["estimate"], 13)
        self.assertEqual(items[2840]["estimate_source"], "Booty Bay Broker")
        self.assertEqual(items[2840]["estimate_at"], at)
        self.assertIsNone(items[2840]["listed_units"])
        self.assertIsNone(items[2840]["lots"])
        self.assertEqual(items[14047]["estimate"], 2)
        self.assertTrue(items[14047]["estimate_stale"])
        route = next(r for r in items[2851]["routes"] if r.get("recipe_id")=="2661" and r["kind"]=="craft")
        self.assertEqual(next(l["unit_cost"] for l in route["inputs"] if l["id"]==2840), 13)

        # Newer TSM estimates supersede the import. In-game stock stays independent.
        bundle = {"region": "Forever-US", "market": "Normal-Alliance", "version": 1, "revision": 1,
                  "snapshot": {"estimate_at": at+1, "estimate_prices": {
                      "2840": {"total_buyout": 7, "units": 1, "auctions": 9, "observed_at": at+1}}},
                  "targeted": [{"captured_at": at, "listed_units": {"2840": 0}, "prices": {}}]}
        code, _, _ = self.req("/api/scans", gzip.compress(json.dumps(bundle).encode()), self.token,
                              headers={"Content-Type": "application/gzip"})
        self.assertEqual(code, 202)
        copper = next(i for i in json.loads(self.req("/api/report")[1])["items"] if i["id"]==2840)
        self.assertEqual((copper["estimate"], copper["estimate_source"], copper["listed_units"]), (7, "Desktop AppHelper", 0))
        self.assertEqual(copper["broker_price"]["price"], 13)

    def test_complete_scan_prices_each_reagent_and_keeps_last_sale_price_after_restart(self):
        at = int(time.time()) - 100
        scope = dict(region="Forever-US", market="Normal-Alliance")
        ore, linen, dust, bar, thread, belt = range(800001, 800007)

        def price(value, timestamp, units=1):
            return dict(total_buyout=value, units=units, auctions=1, observed_at=timestamp)

        def upload(revision, snapshot, targeted=()):
            bundle = dict(scope, version=1, revision=revision, snapshot=snapshot, targeted=targeted)
            response = self.req("/api/scans", gzip.compress(json.dumps(bundle).encode()), self.token,
                                headers={"Content-Type": "application/gzip"})
            self.assertEqual(response[0], 202, response[1])
            return json.loads(response[1])["status"]

        upload(1, dict(newest_price_at=at, prices={linen: price(9, at, 2), bar: price(30, at)}))
        broker = dict(scope, items={dust: dict(price=8, observed_at=at-25000),
                                   ore: dict(price=11, observed_at=at+15),
                                   thread: dict(price=91, observed_at=at+13)})
        self.assertEqual(self.req("/api/bootybay/prices", json.dumps(broker).encode(), self.token,
                                  headers={"Content-Type": "application/json"})[0], 202)
        # The full scan observes only ore. An item search for thread is stored in an older group.
        scan = dict(newest_price_at=at+10, prices={ore: price(20, at+10, 4)},
                    estimate_at=at+5, estimate_prices={bar: price(2, at+5)},
                    items={belt: dict(name="Belt", vendor_sell=100, binding="Unbound")},
                    recipes=[dict(id="mixed-belt", name="Belt", output=belt, quantity=1,
                                  mats=[[ore, 1], [linen, 2], [dust, 1], [bar, 1], [thread, 1]])])
        checks = [dict(captured_at=at+12, prices={thread: price(6, at+12)}, listed_units={thread: 1},
                       checked_at={thread: at+14})]
        self.assertEqual(upload(2, scan, checks), "accepted")
        self.stop()
        self.start()
        self.assertEqual(upload(2, scan, checks), "unchanged")
        items = {i["id"]: i for i in json.loads(self.req("/api/report")[1])["items"]}
        for item_id, amount, source, observed, units in [
            (ore, 11, "Booty Bay Broker", at+15, 4),
            (linen, 4.5, "In-game full scan", at, 0),
            (dust, 8, "Booty Bay Broker", at-25000, 0),
            (bar, 2, "Desktop AppHelper", at+5, 0),
            (thread, 6, "In-game item check", at+14, 1),
        ]:
            i = items[item_id]
            self.assertEqual((i["estimate"], i["estimate_source"], i["estimate_at"], i["listed_units"]),
                             (amount, source, observed, units))
        self.assertEqual(items[ore]["checked_price"], 5)
        self.assertEqual(items[thread]["checked_at"], at+14)
        self.assertTrue(items[dust]["estimate_stale"])
        self.assertIsNone(items[linen]["lots"])
        craft = next(r for r in items[belt]["routes"] if r["kind"] == "craft")
        self.assertEqual((craft["cost"], craft["profit"], craft["stock"]), (36, 64, "insufficient"))

    def test_blizzard_worker_prices_the_report_and_keeps_cache_after_http_failure(self):
        self.stop()
        at = int(time.time()) - 30
        helper = Path(self.temp.name, "blizzard_fixture.py")
        helper.write_text(f'''import io, json, os, sys
from email.utils import formatdate
from unittest.mock import patch
from urllib.error import HTTPError
sys.path.insert(0, {str(ROOT / "client")!r})
import blizzard
assert "WOW_UPLOAD_TOKEN" not in os.environ
def read(req, timeout):
    if req.full_url == "https://oauth.battle.net/token":
        if os.environ.get("FIXTURE_DENIED"):
            raise HTTPError(req.full_url, 401, "error", {{}}, None)
        data = {{"access_token":"simulated-token"}}
    elif "/auctions/111/commodities?" in req.full_url:
        data = {{"auctions":[{{"item":{{"id":2840}},"quantity":20,"unit_price":13}}]}}
    else:
        assert "/ruleset/2/auctions/111?" in req.full_url
        data = {{"id":111,"auctions":[{{"item":{{"id":14047}},"quantity":2,"buyout":15}}]}}
    reply = io.BytesIO(json.dumps(data).encode())
    reply.headers = {{"Last-Modified":formatdate({at}, usegmt=True)}}
    return reply
with patch.object(blizzard, "build_opener") as opener:
    opener.return_value.open.side_effect = read
    sys.exit(blizzard.main())
''')
        settings = dict(WOW_BLIZZARD_CLIENT_ID="fixture-id", WOW_BLIZZARD_CLIENT_SECRET="fixture-secret",
                        WOW_BLIZZARD_PYTHON=sys.executable, WOW_BLIZZARD_HELPER=str(helper))
        for denied in ("", "1"):
            self.start(**settings, FIXTURE_DENIED=denied)
            for _ in range(30):
                status = json.loads(self.req("/api/status")[1])["blizzard"]
                if status["last_pull_at"]:
                    break
                time.sleep(0.1)
            self.assertIsNotNone(status["last_pull_at"])
            self.assertEqual(status["total"], 2, status)
            self.assertEqual(status["error"], "Blizzard returned HTTP 401" if denied else None)
            report = json.loads(self.req("/api/report")[1])
            items = {i["id"]: i for i in report["items"]}
            self.assertNotIn("fixture-secret", json.dumps(report))
            for item_id, expected in [(2840, 13), (14047, 7.5)]:
                i = items[item_id]
                self.assertEqual((i["estimate"], i["estimate_source"], i["estimate_at"]),
                                 (expected, "Blizzard Auction House", at))
                self.assertIsNone(i["lots"])
                quote = json.loads(self.req(f"/api/purchase-quote?item={item_id}&quantity=1")[1])
                self.assertEqual((quote["source"], quote["available"], quote["unit_price"], quote["budget"]),
                                 ("Blizzard Auction House", 20 if item_id == 2840 else 2,
                                  expected, 13 if item_id == 2840 else 8))
                hourly = json.loads(self.req(f"/api/price-history?items={item_id}&floor=0")[1])
                self.assertEqual(hourly["items"][str(item_id)][0][2], quote["budget"])
            if denied:
                bundle = dict(region="Forever-US", market="Normal-Alliance", revision=1, version=1,
                              snapshot=dict(newest_price_at=at+1, prices={"2840":dict(
                                  total_buyout=30, units=2, auctions=1, observed_at=at+1)}))
                self.assertEqual(self.req("/api/scans", gzip.compress(json.dumps(bundle).encode()), self.token,
                                          headers={"Content-Type":"application/gzip"})[0], 202)
                copper = next(i for i in json.loads(self.req("/api/report")[1])["items"] if i["id"] == 2840)
                self.assertEqual((copper["estimate"], copper["estimate_source"]), (15, "In-game full scan"))
                q = json.loads(self.req("/api/purchase-quote?item=2840&quantity=1")[1])
                self.assertEqual((q["source"], q["available"], q["status"]), ("In-game full scan", 2, "no_price_levels"))
            self.stop()

    def test_blizzard_legacy_cache_conditional_empty_and_hourly_retention(self):
        self.stop()
        at = int(time.time()) - 120
        home = Path(self.temp.name)
        scope = dict(region="Forever-US", market="Normal-Alliance")
        # Start from the previous release's price-only cache.
        cache = home / "blizzard-Forever-US-Normal-Alliance.json"
        cache.write_text(json.dumps(dict(scope, modified=[at-20, at-20],
                                         items={"2840": dict(total=9, units=1, at=at-20)})))
        fixture = home / "blizzard_fixture.py"
        fixture.write_text(f"""import json, os, sys
times = list(map(int, sys.argv[3:]))
if not os.getenv("EMPTY"):
    assert times == [0, 0], times
    data = dict(modified=[{at},{at}], items={{"14047": dict(total=13, units=1, at={at}),
                                             "2840": dict(total=10, units=1, at={at})}},
                depth=[{{"14047":[[1,13,4]]}},{{"2840":[[1,10,5]]}}])
else:
    assert times == [{at}, {at}], times
    data = dict(modified=[{at},{at+45}], items={{}}, depth=[None, {{}}])
print(json.dumps(dict(region=sys.argv[1], market=sys.argv[2], **data)))
""")
        settings = dict(WOW_BLIZZARD_CLIENT_ID="fixture", WOW_BLIZZARD_CLIENT_SECRET="fixture",
                        WOW_BLIZZARD_PYTHON=sys.executable, WOW_BLIZZARD_HELPER=str(fixture))
        for empty in ("", "1"):
            self.start(**settings, EMPTY=empty)
            for _ in range(40):
                status = json.loads(self.req("/api/status")[1])["blizzard"]
                if status["last_pull_at"]:
                    break
                time.sleep(0.1)
            self.assertIsNotNone(status["last_pull_at"])
            self.assertIsNone(status["error"])
            def quote(item):
                return json.loads(self.req(f"/api/purchase-quote?item={item}&quantity=1")[1])
            self.assertEqual(quote(14047)["available"], 4)
            q = quote(2840)
            self.assertEqual((q["available"], q["observed_at"]), (0, at+45) if empty else (5, at))
            if empty:
                history = json.loads(self.req("/api/price-history?items=2840&floor=0")[1])
                self.assertEqual(history["items"]["2840"][-1][1:], [None, None])
            self.stop()

    def test_server_fetches_without_client_then_client_uploads_real_lots(self):
        from unittest.mock import patch

        self.stop()
        url = "https://bootybaybroker.com/forever/item/2840/copper-bar"
        # Substitute only the external HTTPS transport. The worker launches the real
        # importer and parses the item page using the server's market configuration.
        helper = Path(self.temp.name) / "broker_fixture.py"
        helper.write_text(f'''import io, os, sys
from email.message import Message
from unittest.mock import patch
sys.path.insert(0, {str(ROOT / "client")!r})
import broker
assert "WOW_UPLOAD_TOKEN" not in os.environ and "WOW_UPLOAD_TOKEN_FILE" not in os.environ
def open_page(req, timeout):
    assert req.full_url in ({url + "?region=us"!r}, "https://bootybaybroker.com/forever/item/14341/rune-thread?region=us")
    response = io.BytesIO(b"""<table><tr><th>Market</th><th>Lowest buyout</th><th>Last seen</th></tr>
    <tr><td>US PvE Alliance</td><td>13c</td><td><time datetime="{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}">now</time></td></tr></table>""")
    response.headers = Message()
    response.headers["Content-Type"] = "text/html"
    return response
with patch.object(broker, "build_opener") as opener:
    opener.return_value.open.side_effect = open_page
    broker.main()
''')
        self.start(WOW_BROKER_URLS=url, WOW_BROKER_PYTHON=sys.executable, WOW_BROKER_HELPER=str(helper))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            status = json.loads(self.req("/api/status")[1])
            if status["booty_bay_broker"]["last_pull_at"]:
                break
            time.sleep(.05)
        self.assertEqual(status["booty_bay_broker"]["fresh"], 1, status["booty_bay_broker"])
        self.assertIsNone(status["upload_revision"])

        game = Path(self.temp.name) / "_forever_"
        saved = game / "WTF/Account/Test/SavedVariables/WowAuctionSync.lua"
        saved.parent.mkdir(parents=True)
        saved.write_text('WowAuctionSyncDB={version=1,markets={["Normal-Alliance"]={region="Forever-US",'
                         'capturedAt=%d,complete=true,items={[2840]={quantity=4,totalBuyout=28,auctions=2,'
                         'lots={[2]={[14]=2}}}}}}}' % int(time.time()))
        book = game / "Interface/AddOns/TradeSkillMaster_AppHelper/AppData.lua"
        book.parent.mkdir(parents=True)
        book.write_bytes(b"\xff")  # An unusable optional price book cannot block the scan.
        command = [sys.executable, str(ROOT / "start.py"), "client", "--once", "--server", self.url,
                   "--wow-dir", str(game)]
        with patch.dict(os.environ, WOW_UPLOAD_TOKEN=self.token, WOW_UPLOAD_TOKEN_FILE="",
                        WOW_REGION="Forever-US", WOW_MARKET="Normal-Alliance"):
            output = subprocess.check_output(command, text=True)
        self.assertIn("full-scan items 1", output)
        report = json.loads(self.req("/api/report")[1])
        copper = next(i for i in report["items"] if i["id"] == 2840)
        self.assertEqual((copper["broker_price"]["price"], copper["checked_price"], copper["listed_units"]), (13, 7, 4))
        self.assertEqual(copper["lots"], [[2, 14, 2]])

        # Reuse the same transport with no item URLs, and observe the first result
        # before the rest of the catalog has been fetched.
        self.stop()
        self.start(WOW_BROKER_URLS="auto", WOW_BROKER_DELAY_SECONDS="60",
                   WOW_BROKER_PYTHON=sys.executable, WOW_BROKER_HELPER=str(helper))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            broker_status = json.loads(self.req("/api/status")[1])["booty_bay_broker"]
            if broker_status["total"] > 1 or broker_status["pull_error"]:
                break
            time.sleep(.05)
        self.assertGreater(broker_status["configured_items"], 2000)
        self.assertEqual(broker_status["total"], 2, broker_status)
        report = json.loads(self.req("/api/report")[1])
        thread = next(i for i in report["items"] if i["id"] == 14341)
        self.assertEqual(thread["broker_price"]["price"], 13)

    def test_gaming_pc_apphelper_updates_server(self):
        with tempfile.TemporaryDirectory() as installation:
            game = Path(installation)
            book = game / "Interface/AddOns/TradeSkillMaster_AppHelper/AppData.lua"
            book.parent.mkdir(parents=True)
            env = dict(
                os.environ,
                WOW_UPLOAD_TOKEN=self.token,
                WOW_REGION="Forever-US",
                WOW_MARKET="Normal-Alliance",
            )
            env.pop("WOW_UPLOAD_TOKEN_FILE", None)
            command = [
                sys.executable,
                str(ROOT / "start.py"),
                "client",
                "--include-tsm",
                "--once",
                "--server",
                self.url,
                "--wow-dir",
                str(game),
            ]
            at = int(time.time()) - 2
            for offset, price in enumerate(("A", "B")):
                book.write_text(
                    'select(2,...).LoadData("AUCTIONDB_NON_COMMODITY_DATA","Forever-US","Normal-Alliance",'
                    f"[[return {{downloadTime={at + offset},"
                    'fields={"itemString","marketValueRecent","numAuctions"},'
                    f"data={{{{2840,{price},2}}}}}}]])"
                )
                if offset:
                    command[command.index("--server")] = "--upload-url"
                    command[command.index(self.url)] = self.url + "/api/scans"
                sent = subprocess.run(
                    command,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                self.assertEqual(sent.returncode, 0, sent.stderr)
                self.assertIn("1 Desktop AppHelper prices", sent.stdout)
                report = json.loads(self.req("/api/report")[1])
                self.assertEqual(report["tsm"]["source"], "Desktop AppHelper")
                self.assertGreaterEqual(report["uploaded_at"], at)
                self.assertEqual(
                    next(i["estimate"] for i in report["items"] if i["id"] == 2840),
                    10 + offset,
                )
            self.stop()
            self.start()
            status = json.loads(self.req("/api/status")[1])
            self.assertEqual(status["upload_revision"], report["upload_revision"])
            self.assertGreaterEqual(status["uploaded_at"], at)
