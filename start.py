#!/usr/bin/env python3
"""Start the auction dashboard, run the gaming PC uploader, or install its add-on."""

import argparse
import getpass
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

from client.addon import install


def token_file(root):
    path = root / ".env"
    if not path.exists():
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            return path
        with os.fdopen(fd, "w") as f:
            f.write("WOW_UPLOAD_TOKEN=" + secrets.token_hex(32) + "\n")
    return path


def game_folder(explicit, env):
    if explicit:
        folder = Path(explicit).expanduser()
        for candidate in (folder / "_forever_", folder):
            if (
                candidate.name == "_forever_" and candidate.is_dir()
                or (candidate / "Interface" / "AddOns").is_dir()
            ):
                return candidate.resolve()
        raise ValueError(
            f"Cannot find a WoW Forever installation in {folder}."
        )
    bases = [Path("/Applications"), Path.home() / "Applications"]
    bases.extend(
        Path(env[k]) for k in ("ProgramFiles(x86)", "ProgramFiles") if env.get(k)
    )
    for base in bases:
        game = base / "World of Warcraft" / "_forever_"
        if game.is_dir():
            return game
    return None


def watcher_command(
    root, env, game, url, watch=True, include_tsm=False, exact=False
):
    command = [
        sys.executable,
        str(root / "client" / "sync.py"),
        "sync",
        "--wow-dir",
        str(game),
        "--upload-url" if exact else "--server",
        url,
        "--region",
        env.get("WOW_REGION", "Forever-US"),
        "--market",
        env.get("WOW_MARKET", "Normal-Alliance"),
    ]
    if not include_tsm:
        command.append("--auction-house-only")
    if watch:
        command.append("--watch")
    print(f"Reading saved auction-house scans and character exports in {game}", flush=True)
    return command


def native(command, root, env, watcher):
    if watcher is None:
        return subprocess.call(command, cwd=root, env=env)
    server = subprocess.Popen(command, cwd=root, env=env)
    sync = None
    try:
        sync = subprocess.Popen(watcher, cwd=root, env=env)
        return server.wait()
    finally:
        for child in (sync, server):
            if child and child.poll() is None:
                child.terminate()
                child.wait()


def docker(root, env, game=None, desktop=False):
    command = ["docker", "compose", "-f", "compose.yaml"]
    if desktop:
        command += ["-f", "compose.desktop.yaml"]
    override = None
    if desktop and game:

        def bind(source, target, read_only):
            return {
                "type": "bind",
                "source": str(source),
                "target": target,
                "read_only": read_only,
                "bind": {"create_host_path": False},
            }

        if game.name == "_forever_" and (
            (game.parent / ".build.info").is_file()
            or game.parent.name == "World of Warcraft"
        ):
            mounts = [bind(game.parent, "/wow", True)]
        else:
            mounts = [bind(game, "/wow/_forever_", True)]
        mounts.append(
            bind(
                game / "Interface" / "AddOns", "/wow/_forever_/Interface/AddOns", False
            )
        )
        override = json.dumps({"services": {"dashboard": {"volumes": mounts}}})
        command += ["-f", "-"]
        if sys.platform.startswith("linux") and os.getuid() != 0:
            env.setdefault("WOW_TSM_UID", str(os.getuid()))
            env.setdefault("WOW_TSM_GID", str(os.getgid()))
        print(
            f"Sharing {game} with the container. TSM can update its add-ons.",
            flush=True,
        )
    command += ["up", "-d", "--build"]
    result = subprocess.run(
        command, cwd=root, env=env, input=override, text=True, check=False
    )
    if result.returncode == 0:
        print("Dashboard: http://127.0.0.1:" + env.get("WOW_PORT", "8765") + "/")
        if desktop:
            print(
                "TSM Desktop: http://127.0.0.1:" + env.get("WOW_TSM_PORT", "5800") + "/"
            )
    return result.returncode


def binary_is_current(binary, root):
    if not binary.is_file():
        return False
    built = binary.stat().st_mtime_ns
    sources = [root / "Cargo.toml", root / "Cargo.lock"]
    for folder in (root / "src", root / "web"):
        sources.extend(p for p in folder.rglob("*") if p.is_file())
    return all(p.stat().st_mtime_ns <= built for p in sources)


def settings(path):
    env = os.environ.copy()
    if path.is_file():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            key, sep, value = line.partition("=")
            if sep and key.startswith("WOW_"):
                env.setdefault(key, value.strip().strip("\"'"))
    return env


def install_client_addon(wow_dir, env):
    game = game_folder(wow_dir or env.get("WOW_GAME_DIR"), env)
    if not game:
        raise ValueError("Supply --wow-dir with the local WoW Forever installation.")
    install(game)
    return game


def client(root, args):
    env = settings(root / "client.env")
    game = install_client_addon(args.wow_dir, env)
    upload_url = args.upload_url or (
        env.get("WOW_UPLOAD_URL") if not args.server else None
    )
    url = upload_url or args.server or env.get("WOW_SERVER_URL")
    if not url:
        raise ValueError(
            "Supply --upload-url with the hosted endpoint or set WOW_UPLOAD_URL in client.env. For a scanner base URL, use --server."
        )
    if not (env.get("WOW_UPLOAD_TOKEN") or env.get("WOW_UPLOAD_TOKEN_FILE")):
        if not sys.stdin.isatty():
            raise ValueError(
                "Set the server's WOW_UPLOAD_TOKEN in client.env or the environment."
            )
        env["WOW_UPLOAD_TOKEN"] = getpass.getpass("API bearer token: ")
    return subprocess.call(
        watcher_command(
            root, env, game, url, watch=not args.once, exact=bool(upload_url),
            include_tsm=getattr(args, "include_tsm", False)
        ),
        cwd=root,
        env=env,
    )


def main():
    root = Path(__file__).resolve().parent
    if sys.argv[1:2] == ["broker"]:
        return subprocess.call([sys.executable, str(root / "client" / "broker.py"), *sys.argv[2:]],
                               env=settings(root / "client.env"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode", choices=("server", "client", "install", "broker"), nargs="?",
        help="Use client to install and upload, install for offline add-on setup, or broker --help for price imports",
    )
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--upload-url", help="Full HTTPS endpoint to POST snapshots to")
    target.add_argument(
        "--server", help="Scanner base URL for uploads and the in-game scan queue"
    )
    parser.add_argument(
        "--once", action="store_true", help="Upload once and exit (client mode)"
    )
    parser.add_argument("--include-tsm", action="store_true", help="Also upload local TSM AppHelper planning estimates (client mode)")
    parser.add_argument(
        "--desktop",
        action="store_true",
        help="Start the optional Docker-hosted TSM desktop",
    )
    parser.add_argument(
        "--native",
        action="store_true",
        help="Run the Rust service on loopback in this terminal",
    )
    parser.add_argument(
        "--init-only",
        action="store_true",
        help="Prepare .env without starting the service",
    )
    parser.add_argument("--wow-dir", help="WoW Forever game folder or its parent")
    args = parser.parse_args()
    if args.include_tsm and args.mode != "client":
        parser.error("--include-tsm is a client option")
    if args.mode == "install":
        if any((args.server, args.upload_url, args.once, args.init_only, args.native, args.desktop)):
            parser.error("install accepts --wow-dir to select the game folder")
        install_client_addon(args.wow_dir, settings(root / "client.env"))
        return 0
    if args.mode == "client":
        if args.native or args.init_only or args.desktop:
            parser.error("--native, --init-only and --desktop are server options")
        return client(root, args)
    if args.server or args.upload_url or args.once:
        parser.error("--upload-url, --server and --once are client options")
    if args.native and args.desktop:
        parser.error("--desktop requires Docker")
    if args.wow_dir and not args.native:
        args.desktop = True
    path = token_file(root)
    if args.init_only:
        return 0
    env = settings(path)
    if not args.native:
        game = (
            game_folder(args.wow_dir or env.get("WOW_GAME_DIR"), env)
            if args.desktop
            else None
        )
        if game:
            install(game)
        return docker(root, env, game, desktop=args.desktop)
    env.setdefault("WOW_BIND", "127.0.0.1:" + env.get("WOW_PORT", "8765"))
    env.setdefault("WOW_DATA_DIR", str(root / "local-data"))
    env.setdefault("WOW_BROKER_HELPER", str(root / "client" / "broker.py"))
    env.setdefault("WOW_BROKER_PYTHON", sys.executable)
    binary = (
        root
        / "target"
        / "release"
        / ("wow-auction-monitor.exe" if os.name == "nt" else "wow-auction-monitor")
    )
    command = (
        [str(binary), "serve"]
        if binary_is_current(binary, root)
        else ["cargo", "run", "--locked", "--release", "--", "serve"]
    )
    game = (
        game_folder(args.wow_dir or env.get("WOW_GAME_DIR"), env)
        if args.wow_dir or args.mode is None
        else None
    )
    if game:
        install(game)
    watcher = (
        watcher_command(
            root,
            env,
            game,
            "http://127.0.0.1:" + env["WOW_BIND"].rsplit(":", 1)[-1],
            include_tsm=True,
        )
        if game
        else None
    )
    return native(command, root, env, watcher)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except (OSError, ValueError) as error:
        sys.exit(str(error))
