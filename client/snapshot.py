import gzip
import json
import re

from disenchant import import_tables
from lua_data import array, named_table


SAVED_DATABASES = {
    "wowauctionsync.lua": "WowAuctionSyncDB",
    "wowauctionmonitor.lua": "WowAuctionMonitorDB",
}


def inputs(game):
    addons = game / "Interface" / "AddOns"
    files = set()
    files.update(
        p
        for p in game.glob("WTF/Account/*/SavedVariables/*")
        if p.name.lower() in SAVED_DATABASES and p.is_file()
    )
    files.update((addons / "TradeSkillMaster_AppHelper").rglob("AppData*.lua"))
    base = addons / "TradeSkillMaster" / "LibTSMData"
    files.update(
        p
        for p in (
            base / "Destroy" / "Disenchant.lua",
            base / "Item" / "NonDisenchantable.lua",
        )
        if p.is_file()
    )
    return sorted(files)


def fingerprint(game):
    result = []
    for path in inputs(game):
        s = path.stat()
        result.append((path, s.st_mtime_ns, s.st_size))
    return tuple(result)


def apphelper(text, region, market, filename=""):
    # Desktop writes one LoadData call inside a loop for connected markets.
    # Resolve its literal realm list without executing the surrounding Lua.
    shared = r'for\s+_,\s*(\w+)\s+in\s+ipairs\(\s*\{([^{}]*)\}\s*\)\s+do\s+select\(2,\s*\.\.\.\)\.LoadData\(\s*"AUCTIONDB_NON_COMMODITY_DATA"\s*,\s*\1\s*,'
    scopes = {market, region + "/" + market, region + "-" + market}

    def resolve_shared(entry):
        matching = next(
            (s for s in re.findall(r'"([^"]+)"', entry[2]) if s in scopes), None
        )
        return (
            f'LoadData("AUCTIONDB_NON_COMMODITY_DATA","{matching}",'
            if matching
            else entry[0]
        )

    text = re.sub(shared, resolve_shared, text)
    pattern = r'LoadData\s*\(\s*"AUCTIONDB_NON_COMMODITY_DATA"\s*,\s*"([^"]+)"\s*,\s*(?:"([^"]+)"\s*,\s*)?\[(=*)\[(.*?)\]\3\]'
    best = (0, {})
    for scope, secondary, _, body in re.findall(pattern, text, re.DOTALL):
        if secondary:
            if [scope, secondary] not in ([region, market], [market, region]):
                continue
        elif scope not in (market, region + "/" + market, region + "-" + market):
            continue
        explicit = re.findall(
            r"Forever[-/](US|EU|KR|TW|CN)\b", filename + " " + scope, re.IGNORECASE
        )
        if any(r.upper() != region.split("-")[-1].upper() for r in explicit):
            continue

        def get(pattern, payload=body):
            match = re.search(pattern, payload)
            if not match:
                raise ValueError("Incomplete AppHelper realm book")
            return match[1]

        at = int(get(r"downloadTime\s*=\s*(\d+)"))
        fields = re.findall(r'"(\w+)"', get(r"fields\s*=\s*\{([^}]*)"))
        cols = [
            fields.index(k) for k in ("itemString", "marketValueRecent", "numAuctions")
        ]
        data = get(r"(?s)data\s*=\s*\{(.*)\}\s*[,;]?\s*\}")
        book = {}
        for row in re.findall(r"\{([^{}]+)\}", data):
            cells = [s.strip().strip('"') for s in row.split(",")]
            item, price, count = (cells[n] for n in cols)
            m = re.fullmatch(r"(?:i:)?([1-9]\d*)", item)
            if not m:
                continue
            key = m[1]
            if key in book:
                raise ValueError("Repeated AppHelper item")
            if int(price, 32) > 0:
                book[key] = dict(
                    total_buyout=int(price, 32),
                    auctions=int(count, 32),
                    units=1,
                    observed_at=at,
                )
        if at > best[0]:
            best = at, book
    return best


def prices(rec):
    at = rec["capturedAt"]
    book = {}
    for k, v in rec.get("items", {}).items():
        entry = dict(total_buyout=v["totalBuyout"], units=v["quantity"],
                     auctions=v["auctions"], observed_at=at)
        if "lots" in v:
            entry["lots"] = sorted(
                [size, price, count]
                for size, levels in v["lots"].items()
                for price, count in levels.items()
            )
        book[str(k)] = entry
    return book


def pack_checks(observations, full_time):
    """Keep per-search ages, including empty results, in the existing REST format."""
    times = sorted({at for at, _ in observations.values()})
    stamp = {at: at for at in times}
    if len(times) > 128:
        # Coalesce older observations conservatively. Keep the newest exact for
        # revision comparisons, and never move a newer check behind a full scan.
        size = (len(times) + 124) // 125
        for side in ([at for at in times[:-1] if at < full_time],
                     [at for at in times[:-1] if at >= full_time]):
            for i, at in enumerate(side):
                stamp[at] = side[i // size * size]
    groups = {}
    for item, (observed, price) in observations.items():
        at = stamp[observed]
        group = groups.setdefault(at, dict(captured_at=at, prices={}, listed_units={}))
        group["listed_units"][item] = price["units"] if price else 0
        if price:
            group["prices"][item] = dict(price, observed_at=at)
    return [groups[at] for at in sorted(groups, reverse=True)]


def export(files, region, market):
    snap = dict(
        items={},
        professions={},
        character_levels={},
        complete_rosters=[],
        recipes=[],
        recipe_requirements={},
    )
    maximum_yields = {}
    checks, recipes, conflicts, tables = {}, {}, set(), {}
    observations = {}
    per_item_times = False
    saved_path = None
    for path, _, _ in sorted(files, key=lambda f: (f[1], f[0])):
        text = path.read_text(encoding="utf-8-sig")
        if path.name.startswith("AppData"):
            at, book = apphelper(text, region, market, str(path))
            if at > snap.get("estimate_at", 0):
                snap.update(estimate_at=at, estimate_prices=book)
            continue
        if path.name in ("Disenchant.lua", "NonDisenchantable.lua"):
            tables[path.name] = text
            continue
        saved_path = path
        name = SAVED_DATABASES[path.name.lower()]
        db = named_table(text, name)
        if db is None:
            # An unused account can have only comments, whitespace, or a nil assignment.
            content = re.sub(r"--[^\n]*", "", text).strip()
            if not content or re.fullmatch(re.escape(name) + r"\s*=\s*nil\s*;?", content):
                continue
            raise ValueError(f"Expected the saved table {name} in {path}.")
        if not db:
            continue
        if db.get("version") != 1:
            raise ValueError(f"Unsupported SavedVariables version in {path}")
        if db.get("local_scan_failed") or db.get("warnings"):
            raise ValueError("Saved scan contains warnings")
        full = db.get("markets", {}).get(market, {})
        if (
            full.get("region") == region
            and full.get("complete", True)
            and full["capturedAt"] >= snap.get("newest_price_at", 0)
        ):
            snap.update(newest_price_at=full["capturedAt"], prices=prices(full))
        rec = db.get("targeted", {}).get(market, {})
        if rec.get("region") == region and rec.get("complete") is True:
            p = prices(rec)
            stamps = rec.get("checkedAt", {})
            per_item_times |= bool(stamps)
            for key, checked in rec["checked"].items():
                if checked:
                    at = stamps.get(key, rec["capturedAt"])
                    item = str(key)
                    if item not in observations or at >= observations[item][0]:
                        observations[item] = at, p.get(item)
            if not stamps:
                cap = dict(
                    captured_at=rec["capturedAt"],
                    prices=p,
                    listed_units={
                        str(k): p.get(str(k), {}).get("units", 0)
                        for k, v in rec["checked"].items()
                        if v
                    },
                )
                checks[json.dumps(cap, sort_keys=True)] = cap
        profile = db.get("profiles", {}).get(region + "/" + market, {})
        for k, meta in profile.get("itemInfo", {}).items():
            snap["items"][str(k)] = meta
        for char, c in profile.get("characters", {}).items():
            if c.get("completeRoster"):
                snap["professions"][char] = {}
                if char not in snap["complete_rosters"]:
                    snap["complete_rosters"].append(char)
            snap["professions"].setdefault(char, {}).update(c.get("professions", {}))
            snap["character_levels"][char] = c.get("level", 0)
            for profession, group in c.get("recipes", {}).items():
                for r in group.values():
                    rid = str(r["id"])
                    if r.get("quantity_max") is not None:
                        maximum = r["quantity_max"]
                        if maximum_yields.setdefault(rid, maximum) != maximum:
                            conflicts.add(rid)
                    recipe = {k: r[k] for k in ("name", "output", "quantity")}
                    recipe.update(
                        id=rid, mats=sorted(array(m) for m in array(r["mats"]))
                    )
                    req = r.get("requirements", {"profession": profession})
                    if rid in recipes and (
                        recipes[rid][0] != recipe or recipes[rid][1] != req
                    ):
                        conflicts.add(rid)
                    else:
                        recipes.setdefault(rid, (recipe, req, set()))[2].add(char)
    for rid, (recipe, req, chars) in sorted(recipes.items()):
        if rid not in conflicts:
            if rid in maximum_yields:
                recipe["quantity_max"] = maximum_yields[rid]
            snap["recipes"].append(dict(recipe, characters=sorted(chars)))
            snap["recipe_requirements"][rid] = req
    if len(tables) == 2:
        snap.update(
            import_tables(tables["Disenchant.lua"], tables["NonDisenchantable.lua"])
        )
    if saved_path and not (
        snap.get("newest_price_at")
        or checks
        or observations
        or snap["character_levels"]
        or snap["items"]
        or snap.get("estimate_prices")
    ):
        raise ValueError(
            f"Waiting for in-game data for {region} / {market}. Checked {saved_path}. "
            "Enable WoW Auction Sync, run "
            "/wamsync roster or finish /wamsync full, then /reload in WoW."
        )
    if not files:
        raise ValueError(
            "Waiting for TSM AppHelper to sync, or for an in-game /reload after a roster or scan."
        )
    if all(path.name.startswith("AppData") for path, _, _ in files) and not snap.get(
        "estimate_prices"
    ):
        raise ValueError(
            f"Waiting for Desktop AppHelper prices for {region} / {market}."
        )
    revision = max(f[1] for f in files) // 1000
    return dict(
        version=1,
        region=region,
        market=market,
        revision=revision,
        snapshot=snap,
        targeted=(pack_checks(observations, snap.get("newest_price_at", 0)) if per_item_times
                  else sorted(checks.values(), key=lambda c: -c["captured_at"])[:128]),
    )


def compress(bundle):
    return gzip.compress(
        json.dumps(bundle, sort_keys=True, separators=(",", ":")).encode(), mtime=0
    )
