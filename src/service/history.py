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
 item INTEGER, hour INTEGER, at INTEGER, source INTEGER, available INTEGER, lots TEXT, listings INTEGER,
 PRIMARY KEY(item,hour)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS depth_hour ON depth(hour);
"""


def store(db, samples, first):
    # At equal times the scanner's source precedence decides. A repeat replaces the
    # same row, so rereading a saved snapshot never contributes an extra day.
    prices, depth = [], []
    for item, at, source, total, units, available, lots, *counts in samples:
        hour = at // HOUR
        if hour < first:
            continue
        if total and units:
            prices.append((item, hour, at, source, total / units))
        if available is not None:
            depth.append((item, hour, at, source, available,
                          json.dumps(lots, separators=(",", ":")) if lots else None,
                          counts[0] if counts else (0 if available == 0 else None)))
    for table, rows, values in (("prices", prices, "unit=excluded.unit"),
                                ("depth", depth, "available=excluded.available,lots=excluded.lots,listings=excluded.listings")):
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


def archive(db, items, first, last):
    """One sparse market read. Complete-scan empty hours are shared by all items."""
    db.execute("CREATE TEMP TABLE selected(id INTEGER PRIMARY KEY)")
    db.executemany("INSERT INTO selected VALUES (?)", ((item,) for item in items))
    coverage = {h: (at, src) for h, at, src in db.execute(
        "SELECT hour,at,source FROM depth WHERE item=0 AND hour BETWEEN ? AND ?", (first, last))}
    samples = {}
    # Identical price ladders are common across hourly checks. Keep each ladder once per item.
    levels_by_item, ladder_indices = {}, {}
    for item, hour, unit in db.execute(
            "SELECT item,hour,unit FROM selected JOIN prices ON item=id WHERE hour BETWEEN ? AND ?",
            (first, last)):
        samples.setdefault(item, {})[hour] = [hour*HOUR, unit, None, None, None]
    for item, hour, at, source, units, lots, listings in db.execute(
            "SELECT item,hour,at,source,available,lots,listings FROM selected JOIN depth ON item=id "
            "WHERE hour BETWEEN ? AND ?", (first, last)):
        row = samples.setdefault(item, {}).setdefault(hour, [hour*HOUR, None, None, None, None])
        if coverage.get(hour, (0, 0)) > (at, source):
            units, lots, listings = 0, None, 0
            at, source = coverage[hour]
        index = None
        if lots:
            indices = ladder_indices.setdefault(item, {})
            books = levels_by_item.setdefault(item, [])
            if lots not in indices:
                indices[lots] = len(books)
                books.append(json.loads(lots))
            index = indices[lots]
        row[2:] = [units, 0 if units == 0 else listings, index, at, source]
    for hours in samples.values():
        for hour, row in hours.items():
            if hour in coverage and row[2] is None:
                row[5:] = coverage[hour]
                row[2] = 0
            if row[2] == 0:
                row[1:5] = [None, 0, 0, None]
    return {"coverage": sorted(h*HOUR for h in coverage), "level_books": levels_by_item,
            "coverage_depth": [[h*HOUR, *observation] for h, observation in sorted(coverage.items())],
            "items": {item: [row for hour, row in sorted(hours.items())
                             if row[2] != 0 or tuple(row[5:]) != coverage.get(hour)] for item, hours in samples.items()}}


def migrate(db):
    db.executescript(SCHEMA)
    if "listings" not in {col[1] for col in db.execute("PRAGMA table_info(depth)")}:
        # An archive made before counts were recorded still knows its prices and listed units.
        db.execute("BEGIN IMMEDIATE")
        if "listings" not in {col[1] for col in db.execute("PRAGMA table_info(depth)")}:
            db.execute("ALTER TABLE depth ADD COLUMN listings INTEGER")
        db.commit()


def main():
    mode, path = sys.argv[1:]
    payload = json.load(sys.stdin)
    end = int(time.time()) // HOUR
    first = end - KEEP_HOURS + 1
    with closing(sqlite3.connect(path, timeout=10)) as db, db:
        migrate(db)
        if mode == "record":
            store(db, payload, first)
        else:
            db.execute("BEGIN")
            data = archive(db, payload, first, end) if mode == "archive" else fetch(db, payload, first, end)
            json.dump(data, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
