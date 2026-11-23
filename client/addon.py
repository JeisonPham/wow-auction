"""Install the bundled WoW Auction Sync files into the selected game client."""

import os
import tempfile
from pathlib import Path


def atomic(path, data):
    f = tempfile.NamedTemporaryFile(dir=path.parent, delete=False)
    try:
        with f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(f.name, path)
    finally:
        Path(f.name).unlink(missing_ok=True)


def addon_path(game):
    return game / "Interface" / "AddOns" / "WowAuctionSync"


def install(game):
    if not game.is_dir():
        raise ValueError("WoW installation folder does not exist")
    dest = addon_path(game)
    root = Path(__file__).resolve().parents[1]
    src = root / "addon" / "WowAuctionSync"
    manifest = src / "WowAuctionSync.toc"
    toc = manifest.read_bytes()
    modules = [
        line.strip() for line in toc.decode("utf-8-sig").splitlines()
        if line.strip().endswith(".lua")
    ]
    sources = [src / name for name in modules]
    sources.extend(
        root / "src" / "data" / name
        for name in ("DWARF-LICENSE.txt", "DISENCHANT-LICENSE.txt", "SOURCES.md")
    )
    # Verify the package before changing the installation. Publish the TOC last.
    files = [(p.name, p.read_bytes()) for p in sources] + [(manifest.name, toc)]
    installed = (dest / manifest.name).is_file()
    changed = False
    dest.mkdir(parents=True, exist_ok=True)
    for name, data in files:
        path = dest / name
        if name == "Queue.lua":
            # The uploader owns the live queue. Only seed it on first installation.
            try:
                with path.open("xb") as file:
                    file.write(data)
            except FileExistsError:
                if not path.is_file():
                    raise
                continue
        else:
            if path.is_file() and path.read_bytes() == data:
                continue
            atomic(path, data)
        changed = True
    if changed:
        print(f"{'Updated' if installed else 'Installed'} WoW Auction Sync in {dest}", flush=True)
    else:
        print(f"WoW Auction Sync is up to date in {dest}", flush=True)
