"""Import WoW Forever lowest buyouts from Booty Bay Broker item pages."""

import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import getpass
from html.parser import HTMLParser
from http.client import HTTPException
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from sync import endpoint, request, token

HOST = "bootybaybroker.com"
LIMIT = 8 << 20
RULESETS = {"Normal": "PvE", "PvP": "PvP", "Roleplay": "RP", "Roleplay PvP": "RP PvP"}
STAMP = re.compile(r"\b[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} UTC\b")


class NoMarketObservation(ValueError):
    pass


class UnsupportedMarket(ValueError):
    pass


def item_url(url):
    parsed = urlsplit(url)
    match = re.fullmatch(r"/forever/item/([1-9][0-9]*)(?:/[a-zA-Z0-9%_-]+)?/?", parsed.path)
    if parsed.scheme != "https" or parsed.netloc != HOST or not match:
        raise ValueError("Use a Booty Bay Broker WoW Forever item-page URL")
    item = int(match[1])
    if item > 0xFFFFFFFF:
        raise ValueError("Invalid item ID")
    return item, parsed.path


def market_label(region, market):
    ruleset, _, faction = market.rpartition("-")
    if region not in ("Forever-US", "Forever-EU") or ruleset not in RULESETS or faction not in ("Alliance", "Horde", "Blackwater"):
        raise UnsupportedMarket(f"Unsupported Booty Bay Broker market: {region} / {market}")
    return f"{region[8:]} {RULESETS[ruleset]} {faction}"


class ItemRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # The site's canonical spelling can differ from the local catalog slug.
        old_id, _ = item_url(req.full_url)
        new_id, path = item_url(newurl)
        if new_id != old_id:
            raise ValueError("Broker redirect changed the item ID")
        canonical = urlunsplit(("https", HOST, path, urlsplit(req.full_url).query, ""))
        return super().redirect_request(req, fp, code, msg, headers, canonical)


class ItemPage(HTMLParser):
    """Read semantic table cells, including hidden text used by the accessible tables."""

    def __init__(self):
        super().__init__()
        self.urls = []
        self.tables = []
        self.table = self.row = self.cell = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "link" and "canonical" in (a.get("rel") or "").lower().split():
            self.urls.append(a.get("href") or "")
        if tag == "meta" and a.get("property") == "og:url":
            self.urls.append(a.get("content") or "")
        if tag == "table":
            self.table = []
            self.tables.append(self.table)
        elif tag == "tr" and self.table is not None:
            self.row = []
            self.table.append(self.row)
        elif tag in ("th", "td") and self.row is not None:
            self.cell = []
            self.row.append(self.cell)
        elif tag == "time" and self.cell is not None and a.get("datetime"):
            self.cell.append(a["datetime"])
        elif tag == "img" and self.cell is not None and a.get("alt"):
            self.cell.append(a["alt"])

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("th", "td", "tr", "table"):
            self.cell = None
        if tag in ("tr", "table"):
            self.row = None
        if tag == "table":
            self.table = None


def copper(text):
    match = re.fullmatch(r"(?:(\d[\d,]*)\s*g(?:old)?\s*)?(?:(\d+)\s*s(?:ilver)?\s*)?(?:(\d+)\s*c(?:opper)?\s*)?", text, re.I)
    if not match or not any(match.groups()):
        raise ValueError(f"Unrecognized lowest buyout: {text!r}")
    value = sum(int((n or "0").replace(",", "")) * unit for n, unit in zip(match.groups(), (10000, 100, 1)))
    if not 0 < value < 2**53:
        raise ValueError("Invalid lowest buyout")
    return value


def observed_at(text):
    last = re.split(r"first seen", text, maxsplit=1, flags=re.I)[0]
    iso = re.search(r"\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)", last)
    if iso:
        return int(datetime.fromisoformat(iso[0].replace("Z", "+00:00")).timestamp())
    stamp = STAMP.search(last)
    if not stamp:
        raise ValueError("Missing absolute Last seen timestamp")
    return int(datetime.strptime(stamp[0], "%b %d, %Y, %H:%M UTC").replace(tzinfo=timezone.utc).timestamp())


def parse_page(html, label, expected=None):
    page = ItemPage()
    page.feed(html)
    page.close()
    ids = {item_url(url)[0] for url in page.urls}
    if expected is not None:
        ids.add(expected)
    if len(ids) != 1:
        raise ValueError("Missing or conflicting WoW Forever item identity")
    item = ids.pop()
    matches = []
    found_table = False
    for table in page.tables:
        rows = [[" ".join(" ".join(cell).split()) for cell in row] for row in table]
        if not rows:
            continue
        headers = [c.lower() for c in rows[0]]
        wanted = ["market", "lowest buyout", "last seen"]
        if not all(headers.count(column) == 1 for column in wanted):
            continue
        found_table = True
        market, price, stamp = (headers.index(column) for column in wanted)
        for row in rows[1:]:
            if len(row) > max(market, price, stamp) and " ".join(row[market].replace(",", " ").split()) == label:
                if row[price].casefold() in {"", "—", "–", "no data", "no listings"}:
                    continue
                matches.append((copper(row[price]), observed_at(row[stamp])))
    if found_table and not matches:
        return item, None
    if len(matches) != 1:
        raise ValueError(f"Item {item}: expected one Prices by market row for {label}; found {len(matches)}")
    price, at = matches[0]
    if not 0 < at <= time.time()+300:
        raise ValueError(f"Item {item}: invalid Last seen timestamp")
    return item, {"price": price, "observed_at": at}


def read_page(stream):
    raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError("Item page exceeds 8 MiB")
    return raw.decode("utf-8-sig")


def collect(args):
    label = market_label(args.region, args.market)
    quotes = {}
    def record(item, quote):
        if item in quotes:
            raise ValueError(f"Duplicate item {item}")
        if quote is None:
            print(f"Item {item}: no observation for {label}", file=sys.stderr)
        else:
            quotes[item] = quote

    if args.html:
        for path in args.html:
            with path.open("rb") as stream:
                record(*parse_page(read_page(stream), label))
    else:
        pages = dict(item_url(url) for url in args.fetch)
        opener = build_opener(ItemRedirect())
        for index, (item, path) in enumerate(pages.items()):
            if index:
                time.sleep(args.delay)
            url = urlunsplit(("https", HOST, path, "region=" + args.region[8:].lower(), ""))
            req = Request(url, headers={"User-Agent": "WoWAuctionMonitor/0.3 (Booty Bay Broker price importer)", "Accept": "text/html"})
            with opener.open(req, timeout=30) as response:
                if response.headers.get_content_type() != "text/html":
                    raise ValueError(f"Item {item}: expected an HTML item page")
                record(*parse_page(read_page(response), label, item))
    if not quotes:
        raise NoMarketObservation(f"No Booty Bay Broker prices found for {label}")
    return {"region": args.region, "market": args.market, "items": quotes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--html", type=Path, nargs="+", metavar="FILE", help="Read saved English item pages locally")
    mode.add_argument("--fetch", nargs="+", metavar="URL", help="Fetch item pages under your written scraping permission from Booty Bay Broker")
    parser.add_argument("--server", default=os.getenv("WOW_SERVER_URL"), help="Bundled scanner base URL")
    parser.add_argument("--region", default=os.getenv("WOW_REGION", "Forever-US"))
    parser.add_argument("--market", default=os.getenv("WOW_MARKET", "Normal-Alliance"))
    parser.add_argument("--preview", action="store_true", help="Print parsed copper prices and observation times without uploading")
    parser.add_argument("--delay", type=int, default=5, help="Seconds between website requests (default 5)")
    parser.add_argument("--watch", action="store_true", help="Repeat an authorized fetch hourly")
    args = parser.parse_args()
    if args.delay < 1 or (args.watch and (args.html or args.preview)):
        parser.error("Use a positive --delay; --watch requires --fetch and an upload")
    if not args.preview:
        if not args.server:
            parser.error("Supply --server or set WOW_SERVER_URL in client.env")
        url = endpoint(args.server) + "/api/bootybay/prices"
        if not (os.getenv("WOW_UPLOAD_TOKEN") or os.getenv("WOW_UPLOAD_TOKEN_FILE")):
            os.environ["WOW_UPLOAD_TOKEN"] = getpass.getpass("API bearer token: ")
        secret = token()
    while True:
        book = collect(args)
        if args.preview:
            print(json.dumps(book, indent=2))
        else:
            receipt = request(url, secret, json.dumps(book).encode(), content_type="application/json")
            print(f"Booty Bay Broker: {receipt['updated']} prices updated for {book['region']} / {book['market']}", flush=True)
        if not args.watch:
            return
        time.sleep(3600)


if __name__ == "__main__":
    try:
        main()
    except NoMarketObservation as error:
        print(error, file=sys.stderr)
        sys.exit(3)
    except UnsupportedMarket as error:
        print(error, file=sys.stderr)
        sys.exit(78)
    except HTTPError as error:
        print(f"Booty Bay Broker HTTP {error.code}: {error.reason}", file=sys.stderr)
        if error.code == 429:
            value = error.headers.get("Retry-After", "")
            try:
                seconds = int(value) if value.isdecimal() else int(parsedate_to_datetime(value).timestamp() - time.time()) + 1
            except (TypeError, ValueError, OverflowError):
                seconds = 3600
            print(max(1, seconds))
            sys.exit(75)
        if error.code in (404, 410):
            sys.exit(65)
        sys.exit(77 if error.code in (401, 403) else 1)
    except ValueError as error:
        print(error, file=sys.stderr)
        sys.exit(65)
    except (OSError, HTTPException) as error:
        sys.exit(str(error))
    except KeyboardInterrupt:
        sys.exit(130)
