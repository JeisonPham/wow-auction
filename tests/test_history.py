import importlib.util
import sqlite3
from contextlib import closing
import unittest
from pathlib import Path

module = importlib.util.spec_from_file_location(
    "price_archive", Path(__file__).resolve().parents[1] / "src/service/history.py")
history = importlib.util.module_from_spec(module)
module.loader.exec_module(history)


class HourlyArchiveTests(unittest.TestCase):
    def test_retention_repeated_snapshots_source_priority_and_coverage(self):
        with closing(sqlite3.connect(":memory:")) as db, db:
            db.executescript(history.SCHEMA)
            h = 3600
            def record(samples, first=10):
                history.store(db, samples, first)
            def quote(need=1):
                return history.fetch(db, {"items": [[1, need]], "floor": 0}, 10, 20)["items"][1]
            # Latest observed scalar and latest order book may come from different sources.
            record([(1, 10*h, 3, 7, 2, 4, [[4, 7, 2]]),
                    (1, 10*h+3, 2, 80, 1, None, []),
                    (1, 10*h+3, 1, 90, 1, None, [])])
            self.assertEqual(quote(3), [[10*h, 80, 11]])
            self.assertEqual(quote(5), [[10*h, 80, None]])
            # A full scan includes items absent from the auction house.
            record([(0, 10*h+5, 4, 0, 0, 0, []), (0, 11*h, 4, 0, 0, 0, [])])
            self.assertEqual(quote(), [[10*h, None, None], [11*h, None, None]])
            later = (1, 10*h+5, 5, 4, 1, 1, [[1, 4, 1]])
            record([later, later])
            self.assertEqual(quote()[0], [10*h, 4, 4])
            record([(1, 9*h, 5, 1, 1, None, [])], first=11)
            self.assertEqual(db.execute("SELECT count(*) FROM prices").fetchone()[0], 0)
            self.assertEqual(quote(), [[11*h, None, None]])
