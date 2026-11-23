#!/usr/bin/env python3
import argparse
import gzip
import io
import ipaddress
import json
import os
import sys
import time
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from addon import addon_path, atomic, install
from snapshot import SAVED_DATABASES, compress, export, fingerprint


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Server redirected the request")


def endpoint(url, *, exact=False):
    u = urlsplit(url)
    try:
        loopback = ipaddress.ip_address(u.hostname or "").is_loopback
    except ValueError:
        loopback = u.hostname == "localhost"
    if (
        not u.hostname
        or u.username is not None
        or u.password is not None
        or (u.query and not exact)
        or u.fragment
        or not (u.scheme == "https" or u.scheme == "http" and loopback)
    ):
        raise ValueError("Use HTTPS or a loopback HTTP server")
    return url if exact else url.rstrip("/")


def token(*, scanner=True):
    filename = os.environ.get("WOW_UPLOAD_TOKEN_FILE")
    value = (
        Path(filename).read_text().rstrip("\r\n")
        if filename
        else os.environ.get("WOW_UPLOAD_TOKEN", "")
    )
    if (
        not value
        or (scanner and not 32 <= len(value) <= 512)
        or any(not 33 <= ord(c) <= 126 for c in value)
    ):
        raise ValueError("Set WOW_UPLOAD_TOKEN or WOW_UPLOAD_TOKEN_FILE")
    return value


def request(url, secret, body=None, *, allow_empty=False, content_type="application/gzip"):
    headers = {"Authorization": "Bearer " + secret}
    if body is not None:
        headers["Content-Type"] = content_type
    req = Request(url, data=body, headers=headers)
    try:
        with build_opener(NoRedirect()).open(req, timeout=90) as response:
            raw = response.read()
            if allow_empty and not raw:
                return None
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError("Expected a JSON object from the API")
            return result
    except HTTPError as e:
        raise ValueError(
            f"HTTP {e.code}: {e.read(4096).decode(errors='replace')}"
        ) from e


def write_queue(game, q, b):
    for key in ("region", "market"):
        if q[key] != b[key] or not all(
            ch.isascii() and (ch.isalnum() or ch in " -") for ch in q[key]
        ):
            raise ValueError("Queue scope mismatch")
    if q["upload_revision"] != b["revision"]:
        raise ValueError("Queue revision changed")
    ids = q["items"]
    if (
        not isinstance(ids, list)
        or len(ids) > 250
        or any(type(i) is not int or not 1 <= i <= 0xFFFFFFFF for i in ids)
        or len(set(ids)) != len(ids)
    ):
        raise ValueError("Invalid queue item IDs")
    at, end = q["estimate_at"], q["expires_at"]
    if (
        type(at) is not int
        or type(end) is not int
        or (
            ids
            and not (0 < at <= time.time() + 300 and end >= time.time() and end >= at)
        )
        or (not ids and (at or end))
    ):
        raise ValueError("Invalid or expired queue")
    dest = addon_path(game) / "Queue.lua"
    data = (
        'WowAuctionSyncQueue = {region="%s",market="%s",generatedAt=%d,expiresAt=%d,items={%s}}\n'
        % (q["region"], q["market"], at, end, ",".join(map(str, ids)))
    ).encode()
    if not dest.exists() or dest.read_bytes() != data:
        atomic(dest, data)
        print(f"Updated queue ({len(ids)} items). Type /reload in game.", flush=True)


def sync(args):
    custom_url = getattr(args, "upload_url", None)
    if custom_url:
        upload_url, queue_url = endpoint(custom_url, exact=True), None
    else:
        base = endpoint(args.server)
        upload_url, queue_url = base + "/api/scans", base + "/api/scan-queue"
    secret = token(scanner=not custom_url)
    previous = None
    bundle = None
    auction_only = getattr(args, "auction_house_only", False)
    while True:
        try:
            if args.bundle:
                stat = args.bundle.stat()
                sig = (stat.st_mtime_ns, stat.st_size)
            else:
                sig = fingerprint(args.wow_dir, include_apphelper=not auction_only)
                if auction_only and not any(path.name.lower() in SAVED_DATABASES for path, _, _ in sig):
                    raise ValueError("Waiting for in-game data. Finish /wamsync full or /wamsync roster, then /reload in WoW.")
            if sig != previous:
                if args.bundle:
                    if stat.st_size > 32 << 20:
                        raise ValueError("Bundle exceeds compressed size limit")
                    raw = args.bundle.read_bytes()
                    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as f:
                        doc = f.read((128 << 20) + 1)
                    if len(doc) > 128 << 20:
                        raise ValueError("Expanded bundle exceeds limit")
                    bundle = json.loads(doc)
                    after = args.bundle.stat()
                    if sig != (after.st_mtime_ns, after.st_size):
                        continue
                else:
                    try:
                        bundle = export(sig, args.region, args.market)
                    except (OSError, ValueError, KeyError, IndexError):
                        if sig != fingerprint(args.wow_dir, include_apphelper=not auction_only):
                            continue
                        raise
                    if getattr(args, "require_desktop", False) and not bundle[
                        "snapshot"
                    ].get("estimate_prices"):
                        raise ValueError(
                            f"Waiting for TSM Desktop AppHelper prices for {args.region} / {args.market}."
                        )
                    raw = compress(bundle)
                    if sig != fingerprint(args.wow_dir, include_apphelper=not auction_only):
                        continue
                receipt = request(upload_url, secret, raw, allow_empty=bool(custom_url))
                if (
                    receipt is not None
                    and receipt.get("revision") != bundle["revision"]
                ):
                    raise ValueError("Server acknowledged a different revision")
                status = (receipt or {}).get("status", "uploaded")
                previous = sig
                snap = bundle["snapshot"]
                full_count = len(snap.get("prices", {}))
                checks = {item for capture in bundle.get("targeted", []) for item in capture["listed_units"]}
                summary = f"full-scan items {full_count}, targeted items {len(checks)}"
                if snap.get("estimate_prices"):
                    summary += f", {len(snap['estimate_prices'])} Desktop AppHelper prices"
                print(
                    f"{status} revision {bundle['revision']} · {summary} for {bundle['region']} / {bundle['market']}",
                    flush=True,
                )
            if queue_url and args.wow_dir and addon_path(args.wow_dir).is_dir():
                q = request(queue_url, secret)
                write_queue(args.wow_dir, q, bundle)
        except (OSError, HTTPException, ValueError, KeyError, IndexError) as e:
            if not args.watch:
                raise
            previous = None
            print(e, file=sys.stderr, flush=True)
        if not args.watch:
            return
        time.sleep(args.poll)


def main():
    p = argparse.ArgumentParser(description="Install and synchronize WoW Auction Sync")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("install").add_argument("--wow-dir", required=True, type=Path)
    s = sub.add_parser("sync")
    s.add_argument("--wow-dir", type=Path)
    s.add_argument("--bundle", type=Path)
    target = s.add_mutually_exclusive_group()
    target.add_argument(
        "--server", default="http://127.0.0.1:8765", help="Scanner base URL"
    )
    target.add_argument("--upload-url", help="Full HTTPS upload endpoint (upload only)")
    s.add_argument("--region", default="Forever-US")
    s.add_argument("--market", default="Normal-Alliance")
    s.add_argument("--watch", action="store_true")
    sources = s.add_mutually_exclusive_group()
    sources.add_argument("--auction-house-only", action="store_true",
                         help="Read saved in-game observations and character data; skip TSM price files")
    sources.add_argument(
        "--require-desktop",
        action="store_true",
        help="Wait for a populated AppHelper book before uploading game files",
    )
    s.add_argument("--poll", type=int, default=15)
    args = p.parse_args()
    if args.command == "install":
        install(args.wow_dir)
    else:
        if (not args.wow_dir and not args.bundle) or args.poll < 1:
            p.error("sync needs --wow-dir or --bundle and a positive polling interval")
        sync(args)


if __name__ == "__main__":
    try:
        main()
    except (OSError, HTTPException, ValueError, KeyError, IndexError) as e:
        sys.exit(str(e))
