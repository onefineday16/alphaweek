import datetime as dt
import http.client
import json
import pathlib
import tempfile
import threading
import unittest
from unittest import mock

import radar as r


def rss(host="www.infoquest.co.th", title="PTT ลงทุนโครงการใหม่", description="รายได้เพิ่มและขยายธุรกิจ", hours=1):
    when = (r.now() - dt.timedelta(hours=hours)).strftime("%a, %d %b %Y %H:%M:%S +0000")
    return f"<?xml version='1.0'?><rss><channel><item><title>{title}</title><link>https://{host}/story/1</link><description>{description}</description><pubDate>{when}</pubDate></item></channel></rss>".encode()


def universe_payload():
    return {"status":"ok", "answer":[
        {"symbol":"AOT", "description":"AOT_AIRPORTS OF THAILAND", "path":"SET\\Common Stock\\AOT", "category":"COMMON_STOCK", "currency":"THB", "volumeStep":100},
        {"symbol":"PTT", "description":"PTT_PTT PUBLIC COMPANY LIMITED", "path":"SET\\Common Stock\\PTT", "category":"COMMON_STOCK", "currency":"THB", "volumeStep":"100"},
        {"symbol":"ADB", "description":"ADB_APPLIED DB", "path":"MAI\\Common Stock\\ADB", "category":"COMMON_STOCK", "currency":"THB", "volumeStep":100},
        {"symbol":"AOT-W1", "description":"AOT-W1_WARRANT", "path":"SET\\Warrant\\AOT-W1", "category":"WARRANT", "currency":"THB"},
        {"symbol":"USD", "description":"USD_TEST", "path":"SET\\Common Stock\\USD", "category":"COMMON_STOCK", "currency":"USD"}
    ]}


def tick(symbol="PTT", last="41", at=None, **extra):
    row = {"symbol":symbol, "last":last, "bid":"40.75", "ask":"41.25", "datetime":str(int((at or r.now()).timestamp()))}
    row.update(extra)
    return row


def chart_payload(days=4, symbol="PTT"):
    rows = []
    base = r.now().astimezone(r.BKK).replace(hour=10, minute=0, second=0, microsecond=0)
    for index in range(days):
        moment = base - dt.timedelta(days=days - index - 1)
        price = 38 + index
        rows.extend([
            {"datetime":int(moment.timestamp()), "open":price, "high":price + 1, "low":price - .5, "close":price + .25},
            {"datetime":int((moment + dt.timedelta(hours=4)).timestamp()), "open":price + .25, "high":price + 1.5, "low":price, "close":price + .75}
        ])
    return {"status":"ok", "answer":rows}


class RadarTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def store(self, fetcher=lambda url: b""):
        return r.Store(self.temp.name, fetcher=fetcher)

    def provider(self, url):
        if "/v1/market/symbols" in url:
            return json.dumps(universe_payload()).encode()
        if "/v1/market/tick" in url:
            query = __import__("urllib.parse").parse.urlsplit(url).query
            symbols = __import__("urllib.parse").parse.parse_qs(query)["symbol"][0].split(",")
            return json.dumps({"status":"ok", "answer":[tick(symbol, str(41 + index)) for index, symbol in enumerate(symbols)]}).encode()
        if "/v1/market/chart" in url:
            return json.dumps(chart_payload()).encode()
        if "infoquest" in url:
            return rss()
        if "thaipr" in url:
            return rss("www.thaipr.net", "AOT เปิดเส้นทางใหม่", "ท่องเที่ยวฟื้น")
        raise AssertionError(url)

    def test_symbol_validation_is_strict_but_not_seed_limited(self):
        self.assertEqual(r.unique_symbols(["ptt", "ADB", "PTT"], 20), ["PTT", "ADB"])
        for values in [[], ["PTT&x=1"], ["A" * 17], ["หุ้น"]]:
            with self.assertRaisesRegex(r.DataError, "INVALID_SYMBOLS"):
                r.unique_symbols(values, 20)

    def test_feed_is_recent_safe_and_tagged(self):
        rows = r.parse_feed(rss(), r.FEEDS[0])
        self.assertEqual(rows[0]["symbols"], ["PTT"])
        self.assertEqual(rows[0]["signal"], "catalyst")
        self.assertLessEqual(len(rows[0]["title"] + rows[0]["excerpt"]), 200)
        with self.assertRaisesRegex(r.DataError, "UNSAFE_XML"):
            r.parse_feed(b"<!DOCTYPE rss><rss></rss>", r.FEEDS[0])

    def test_market_snapshot_validation(self):
        accepted, errors = r.validate_market_quotes({"status":"ok", "answer":[tick()]}, ["PTT"])
        self.assertFalse(errors)
        self.assertEqual(accepted["PTT"]["last"], 41)
        self.assertNotIn("volume", accepted["PTT"])
        for row in [tick(last="0"), tick(datetime=None), tick(bid="42", ask="41")]:
            accepted, errors = r.validate_market_quotes({"status":"ok", "answer":[row]}, ["PTT"])
            self.assertFalse(accepted)
            self.assertIn("PTT", errors)

    def test_universe_filters_to_set_and_mai_common_stock(self):
        rows = r.validate_universe(universe_payload())
        self.assertEqual(set(rows), {"AOT", "PTT", "ADB"})
        self.assertEqual(rows["AOT"]["name"], "AIRPORTS OF THAILAND")
        self.assertEqual(rows["ADB"]["market"], "MAI")

    def test_intraday_accepts_alias_fields_and_rejects_empty(self):
        payload = chart_payload(2)
        payload["answer"][0] = {"datetime":payload["answer"][0]["datetime"], "do":38, "dh":39, "dl":37.5, "dc":38.25}
        rows = r.validate_intraday(payload, "PTT")
        self.assertGreaterEqual(len(rows), 4)
        self.assertEqual(len(r.daily_summary(rows)), 2)
        with self.assertRaisesRegex(r.DataError, "NO_CHART_DATA"):
            r.validate_intraday({"status":"ok", "answer":[]}, "PTT")

    def test_analysis_is_structured_and_non_actionable(self):
        quote = r.validate_market_quotes({"status":"ok", "answer":[tick()]}, ["PTT"])[0]["PTT"]
        bars = r.validate_intraday(chart_payload(), "PTT")
        news = r.parse_feed(rss(), r.FEEDS[0])
        analysis = r.build_analysis("PTT", {"symbol":"PTT", "name":"PTT", "market":"SET"}, quote, bars, news)
        self.assertEqual(analysis["stance"], "interesting")
        self.assertFalse(analysis["actionable"])
        self.assertTrue(analysis["opposingEvidence"])
        self.assertTrue(analysis["beforeBuy"])
        self.assertIn("นี่คือผลวิเคราะห์ครั้งแรก", analysis["changes"][0])

    def test_analysis_stops_when_evidence_is_thin(self):
        analysis = r.build_analysis("PTT", {"symbol":"PTT"}, None, [], [])
        self.assertEqual(analysis["stance"], "insufficient")
        self.assertEqual(analysis["coverage"], "low")

    def test_search_loads_cache_and_ranks_exact_symbol_first(self):
        store = self.store(self.provider)
        rows = store.search("AOT")
        self.assertEqual(rows[0]["symbol"], "AOT")
        self.assertEqual(store.public()["universeCount"], 3)
        self.assertNotIn("universe", store.public())
        self.assertEqual(store.search("airport")[0]["symbol"], "AOT")

    def test_analyze_persists_history_and_uses_cooldown_cache(self):
        calls = []
        def provider(url):
            calls.append(url)
            return self.provider(url)
        store = self.store(provider)
        store.data["news"] = r.parse_feed(rss(), r.FEEDS[0])
        first = store.analyze("PTT")
        count = len(calls)
        second = store.analyze("PTT")
        self.assertEqual(first["createdAt"], second["createdAt"])
        self.assertEqual(len(calls), count)
        reopened = self.store(provider)
        self.assertIn("PTT", reopened.data["analyses"])
        self.assertEqual(len(reopened.data["analyses"]["PTT"]["history"]), 1)

    def test_analysis_tracks_change_against_previous(self):
        store = self.store(self.provider)
        first = store.analyze("PTT")
        store.data["lastAnalysisAttempt"]["PTT"] = r.stamp(r.now() - dt.timedelta(minutes=11))
        def changed(url):
            if "/tick" in url:
                return json.dumps({"status":"ok", "answer":[tick(last="45")]}).encode()
            return self.provider(url)
        store.fetcher = changed
        second = store.analyze("PTT")
        self.assertNotEqual(first["last"], second["last"])
        self.assertTrue(any("ราคา" in item for item in second["changes"]))
        self.assertEqual(len(store.data["analyses"]["PTT"]["history"]), 2)

    def test_legacy_state_migrates_without_losing_decisions(self):
        path = pathlib.Path(self.temp.name) / "state.json"
        path.write_text(json.dumps({"version":"radar-trial-0.1", "news":[], "decisions":{"PTT":{"choice":"watch"}}}), encoding="utf-8")
        store = r.Store(self.temp.name)
        self.assertEqual(store.data["version"], r.VERSION)
        self.assertEqual(store.data["decisions"]["PTT"]["choice"], "watch")
        self.assertEqual(store.data["analyses"], {})

    def test_invalid_existing_state_is_preserved_and_rejected(self):
        path = pathlib.Path(self.temp.name) / "state.json"
        path.write_text("{broken", encoding="utf-8")
        with self.assertRaisesRegex(r.DataError, "LOCAL_STATE_INVALID_KEEP_FILE"):
            r.Store(self.temp.name)
        self.assertEqual(path.read_text(encoding="utf-8"), "{broken")

    def test_refresh_market_accepts_dynamic_symbol_and_persists(self):
        store = self.store(self.provider)
        result = store.refresh_market(["ADB"])
        self.assertIn("ADB", result["marketQuotes"])
        self.assertEqual(result["marketSource"]["received"], 1)
        with self.assertRaisesRegex(r.DataError, "MARKET_COOLDOWN"):
            store.refresh_market(["ADB"])

    def test_failed_market_refresh_keeps_previous(self):
        store = self.store(self.provider)
        before = store.refresh_market(["PTT"])["marketQuotes"]["PTT"]
        store.data["lastMarketAttempt"] = r.stamp(r.now() - dt.timedelta(minutes=6))
        def failed(url): raise r.DataError("NETWORK_UNAVAILABLE")
        store.fetcher = failed
        result = store.refresh_market(["PTT"])
        self.assertEqual(result["marketQuotes"]["PTT"], before)
        self.assertEqual(result["marketSource"]["status"], "error")

    def test_decisions_support_searched_symbols(self):
        store = self.store()
        state = store.decide("ADB", "watch")
        self.assertEqual(state["decisions"]["ADB"]["choice"], "watch")
        store.decide("ADB", "clear")
        self.assertNotIn("ADB", store.data["decisions"])

    def test_refresh_news_keeps_success_and_source_status(self):
        store = self.store(self.provider)
        state = store.refresh_news()
        self.assertEqual(len(state["news"]), 2)
        self.assertEqual(state["sources"]["infoquest"]["status"], "ok")
        self.assertEqual(state["sources"]["thaipr"]["status"], "ok")

    def test_eodhd_fails_closed_without_key(self):
        with self.assertRaisesRegex(r.DataError, "EODHD_KEY_REQUIRED"):
            self.store().refresh_prices(["PTT"])

    def test_loopback_http_search_analysis_security_and_export(self):
        store = self.store(self.provider)
        server = r.ThreadingHTTPServer(("127.0.0.1", 0), r.handler_for(store, "TEST_CSRF"))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(path, method="GET", payload=None, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            connection.request(method, path, body=json.dumps(payload) if payload is not None else None, headers=headers or {})
            response = connection.getresponse()
            body, status, heads = response.read(), response.status, dict(response.getheaders())
            connection.close()
            return status, body, heads
        auth = {"X-Radar-Token":"TEST_CSRF"}
        try:
            for asset in ["/", "/app.js", "/styles.css"]:
                code, body, headers = request(asset)
                self.assertEqual(code, 200)
                self.assertTrue(body)
                self.assertIn("Content-Security-Policy", headers)
            self.assertEqual(request("/local-data/state.json")[0], 404)
            self.assertEqual(request("/api/state", headers={"Host":"evil.example"})[0], 403)
            self.assertEqual(request("/api/search", "POST", {"query":"AOT"})[0], 403)
            code, body, _ = request("/api/search", "POST", {"query":"AOT"}, auth)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)["searchResults"][0]["symbol"], "AOT")
            code, body, _ = request("/api/analyze", "POST", {"symbol":"AOT"}, auth)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)["analysis"]["symbol"], "AOT")
            exported = json.loads(request("/api/export")[1])
            self.assertNotIn("news", exported)
            self.assertNotIn("quotes", exported)
            self.assertEqual(exported["analysisCount"], 1)
            self.assertEqual(request("/api/stop", "POST", {"stop":True})[0], 403)
            self.assertEqual(request("/api/stop", "POST", {"stop":True}, auth)[0], 200)
            thread.join(3)
            self.assertFalse(thread.is_alive())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
