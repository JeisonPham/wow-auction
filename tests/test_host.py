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

    def start(self):
        env = dict(
            os.environ,
            WOW_BIND="127.0.0.1:0",
            WOW_UPLOAD_TOKEN=self.token,
            WOW_TSM_PUBLIC="0",
            WOW_DATA_DIR=self.temp.name,
            WOW_REGION="Forever-US",
            WOW_MARKET="Normal-Alliance",
        )
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
