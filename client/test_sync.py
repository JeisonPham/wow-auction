import tempfile
import time
import unittest
from pathlib import Path

from disenchant import import_tables
from lua_data import named_table
from snapshot import compress, export, fingerprint, pack_checks
from sync import addon_path, endpoint, install, write_queue


class ScannerTests(unittest.TestCase):
    def test_local_opportunity_checks_keep_item_times_and_complete_scope(self):
        with tempfile.TemporaryDirectory() as folder:
            game = Path(folder)
            install(game)
            toc = (addon_path(game) / "WowAuctionSync.toc").read_text()
            for line in toc.splitlines():
                if line.endswith(".lua"):
                    self.assertTrue((addon_path(game) / line).is_file(), line)
            path = game / "WTF/Account/A/SavedVariables/WowAuctionSync.lua"
            path.parent.mkdir(parents=True)
            path.write_text('WowAuctionSyncDB={version=1,targeted={["Normal-Alliance"]={'
                            'region="Forever-US",capturedAt=100,complete=true,'
                            'checked={[1]=true,[2]=true},checkedAt={[1]=90,[2]=105},'
                            'items={[2]={totalBuyout=11,auctions=1,quantity=2,lots={[2]={[11]=1}}}}}}}')
            caps = export(fingerprint(game), "Forever-US", "Normal-Alliance")["targeted"]
            self.assertEqual([(c["captured_at"], c["listed_units"]) for c in caps],
                             [(105, {"2": 2}), (90, {"1": 0})])
            self.assertEqual(caps[0]["prices"]["2"]["observed_at"], 105)
        checks = {str(n): (n, None) for n in range(1, 1001)}
        caps = pack_checks(checks, 501)
        self.assertLessEqual(len(caps), 128)
        self.assertEqual(caps[0]["captured_at"], 1000)
        exported = {int(k): c["captured_at"] for c in caps for k in c["listed_units"]}
        self.assertEqual(len(exported), 1000)
        self.assertTrue(all(t <= k and (t >= 501) == (k >= 501) for k,t in exported.items()))

    def test_first_save_and_empty_accounts(self):
        with tempfile.TemporaryDirectory() as folder:
            game = Path(folder)
            empty = game / "WTF/Account/A/SavedVariables/WowAuctionSync.lua"
            empty.parent.mkdir(parents=True)
            for contents in ("", "-- first login\n", "WowAuctionSyncDB = nil",
                             "WowAuctionSyncDB = {}", "WowAuctionSyncDB = {version=1}"):
                empty.write_text(contents, encoding="utf-8-sig")
                with self.subTest(contents=contents), self.assertRaisesRegex(ValueError, "/wamsync roster.* /reload"):
                    export(fingerprint(game), "Forever-US", "Normal-Alliance")

            helper = game / "Interface/AddOns/TradeSkillMaster_AppHelper/AppData.lua"
            helper.parent.mkdir(parents=True)
            helper.write_text('LoadData("AUCTIONDB_NON_COMMODITY_DATA","Normal-Alliance",[[return {downloadTime=99,fields={"itemString","marketValueRecent","numAuctions"},data={{123,A,2}}}]])')
            empty.write_text("WowAuctionSyncDB = nil -- unused account")
            bundle = export(fingerprint(game), "Forever-US", "Normal-Alliance")
            self.assertEqual(bundle["snapshot"]["estimate_at"], 99)
            self.assertNotIn("newest_price_at", bundle["snapshot"])

            helper.unlink()
            full = game / "WTF/Account/B/SavedVariables/WOWAuctionSync.lua"
            full.parent.mkdir(parents=True)
            full.write_text('WowAuctionSyncDB = {version=1, markets={["Normal-Alliance"]={region="Forever-US",capturedAt=100,complete=true,items={}}}}')
            bundle = export(fingerprint(game), "Forever-US", "Normal-Alliance")
            self.assertEqual(bundle["snapshot"]["newest_price_at"], 100)
            self.assertEqual(bundle["snapshot"]["prices"], {})
            empty.write_text("WowAuctionSyncDB = unexpected")
            with self.assertRaisesRegex(ValueError, "Expected the saved table WowAuctionSyncDB"):
                export(fingerprint(game), "Forever-US", "Normal-Alliance")

    def test_install_export_queue(self):
        with tempfile.TemporaryDirectory() as folder:
            game = Path(folder)
            install(game)
            path = game / "WTF/Account/Test/SavedVariables/WowAuctionSync.lua"
            path.parent.mkdir(parents=True)
            path.write_text(
                """WowAuctionSyncDB = {version=1, markets={}, targeted={["Normal-Alliance"]={region="Forever-US", complete=true,capturedAt=100,checked={[1001]=true,[1002]=true},items={[1001]={quantity=4,totalBuyout=22,auctions=2,lots={[2]={[11]=2}}}}}}, profiles={["Forever-US/Normal-Alliance"]={characters={Ada={level=25,professions={Blacksmithing=100},recipes={Blacksmithing={b={id="b",name="Buckle",output=2000,quantity=1,quantity_max=5,mats={{1001,3}}}}}}},itemInfo={[2000]={name="Buckle",vendor_sell=100}}}}}"""
            )
            helper = game / "Interface/AddOns/TradeSkillMaster_AppHelper/AppData.lua"
            helper.parent.mkdir()
            helper.write_text(
                'select(2,...).LoadData("AUCTIONDB_NON_COMMODITY_DATA","Normal-Alliance",[[return {downloadTime=99,fields={"itemString","marketValueRecent","numAuctions"},data={{1001,V,F},{1001:2,8,7}}}]])'
            )
            files = fingerprint(game)
            b = export(files, "Forever-US", "Normal-Alliance")
            self.assertEqual(
                compress(b), compress(export(files, "Forever-US", "Normal-Alliance"))
            )
            self.assertEqual(b["revision"], max(x[1] for x in files) // 1000)
            self.assertEqual(
                b["snapshot"]["estimate_prices"]["1001"]["total_buyout"], 31
            )
            self.assertEqual(b["snapshot"]["recipes"][0]["mats"], [[1001, 3]])
            self.assertEqual(b["snapshot"]["recipes"][0]["quantity_max"], 5)
            self.assertEqual(b["targeted"][0]["listed_units"], {"1001": 4, "1002": 0})
            self.assertEqual(b["targeted"][0]["prices"]["1001"]["lots"], [[2, 11, 2]])
            now = int(time.time())
            q = dict(
                region=b["region"],
                market=b["market"],
                items=[1001],
                estimate_at=now,
                expires_at=now + 60,
                upload_revision=b["revision"],
            )
            write_queue(game, q, b)
            queue = addon_path(game) / "Queue.lua"
            before = queue.read_bytes()
            install(game)
            self.assertEqual(queue.read_bytes(), before)
            for patch in (
                dict(items=[1, 1]),
                dict(expires_at=now - 1),
                dict(upload_revision=0),
                dict(market="Other"),
            ):
                with self.assertRaises(ValueError):
                    write_queue(game, dict(q, **patch), b)
            self.assertEqual(queue.read_bytes(), before)

    def test_desktop_only_host_uses_matching_prices(self):
        import gzip
        import json
        from types import SimpleNamespace
        from unittest.mock import patch

        from sync import sync

        with tempfile.TemporaryDirectory() as folder:
            game = Path(folder)
            path = game / "Interface/AddOns/TradeSkillMaster_AppHelper/AppData.lua"
            path.parent.mkdir(parents=True)
            line = 'select(2,...).LoadData("AUCTIONDB_NON_COMMODITY_DATA","%s","Normal-Alliance",[[return {downloadTime=%d,fields={"itemString","marketValueRecent","numAuctions"},data={{123,A,2}}}]])'
            path.write_text(
                line % ("Forever-US", 100) + "\n" + line % ("Forever-EU", 200)
            )
            args = SimpleNamespace(
                wow_dir=game,
                bundle=None,
                region="Forever-US",
                market="Normal-Alliance",
                server="http://127.0.0.1:8765",
                watch=False,
            )

            def upload(url, secret, raw, *, allow_empty):
                self.assertFalse(allow_empty)
                self.assertTrue(url.endswith("/api/scans"))
                bundle = json.loads(gzip.decompress(raw))
                self.assertEqual(bundle["snapshot"]["estimate_at"], 100)
                self.assertEqual(
                    bundle["snapshot"]["estimate_prices"]["123"]["total_buyout"], 10
                )
                return {"status": "accepted", "revision": bundle["revision"]}

            with (
                patch("sync.token", return_value="x" * 32),
                patch("sync.request", side_effect=upload) as send,
            ):
                sync(args)
                self.assertEqual(send.call_count, 1)
            self.assertFalse(addon_path(game).exists())

    def test_connected_apphelper_book(self):
        from snapshot import apphelper

        data = 'for _,r in ipairs({"PvP-Horde","Normal-Alliance"}) do select(2, ...).LoadData("AUCTIONDB_NON_COMMODITY_DATA",r,[[return {downloadTime=99,fields={"itemString","marketValueRecent","numAuctions"},data={{123,A,1}}}]]) end'
        self.assertEqual(
            apphelper(data, "Forever-US", "Normal-Alliance")[1]["123"]["total_buyout"],
            10,
        )
        self.assertEqual(apphelper(data, "Forever-US", "Normal-Horde"), (0, {}))

    def test_exact_https_upload_with_installed_addon(self):
        import gzip
        import io
        import json
        import os
        from types import SimpleNamespace
        from unittest.mock import patch

        from sync import sync

        with tempfile.TemporaryDirectory() as folder:
            game = Path(folder)
            install(game)
            book = game / "Interface/AddOns/TradeSkillMaster_AppHelper/AppData.lua"
            book.parent.mkdir()
            book.write_text(
                'select(2,...).LoadData("AUCTIONDB_NON_COMMODITY_DATA","Normal-Alliance",[[return {downloadTime=99,fields={"itemString","marketValueRecent","numAuctions"},data={{123,A,2}}}]])'
            )
            url = "https://api.example.com/v2/auctions/import/?version=1"
            args = SimpleNamespace(
                upload_url=url,
                wow_dir=game,
                bundle=None,
                region="Forever-US",
                market="Normal-Alliance",
                watch=False,
            )
            with (
                patch.dict(
                    os.environ,
                    {"WOW_UPLOAD_TOKEN": "api-issued", "WOW_UPLOAD_TOKEN_FILE": ""},
                ),
                patch("sync.build_opener") as opener,
            ):
                send = opener.return_value.open
                send.return_value = io.BytesIO(b"")
                sync(args)
                send.assert_called_once()
                req = send.call_args.args[0]
                self.assertEqual((req.get_method(), req.full_url), ("POST", url))
                self.assertEqual(req.get_header("Authorization"), "Bearer api-issued")
                self.assertEqual(req.get_header("Content-type"), "application/gzip")
                data = json.loads(gzip.decompress(req.data))
                self.assertEqual(
                    data["snapshot"]["estimate_prices"]["123"]["total_buyout"], 10
                )
                send.return_value = io.BytesIO(b'{"revision":1}')
                with self.assertRaisesRegex(ValueError, "different revision"):
                    sync(args)

    def test_urls_and_reader(self):
        for url in (
            "http://example.com",
            "http://127.0.0.1@example.com",
            "ftp://localhost",
        ):
            with self.assertRaises(ValueError):
                endpoint(url)
        self.assertEqual(endpoint("http://[::1]:8765/"), "http://[::1]:8765")
        with self.assertRaises(ValueError):
            named_table("X = {x=os.execute('bad')}", "X")

    def test_yields(self):
        bands = "DATA.Forever = {{class=2,quality=2,minItemLevel=5,maxItemLevel=10,materials={{itemID=31,amountOfMats=1.5,dropChance=0.5}}}}"
        e = "DATA.All = {[100]=true}\nDATA.Forever = {}"
        self.assertEqual(import_tables(bands, e)["disenchant"][0]["mats"], {31: 1.5})
        self.assertEqual(
            import_tables(bands.replace("class=2", "unknown=true,class=2"), e), {}
        )
        self.assertEqual(import_tables(bands, ""), {})

    def test_watcher_polls_queue_without_reposting(self):
        from types import SimpleNamespace
        from unittest.mock import patch

        from sync import sync

        with tempfile.TemporaryDirectory() as folder:
            game = Path(folder)
            install(game)
            path = game / "WTF/Account/A/SavedVariables/WowAuctionSync.lua"
            path.parent.mkdir(parents=True)
            path.write_text('WowAuctionSyncDB = {version=1,profiles={["Forever-US/Normal-Alliance"]={characters={Ada={level=10}}}}}')
            rev = path.stat().st_mtime_ns // 1000
            scope = {"region": "Forever-US", "market": "Normal-Alliance"}
            queue = dict(
                scope, items=[], estimate_at=0, expires_at=0, upload_revision=rev
            )
            args = SimpleNamespace(
                server="http://localhost",
                bundle=None,
                watch=True,
                poll=1,
                wow_dir=game,
                **scope,
            )
            with (
                patch("sync.token", return_value="x" * 32),
                patch(
                    "sync.request",
                    side_effect=[{"revision": rev, "status": "accepted"}, queue, queue],
                ) as call,
                patch("sync.time.sleep", side_effect=[None, KeyboardInterrupt]),
            ):
                with self.assertRaises(KeyboardInterrupt):
                    sync(args)
            self.assertEqual(
                [c.args[0].split("/")[-1] for c in call.call_args_list],
                ["scans", "scan-queue", "scan-queue"],
            )

    def test_pc_watcher_waits_for_book_and_uploads_only_changes(self):
        import gzip
        import json
        from types import SimpleNamespace
        from unittest.mock import patch

        from sync import sync

        with tempfile.TemporaryDirectory() as folder:
            game = Path(folder)
            book = game / "Interface/AddOns/TradeSkillMaster_AppHelper/AppData.lua"
            book.parent.mkdir(parents=True)
            # A different market is present while Desktop is still syncing.
            source = 'select(2,...).LoadData("AUCTIONDB_NON_COMMODITY_DATA","Forever-US","%s",[[return {downloadTime=%d,fields={"itemString","marketValueRecent","numAuctions"},data={{123,%s,2}}}]])'
            book.write_text(source % ("Normal-Horde", 100, "A"))
            args = SimpleNamespace(
                wow_dir=game,
                bundle=None,
                region="Forever-US",
                market="Normal-Alliance",
                server="https://auction.example",
                watch=True,
                poll=1,
                require_desktop=True,
            )
            uploads = []

            def accept(url, token, raw, *, allow_empty):
                self.assertFalse(allow_empty)
                self.assertEqual(url, args.server + "/api/scans")
                snap = json.loads(gzip.decompress(raw))
                uploads.append(
                    snap["snapshot"]["estimate_prices"]["123"]["total_buyout"]
                )
                return {"status": "accepted", "revision": snap["revision"]}

            polls = iter(
                [("Normal-Alliance", 101, "B"), None, ("Normal-Alliance", 102, "C")]
            )

            def tick(_):
                try:
                    changed = next(polls)
                except StopIteration:
                    raise KeyboardInterrupt
                if changed:
                    book.write_text(source % changed)

            with (
                patch("sync.token", return_value="x" * 32),
                patch("sync.request", side_effect=accept),
                patch("sync.time.sleep", side_effect=tick),
                self.assertRaises(KeyboardInterrupt),
            ):
                sync(args)
            self.assertEqual(uploads, [11, 12])
