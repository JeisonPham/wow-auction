"""Read one WoW Forever auction house for the server's planning report."""

import argparse
import base64
from contextlib import closing
from email.utils import formatdate, parsedate_to_datetime
import gzip
from http.client import HTTPException
import json
import os
import sys
import time
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


# Each ruleset index can list all houses. Select by both ruleset and faction.
RULESETS = {
    "PvP": (1, (110, 113, 116)),
    "Normal": (2, (111, 114, 117)),
    "Roleplay": (3, (119, 120, 121)),
    "Roleplay PvP": (15, (123, 124, 125)),
}
FACTIONS = ("Alliance", "Horde", "Blackwater")
MAX = 2**53 - 1


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def scope(region, market):
    region_key = region.removeprefix("Forever-").lower()
    ruleset, _, faction = market.rpartition("-")
    if (not region.startswith("Forever-") or region_key not in ("us", "eu", "kr", "tw")
            or ruleset not in RULESETS or faction not in FACTIONS):
        raise ValueError("Unsupported WoW Forever region, ruleset or faction for Blizzard auctions")
    rule, houses = RULESETS[ruleset]
    return region_key, rule, houses[FACTIONS.index(faction)]


def read_json(response, limit):
    stream = response
    encoding = response.headers.get("Content-Encoding", "").lower()
    if encoding == "gzip":
        stream = gzip.GzipFile(fileobj=response)
    elif encoding not in ("", "identity"):
        raise ValueError("Unsupported Blizzard response encoding")
    raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError("Blizzard response exceeds size limit")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Expected a Blizzard JSON object")
    return data


def positive(value):
    return type(value) is int and 0 < value <= MAX


def collect(items, page, commodities, at, house):
    if not commodities and page.get("id") != house:
        raise ValueError("Blizzard returned a different auction house")
    if commodities and "auctions" not in page and not ("_links" in page or page.get("id") == house):
        raise ValueError("Missing Blizzard commodity listings")
    rows = page.get("auctions", [])
    if not isinstance(rows, list):
        raise ValueError("Invalid Blizzard auctions array")
    lots = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("item"), dict):
            raise ValueError("Invalid Blizzard listing")
        item = row["item"]
        item_id = item["id"]
        if not positive(item_id) or item_id > 2**32 - 1:
            raise ValueError("Invalid Blizzard item ID")
        # The catalog and local scanner price base items. A modified variant has a separate market.
        if item.get("bonus_lists") or item.get("modifiers") or item.get("pet_species_id"):
            continue
        total = row.get("unit_price" if commodities else "buyout")
        if total in (None, 0):
            continue
        quantity = row["quantity"]
        if not positive(total) or not positive(quantity):
            raise ValueError("Invalid Blizzard buyout or quantity")
        units = 1 if commodities else quantity
        levels = lots.setdefault(item_id, {})
        key = (units, total)
        levels[key] = levels.get(key, 0) + (quantity if commodities else 1)
        old = items.get(item_id)
        if (old is None or at > old["at"] or
                (at == old["at"] and total * old["units"] < old["total"] * units)):
            items[item_id] = dict(total=total, units=units, at=at)
    return {item_id: [[size, price, count] for (size, price), count in levels.items()]
            for item_id, levels in lots.items()}


def fetch(region, market, modified, opener):
    host, rule, house = scope(region, market)
    client_id = os.getenv("WOW_BLIZZARD_CLIENT_ID", "").strip()
    client_secret = os.getenv("WOW_BLIZZARD_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise ValueError("Set both WOW_BLIZZARD_CLIENT_ID and WOW_BLIZZARD_CLIENT_SECRET")
    credentials = (client_id + ":" + client_secret).encode()
    auth = Request("https://oauth.battle.net/token", data=b"grant_type=client_credentials",
                   headers={"Authorization": "Basic " + base64.b64encode(credentials).decode("ascii")})
    with opener.open(auth, timeout=30) as response:
        token = read_json(response, 65536).get("access_token")
    if not isinstance(token, str) or not token.isascii() or not token.isprintable() or not token.strip():
        raise ValueError("Blizzard did not return a usable access token")
    stamps = list(modified)
    items = {}
    depth = [None, None]
    for index, suffix in enumerate(("", "/commodities")):
        url = (f"https://{host}.api.blizzard.com/data/wow/ruleset/{rule}/auctions/{house}{suffix}"
               f"?namespace=dynamic-forever-{host}")
        headers = {"Authorization": "Bearer " + token, "Accept-Encoding": "gzip"}
        if modified[index]:
            headers["If-Modified-Since"] = formatdate(modified[index], usegmt=True)
        try:
            response = opener.open(Request(url, headers=headers), timeout=90)
        except HTTPError as error:
            if error.code != 304 or not modified[index]:
                raise
            error.close()
            continue
        with closing(response):
            stamp = response.headers.get("Last-Modified")
            if not stamp:
                raise ValueError("Blizzard snapshot has no Last-Modified timestamp")
            at = int(parsedate_to_datetime(stamp).timestamp())
            if at < modified[index] or not 0 < at <= time.time() + 300:
                raise ValueError("Invalid or older Blizzard snapshot timestamp")
            depth[index] = collect(items, read_json(response, 128 << 20), bool(index), at, house)
            stamps[index] = at
    return dict(region=region, market=market, modified=stamps, items=items, depth=depth)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("region")
    parser.add_argument("market")
    parser.add_argument("modified", nargs=2, type=int)
    args = parser.parse_args()
    try:
        book = fetch(args.region, args.market, args.modified, build_opener(NoRedirect()))
    except HTTPError as error:
        # Error bodies and request headers can contain credentials.
        print(f"Blizzard returned HTTP {error.code}", file=sys.stderr)
        if error.code in (429, 503):
            retry = error.headers.get("Retry-After", "")
            if retry:
                try:
                    seconds = int(retry) if retry.isdecimal() else int(parsedate_to_datetime(retry).timestamp() - time.time())
                    print(max(0, seconds))
                except (ValueError, TypeError, OverflowError):
                    pass
            return 75
        return 1
    except (OSError, ValueError, TypeError, KeyError, EOFError, HTTPException, OverflowError) as error:
        message = str(error) if type(error) is ValueError else type(error).__name__
        print(f"Blizzard request failed: {message}", file=sys.stderr)
        return 1
    json.dump(book, sys.stdout, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
