import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import start


class LauncherTests(unittest.TestCase):
    def test_install_mode_on_a_fresh_game_repairs_files_and_keeps_queue(self):
        script = Path(start.__file__).resolve()
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            game = base / "World of Warcraft" / "_forever_"
            game.mkdir(parents=True)
            command = [sys.executable, str(script), "install", "--wow-dir", str(game.parent)]
            def run():
                return subprocess.run(command, cwd=base, capture_output=True, text=True, check=True).stdout

            self.assertIn("Installed WoW Auction Sync", run())
            dest = game / "Interface/AddOns/WowAuctionSync"
            queue = dest / "Queue.lua"
            queue.write_text("WowAuctionSyncQueue = {items={123}}\n")
            db = game / "WTF/Account/Test/SavedVariables/WowAuctionSync.lua"
            db.parent.mkdir(parents=True)
            db.write_text("WowAuctionSyncDB = {version=1}\n")
            old_times = {p: p.stat().st_mtime_ns for p in dest.iterdir()}
            self.assertIn("up to date", run())
            self.assertEqual(old_times, {p: p.stat().st_mtime_ns for p in dest.iterdir()})
            (dest / "Opportunities.lua").write_text("-- previous version\n")
            (dest / "Catalog.lua").unlink()
            self.assertIn("Updated WoW Auction Sync", run())
            for name in ("Opportunities.lua", "Catalog.lua"):
                self.assertEqual((dest / name).read_bytes(),
                                 (script.parent / "addon/WowAuctionSync" / name).read_bytes())
            self.assertEqual(queue.read_text(), "WowAuctionSyncQueue = {items={123}}\n")
            self.assertEqual(db.read_text(), "WowAuctionSyncDB = {version=1}\n")

    def test_files_and_scope_used_for_watcher(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            game = base / "World of Warcraft" / "_forever_"
            (game / "Interface/AddOns").mkdir(parents=True)
            with patch.object(Path, "home", return_value=base):
                for explicit in (str(game), str(game.parent), None):
                    self.assertEqual(
                        start.game_folder(explicit, {"ProgramFiles": folder}),
                        game.resolve() if explicit else game,
                    )
            env = {"WOW_REGION": "Forever-EU", "WOW_MARKET": "PvP-Horde"}
            command = start.watcher_command(base, env, game, "https://auction.example")
            for value in (
                str(game),
                "https://auction.example",
                "--auction-house-only",
                "Forever-EU",
                "PvP-Horde",
                "--watch",
            ):
                self.assertIn(value, command)

    def test_docker_keeps_watcher_in_container_and_preserves_mount_scope(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as folder:
            game = Path(folder) / "World of Warcraft" / "_forever_"
            (game / "Interface/AddOns").mkdir(parents=True)
            with patch(
                "start.subprocess.run", return_value=subprocess.CompletedProcess([], 0)
            ) as compose:
                self.assertEqual(start.docker(root, {}, game, desktop=True), 0)
                self.assertEqual(compose.call_count, 1)
                command = compose.call_args.args[0]
                self.assertEqual(
                    command,
                    [
                        "docker",
                        "compose",
                        "-f",
                        "compose.yaml",
                        "-f",
                        "compose.desktop.yaml",
                        "-f",
                        "-",
                        "up",
                        "-d",
                        "--build",
                    ],
                )
                mounts = json.loads(compose.call_args.kwargs["input"])["services"][
                    "dashboard"
                ]["volumes"]
                self.assertEqual(
                    [(m["source"], m["target"], m["read_only"]) for m in mounts],
                    [
                        (str(game.parent), "/wow", True),
                        (
                            str(game / "Interface/AddOns"),
                            "/wow/_forever_/Interface/AddOns",
                            False,
                        ),
                    ],
                )
                self.assertEqual(start.docker(root, {}, None), 0)
                self.assertIsNone(compose.call_args.kwargs["input"])

                self.assertNotIn("compose.desktop.yaml", compose.call_args.args[0])

    def test_client_uses_server_token_and_never_starts_a_local_service(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.dict(os.environ, {}, clear=True),
        ):
            root = Path(folder)
            game = root / "game"
            (game / "Interface/AddOns").mkdir(parents=True)
            args = SimpleNamespace(
                server=None, upload_url=None, wow_dir=game, once=False
            )
            secret = "a" * 32
            (root / "client.env").write_text(
                "WOW_SERVER_URL=https://dashboard.example\nWOW_UPLOAD_TOKEN="
                + secret
                + "\n"
            )
            with patch("start.subprocess.call", return_value=0) as launch:
                self.assertEqual(start.client(root, args), 0)
            self.assertTrue((game / "Interface/AddOns/WowAuctionSync/OpportunityPanel.lua").is_file())
            command = launch.call_args.args[0]
            self.assertIn("https://dashboard.example", command)
            self.assertIn("--watch", command)
            self.assertNotIn(secret, command)
            self.assertEqual(launch.call_args.kwargs["env"]["WOW_UPLOAD_TOKEN"], secret)
            self.assertFalse((root / ".env").exists())

    def test_hosted_endpoint_precedence(self):
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.dict(os.environ, {}, clear=True),
        ):
            root = Path(folder)
            (root / "Interface/AddOns").mkdir(parents=True)
            configured = "https://api.example.com/ingest/"
            (root / "client.env").write_text(
                "WOW_UPLOAD_URL=" + configured + "\nWOW_UPLOAD_TOKEN=" + "a" * 32 + "\n"
            )
            for upload_url, server, flag, expected in [
                (None, None, "--upload-url", configured),
                (
                    "https://example.test/v2/write",
                    None,
                    "--upload-url",
                    "https://example.test/v2/write",
                ),
                (
                    None,
                    "https://scanner.example.com",
                    "--server",
                    "https://scanner.example.com",
                ),
            ]:
                args = SimpleNamespace(
                    upload_url=upload_url, server=server, wow_dir=root, once=True
                )
                with (
                    self.subTest(flag=flag, expected=expected),
                    patch("start.subprocess.call", return_value=0) as launch,
                ):
                    self.assertEqual(start.client(root, args), 0)
                    command = launch.call_args.args[0]
                    self.assertEqual(command[command.index(flag) + 1], expected)
                    self.assertNotIn("--watch", command)
