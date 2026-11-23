import io
from email.message import Message
from types import SimpleNamespace
import unittest
from urllib.request import Request
from unittest.mock import patch

from broker import ItemRedirect, collect, copper, item_url, market_label, parse_page


URL = "https://bootybaybroker.com/forever/item/14047/runecloth"
HTML = f'''<link rel="canonical" href="{URL}"><table><tr><th>Day</th><th>Average</th></tr>
<tr><td>Nov 23</td><td>90g</td></tr></table>
<table><caption>Prices by market</caption><tr>
<th>Market</th><th>Lowest buyout</th><th>Listings</th><th>Last seen</th></tr>
<tr><td><span>US PvE</span> Alliance</td><td><span>4</span>s <span>92</span>c</td><td>358</td>
<td>Nov 23, 2025, 06:05 UTC <small>First seen Nov 7, 2025, 14:21 UTC</small></td></tr>
<tr><td>EU RP PvP Horde</td><td>2g 1s 9c</td><td>1</td>
<td><time datetime="2025-11-23T06:05:00Z">a day ago</time></td></tr></table>'''


class BrokerTests(unittest.TestCase):
    def test_redirect_to_canonical_slug_keeps_the_item_and_region(self):
        handler = ItemRedirect()
        original = Request("https://bootybaybroker.com/forever/item/14047?region=eu")
        def redirect(url):
            return handler.redirect_request(original, None, 301, "", {}, url)
        self.assertEqual(redirect(URL).full_url, URL + "?region=eu")
        for url in (URL.replace("14047", "2840"), URL.replace("broker.com", "broker.invalid"),
                    URL.replace("https:", "http:"), URL.replace("forever", "retail")):
            with self.assertRaises(ValueError):
                redirect(url)

    def test_market_date_and_copper(self):
        us = market_label("Forever-US", "Normal-Alliance")
        eu = market_label("Forever-EU", "Roleplay PvP-Horde")
        item, quote = parse_page(HTML, us)
        self.assertEqual(item, 14047)
        self.assertEqual(quote, {"price": 492, "observed_at": 1763877900})
        self.assertEqual(parse_page(HTML, eu)[1], dict(quote, price=20109))
        self.assertEqual(parse_page(HTML, "US PvP Horde"), (item, None))
        self.assertEqual(copper("1,234g 2c"), 12340002)
        for html in (HTML.replace("Lowest buyout", "Average"), HTML.replace("4</span>s", "-4</span>s"),
                     HTML.replace("Nov 23, 2025, 06:05 UTC", "Yesterday")):
            with self.assertRaises(ValueError):
                parse_page(html, us)
        with self.assertRaises(ValueError):
            parse_page(HTML, us, expected=2840)
        for url in (URL.replace("/forever/", "/retail/"), URL.replace(".com/", ".com.example.org/")):
            with self.assertRaises(ValueError):
                item_url(url)

    def test_fetch_uses_public_page_url_and_no_upload_credentials(self):
        args = SimpleNamespace(region="Forever-EU", market="Roleplay PvP-Horde", html=None,
                               fetch=[URL, URL], delay=1)
        response = io.BytesIO(HTML.encode())
        response.headers = Message()
        response.headers["Content-Type"] = "text/html"
        with patch("broker.build_opener") as opener:
            opener.return_value.open.return_value = response
            result = collect(args)
        req = opener.return_value.open.call_args.args[0]
        self.assertEqual(req.full_url, URL + "?region=eu")
        self.assertFalse(req.has_header("Authorization"))
        self.assertEqual(result["items"][14047]["price"], 20109)
        opener.return_value.open.assert_called_once()
