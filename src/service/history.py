"""Market-local SQLite archive. Invoked by the server with validated observations or item IDs."""
import bisect
import json
import math
import sqlite3
from contextlib import closing
import sys
import time

HOUR = 3600
KEEP_HOURS = 28 * 24
MAX = (1 << 53) - 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS prices (
 item INTEGER, hour INTEGER, at INTEGER, source INTEGER, unit REAL,
 PRIMARY KEY(item,hour)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS prices_hour ON prices(hour);
CREATE TABLE IF NOT EXISTS depth (
 item INTEGER, hour INTEGER, at INTEGER, source INTEGER, available INTEGER, lots TEXT,
 PRIMARY KEY(item,hour)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS depth_hour ON depth(hour);
"""


def store(db, samples, first):
    # At equal times the scanner's source precedence decides. A repeat replaces the
    # same row, so rereading a saved snapshot never contributes an extra day.
    prices, depth = [], []
    for item, at, source, total, units, available, lots in samples:
        hour = at // HOUR
        if hour < first:
            continue
        if total and units:
            prices.append((item, hour, at, source, total / units))
        if available is not None:
            depth.append((item, hour, at, source, available,
                          json.dumps(lots, separators=(",", ":")) if lots else None))
    for table, rows, values in (("prices", prices, "unit=excluded.unit"),
                                ("depth", depth, "available=excluded.available,lots=excluded.lots")):
        db.execute(f"DELETE FROM {table} WHERE hour < ?", (first,))
        if rows:
            params = ",".join("?" for _ in rows[0])
            db.executemany(f"INSERT INTO {table} VALUES ({params}) ON CONFLICT(item,hour) DO UPDATE SET "
                           f"at=excluded.at,source=excluded.source,{values} "
                           f"WHERE (excluded.at,excluded.source) >= ({table}.at,{table}.source)", rows)


def budget(lots, available, need, floor, price):
    if available is not None and need > available:
        return None
    if not lots:
        return None if price is None or price * need > MAX else math.ceil(price * need)
    # The archive stores the same ordered cumulative price levels as the dashboard.
    levels = json.loads(lots)
    rank = max(need, (available * floor + 99) // 100)
    _, total, size = levels[bisect.bisect_left(levels, [rank])]
    value = (need * total + size - 1) // size
    return value if value <= MAX else None


def fetch(db, query, first, last):
    result = {}
    coverage = {hour: (at, source) for hour, at, source in db.execute(
        "SELECT hour,at,source FROM depth WHERE item=0 AND hour BETWEEN ? AND ?", (first, last))}
    for item, need in query["items"]:
        key = (item, first, last)
        prices = dict(db.execute("SELECT hour,unit FROM prices WHERE item=? AND hour BETWEEN ? AND ?", key))
        depths = {hour: (at, source, available, lots) for hour, at, source, available, lots in db.execute(
            "SELECT hour,at,source,available,lots FROM depth WHERE item=? AND hour BETWEEN ? AND ?", key)}
        rows = []
        for hour in sorted(prices.keys() | depths.keys() | coverage.keys()):
            at, source, available, lots = depths.get(hour, (0, 0, None, None))
            if coverage.get(hour, (0, 0)) > (at, source):
                available, lots = 0, None
            unit = prices.get(hour)
            if available == 0:
                rows.append([hour * HOUR, None, None])
                continue
            purchase = (budget(lots, available, need, query["floor"], unit)
                        if query["floor"] is not None else (None if unit is None or need * unit > MAX else math.ceil(need * unit)))
            rows.append([hour * HOUR, unit, purchase])
        result[item] = rows
    return dict(days=28, timezone="UTC", items=result)


def main():
    mode, path = sys.argv[1:]
    payload = json.load(sys.stdin)
    end = int(time.time()) // HOUR
    first = end - KEEP_HOURS + 1
    with closing(sqlite3.connect(path, timeout=10)) as db, db:
        db.executescript(SCHEMA)
        if mode == "record":
            store(db, payload, first)
        else:
            db.execute("BEGIN")
            print(json.dumps(fetch(db, payload, first, end), separators=(",", ":")))


if __name__ == "__main__":
    main()
