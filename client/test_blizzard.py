import gzip
import io
import json
import unittest
from email.utils import formatdate
from unittest.mock import Mock, patch
from urllib.error import HTTPError

import blizzard


def response(data, at=None, compressed=False):
    body = json.dumps(data).encode()
    stream = io.BytesIO(gzip.compress(body) if compressed else body)
    stream.headers = {}
    if compressed:
        stream.headers["Content-Encoding"] = "gzip"
    if at:
        stream.headers["Last-Modified"] = formatdate(at, usegmt=True)
    return stream


class BlizzardTests(unittest.TestCase):
    def test_all_market_routes(self):
        for ruleset, rule, expected in [
            ("Normal", 2, (111, 114, 117)), ("PvP", 1, (110, 113, 116)),
            ("Roleplay", 3, (119, 120, 121)), ("Roleplay PvP", 15, (123, 124, 125)),
        ]:
            for faction, house in zip(("Alliance", "Horde", "Blackwater"), expected):
                self.assertEqual(blizzard.scope("Forever-EU", ruleset + "-" + faction), ("eu", rule, house))
        for region, market in [("Retail-US", "Normal-Alliance"), ("Forever-US", "Hardcore-Alliance")]:
            with self.assertRaises(ValueError):
                blizzard.scope(region, market)

    @patch.dict("os.environ", WOW_BLIZZARD_CLIENT_ID="test", WOW_BLIZZARD_CLIENT_SECRET="secret")
    def test_requests_pricing_and_conditional_timestamps(self):
        regular = {"id": 111, "auctions": [
            {"item": {"id": 1}, "quantity": 2, "buyout": 31},
            {"item": {"id": 1}, "quantity": 5, "buyout": 81},
            {"item": {"id": 1}, "quantity": 2, "buyout": 31},
            {"item": {"id": 1, "bonus_lists": [7]}, "quantity": 1, "buyout": 1},
            {"item": {"id": 2}, "quantity": 1, "bid": 1},
            {"item": {"id": 3}, "quantity": 10, "buyout": 40},
        ]}
        commodities = {"auctions": [{"item": {"id": 3}, "quantity": 150, "unit_price": 21}]}
        opener = Mock()
        opener.open.side_effect = [response({"access_token": "fake-token"}), response(regular, 150),
                                   response(commodities, 180, compressed=True)]
        book = blizzard.fetch("Forever-US", "Normal-Alliance", (0, 0), opener)
        self.assertEqual(book["modified"], [150, 180])
        self.assertEqual(book["items"], {1: dict(total=31, units=2, at=150), 3: dict(total=21, units=1, at=180)})
        self.assertEqual(book["depth"], [{1: [[2, 31, 2], [5, 81, 1]], 3: [[10, 40, 1]]},
                                         {3: [[1, 21, 150]]}])
        login, auctions, goods = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual(login.full_url, "https://oauth.battle.net/token")
        self.assertEqual(login.get_header("Authorization"), "Basic dGVzdDpzZWNyZXQ=")
        self.assertEqual(login.data, b"grant_type=client_credentials")
        for req, suffix in [(auctions, ""), (goods, "/commodities")]:
            self.assertEqual(req.full_url, "https://us.api.blizzard.com/data/wow/ruleset/2/auctions/111"
                             + suffix + "?namespace=dynamic-forever-us")
            self.assertEqual(req.get_header("Authorization"), "Bearer fake-token")
        opener.open.side_effect = [response({"access_token": "fake-token"}),
                                   HTTPError(auctions.full_url, 304, "", {}, None),
                                   response({"auctions": []}, 200)]
        next_book = blizzard.fetch("Forever-US", "Normal-Alliance", (150, 180), opener)
        self.assertEqual((next_book["modified"], next_book["items"]), ([150, 200], {}))
        self.assertEqual(next_book["depth"], [None, {}])
        calls = opener.open.call_args_list
        for call, at in zip(calls[-2:], (150, 180)):
            self.assertEqual(call.args[0].get_header("If-modified-since"), formatdate(at, usegmt=True))

    @patch.dict("os.environ", WOW_BLIZZARD_CLIENT_ID="test", WOW_BLIZZARD_CLIENT_SECRET="secret")
    def test_missing_timestamp_or_wrong_house_rejected(self):
        for page in [response({"id": 111}), response({"id": 113}, 200)]:
            opener = Mock()
            opener.open.side_effect = [response({"access_token": "token"}), page]
            with self.assertRaises(ValueError):
                blizzard.fetch("Forever-US", "Normal-Alliance", (0, 0), opener)
