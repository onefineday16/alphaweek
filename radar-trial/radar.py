"""AlphaWeek Research Desk: local-only Thai equity research assistant.

Uses public, no-account market endpoints and RSS metadata.  It never places
orders and its rule-based summaries deliberately stop when evidence is thin.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import copy
import datetime as dt
import email.utils
import getpass
import hashlib
import html
import json
import math
import os
import pathlib
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent
UTC = dt.timezone.utc
BKK = dt.timezone(dt.timedelta(hours=7))
VERSION = "radar-trial-0.2"
LEGACY_VERSIONS = {"radar-trial-0.1", VERSION}
TOPTRADER = "https://api.toptrader.co.th"
TOPTRADER_DOCS = "https://developers.toptrader.co.th/docs/"
FEEDS = [
    {"id": "infoquest", "name": "InfoQuest", "url": "https://www.infoquest.co.th/stock/feed", "host": "www.infoquest.co.th", "kind": "news"},
    {"id": "thaipr", "name": "ThaiPR.NET", "url": "https://www.thaipr.net/finance/feed", "host": "www.thaipr.net", "kind": "press_release"},
]
# Seeds improve the first screen before the public symbol directory is loaded.
SYMBOLS = "ADVANC AOT AP BBL BCH BDMS BEM BGRIM BH BJC BTS CBG CCET CENTEL CHG CK CKP COM7 CPALL CPAXT CPF CPN CRC DELTA DOHOME EA EGCO GPSC GULF HANA HMPRO IRPC IVL JAS JMART JMT KBANK KCE KKP KLINIQ KTB KTC LH MINT MTC OSP PLANB PR9 PTT PTTEP PTTGC QH RATCH SAWAD SCB SCC SCGP SISB SPALI SPRC STA STECON STGT TASCO TCAP TIDLOR TISCO TLI TOP TRUE TTB TU VGI WHA WHAUP".split()
ALIASES = {"แอดวานซ์": "ADVANC", "ปตท.": "PTT", "ปตท.สผ.": "PTTEP", "กสิกรไทย": "KBANK", "บางกอกดุสิต": "BDMS", "ซีพี ออลล์": "CPALL", "เดลต้า": "DELTA", "ศรีตรังโกลฟส์": "STGT", "ธนาคารกรุงไทย": "KTB", "ทีทีบี": "TTB"}
THEMES = [
    ("digital", "ดิจิทัลและเทคโนโลยี", ["ดาต้าเซ็นเตอร์", "ดาต้า เซ็นเตอร์", "data center", "เซมิคอนดักเตอร์", "อิเล็กทรอนิกส์", "ปัญญาประดิษฐ์"]),
    ("energy", "พลังงาน", ["น้ำมัน", "พลังงาน", "ไฟฟ้า", "ก๊าซ", "โซลาร์"]),
    ("consumer", "บริโภคและท่องเที่ยว", ["ค้าปลีก", "ท่องเที่ยว", "โรงแรม", "นักท่องเที่ยว", "กำลังซื้อ"]),
    ("finance", "การเงิน", ["ดอกเบี้ย", "ธนาคาร", "สินเชื่อ", "หนี้เสีย", "เงินเฟ้อ"]),
    ("health", "สุขภาพ", ["โรงพยาบาล", "การแพทย์", "สุขภาพ"]),
    ("industry", "อุตสาหกรรมและโครงสร้างพื้นฐาน", ["นิคม", "โรงงาน", "ก่อสร้าง", "รถไฟ", "ส่งออก", "โครงสร้างพื้นฐาน"]),
]
QUESTIONS = {
    "digital": "ตรวจว่ารายได้จากธีมนี้มีสัดส่วนเท่าใด และมีสัญญาหรือรายได้จริงแล้วหรือยัง",
    "energy": "ตรวจผลต่อรายได้ ต้นทุน และหนี้ แยกการเคลื่อนไหวของราคาสินค้าออกจากกำไรบริษัท",
    "consumer": "ตรวจยอดขายและอัตรากำไร ว่าการฟื้นตัวเกิดขึ้นต่อเนื่องหรือเป็นช่วงสั้น",
    "finance": "ตรวจคุณภาพสินทรัพย์ ต้นทุนเงินทุน และความเสี่ยงการตั้งสำรอง",
    "health": "ตรวจรายได้ต่อผู้รับบริการ ต้นทุนบุคลากร และเงินลงทุนใหม่",
    "industry": "ตรวจมูลค่างานที่ยืนยันแล้ว ระยะรับรู้รายได้ และกระแสเงินสด",
    "general": "ตรวจประกาศบริษัท งบล่าสุด มูลค่าหุ้น และสิ่งที่ราคาสะท้อนไปแล้ว",
}
SYMBOL_RE = re.compile(r"^[A-Z0-9-]{1,16}$")


class DataError(Exception):
    """Only safe predefined error codes may leave the backend."""


def now():
    return dt.datetime.now(UTC)


def stamp(value=None):
    return (value or now()).isoformat()


def parse_time(value):
    try:
        parsed = dt.datetime.fromisoformat(value)
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except (TypeError, ValueError):
        return None


def valid_symbol(value):
    return isinstance(value, str) and bool(SYMBOL_RE.fullmatch(value))


def unique_symbols(values, limit):
    if not isinstance(values, list) or not 1 <= len(values) <= limit:
        raise DataError("INVALID_SYMBOLS")
    cleaned = []
    for value in values:
        symbol = value.strip().upper() if isinstance(value, str) else ""
        if not valid_symbol(symbol):
            raise DataError("INVALID_SYMBOLS")
        if symbol not in cleaned:
            cleaned.append(symbol)
    return cleaned


class TextOnly(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in ("br", "p", "div"):
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.skip:
            self.skip -= 1
        elif tag in ("p", "div"):
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def clean(value):
    parser = TextOnly()
    parser.feed(value or "")
    return re.sub(r"\s+", " ", html.unescape("".join(parser.parts))).strip()


def safe_link(url, host):
    try:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname != host or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))
    except (ValueError, TypeError):
        return None


class SameHostRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).hostname != urllib.parse.urlsplit(req.full_url).hostname or not newurl.startswith("https://"):
            raise DataError("REDIRECT_REJECTED")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_bytes(url):
    try:
        parsed_url = urllib.parse.urlsplit(url)
        response_limit = 8_000_000 if parsed_url.hostname == "api.toptrader.co.th" and parsed_url.path == "/v1/market/symbols" and not parsed_url.query else 2_000_000
        request = urllib.request.Request(url, headers={"User-Agent": "AlphaWeek-Personal-Trial/0.2", "Accept": "application/rss+xml, application/json, text/xml"})
        started = time.monotonic()
        with urllib.request.build_opener(SameHostRedirect()).open(request, timeout=12) as response:
            chunks, count = [], 0
            while True:
                part = response.read(32768)
                if not part:
                    break
                chunks.append(part)
                count += len(part)
                if count > response_limit:
                    raise DataError("RESPONSE_TOO_LARGE")
                if time.monotonic() - started > 25:
                    raise DataError("RESPONSE_TIMEOUT")
            return b"".join(chunks)
    except urllib.error.HTTPError as error:
        raise DataError("UPSTREAM_HTTP_" + str(error.code)) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise DataError("NETWORK_UNAVAILABLE") from None


def decode_json(body):
    try:
        return json.loads(body)
    except (ValueError, UnicodeError):
        raise DataError("INVALID_PROVIDER_RESPONSE") from None


def match_symbols(text):
    found = {s for s in SYMBOLS if re.search(r"(?<![A-Za-z0-9])" + re.escape(s) + r"(?![A-Za-z0-9])", text)}
    if re.search(r"(?<![A-Za-z0-9])ttb(?![A-Za-z0-9])", text):
        found.add("TTB")
    for alias, symbol in ALIASES.items():
        if alias in text:
            found.add(symbol)
    if "ปตท.สผ." in text and "PTT" not in re.findall(r"[A-Z]+", text) and "ปตท." not in text.replace("ปตท.สผ.", ""):
        found.discard("PTT")
    return sorted(found)


def classify(text):
    lowered = text.lower()
    themes = [{"id": ident, "label": label} for ident, label, words in THEMES if any(word in lowered for word in words)]
    risk = any(word in lowered for word in ["ขาดทุน", "ผิดนัด", "ลดลง", "หนี้เสีย", "ฟ้อง", "เตือน", "ยกเลิก", "ระงับ"])
    positive = any(word in lowered for word in ["เติบโต", "กำไรเพิ่ม", "งานใหม่", "ลงทุน", "ขยาย", "ฟื้น", "รายได้เพิ่ม", "ปันผล"])
    return themes or [{"id": "general", "label": "ข่าวบริษัทและตลาด"}], "mixed" if risk and positive else "risk" if risk else "catalyst" if positive else "research"


def parse_feed(body, source, at=None):
    at = at or now()
    if b"<!DOCTYPE" in body.upper() or b"<!ENTITY" in body.upper():
        raise DataError("UNSAFE_XML")
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        raise DataError("INVALID_FEED") from None
    if root.tag != "rss":
        raise DataError("INVALID_FEED")
    rows = []
    for item in root.findall("./channel/item")[:100]:
        url = safe_link(item.findtext("link"), source["host"])
        title = clean(item.findtext("title"))[:180]
        try:
            date = email.utils.parsedate_to_datetime(item.findtext("pubDate") or "")
            if date.tzinfo is None:
                continue
            date = date.astimezone(UTC)
        except (ValueError, TypeError, OverflowError):
            continue
        if not url or not title or date > at + dt.timedelta(minutes=5) or date < at - dt.timedelta(days=7):
            continue
        description = clean(item.findtext("description"))
        description = description[: max(0, 200 - len(title))] if source["id"] == "infoquest" else description[:1000]
        themes, signal = classify(title + " " + description)
        rows.append({
            "id": hashlib.sha256(url.encode()).hexdigest()[:20], "source": source["id"], "sourceName": source["name"],
            "kind": source["kind"], "url": url, "title": title, "excerpt": description, "publishedAt": stamp(date),
            "collectedAt": stamp(at), "symbols": match_symbols(title + " " + description), "themes": themes, "signal": signal,
            "eventKey": hashlib.sha256(re.sub(r"\W+", "", title).encode()).hexdigest()[:20],
        })
    if not rows:
        raise DataError("NO_RECENT_ITEMS")
    return rows


def numeric(value):
    if isinstance(value, bool) or value is None or (isinstance(value, str) and not value.strip()):
        raise DataError("INVALID_PRICE_DATA")
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise DataError("INVALID_PRICE_DATA") from None
    if not math.isfinite(value):
        raise DataError("INVALID_PRICE_DATA")
    return value


def validate_bars(payload, at=None):
    at = at or now()
    if not isinstance(payload, list) or not payload:
        raise DataError("NO_PRICE_DATA")
    rows, dates = [], set()
    for row in payload:
        try:
            day = dt.date.fromisoformat(row["date"])
        except (ValueError, TypeError, KeyError):
            raise DataError("INVALID_PRICE_DATA") from None
        if day in dates or day > at.astimezone(BKK).date():
            raise DataError("INVALID_PRICE_DATE")
        dates.add(day)
        values = {key: numeric(row.get(key)) for key in ["open", "high", "low", "close", "adjusted_close", "volume"]}
        if any(values[key] <= 0 for key in ["open", "high", "low", "close", "adjusted_close"]) or values["volume"] < 0:
            raise DataError("INVALID_PRICE_DATA")
        if not values["low"] <= min(values["open"], values["close"]) <= max(values["open"], values["close"]) <= values["high"]:
            raise DataError("INVALID_PRICE_DATA")
        rows.append({"date": day.isoformat(), **values})
    rows.sort(key=lambda row: row["date"])
    last = rows[-1]
    def ret(offset):
        return (last["adjusted_close"] / rows[-offset - 1]["adjusted_close"] - 1) * 100 if len(rows) > offset else None
    return {"date": last["date"], "close": last["close"], "volume": last["volume"], "return5": ret(5), "return20": ret(20),
            "points": [{"date": row["date"], "value": row["adjusted_close"]} for row in rows[-30:]], "currency": "THB",
            "identityVerified": False, "corporateActionsVerified": False, "referenceVerified": False, "collectedAt": stamp(at)}


def price_status(quote, at=None):
    if not quote:
        return "missing"
    at = at or now()
    age = (at.astimezone(BKK).date() - dt.date.fromisoformat(quote["date"])).days
    return "stale" if age > 4 else "unverified"


def validate_market_quotes(payload, requested, at=None):
    at = at or now()
    if not isinstance(payload, dict) or payload.get("status") != "ok" or not isinstance(payload.get("answer"), list):
        raise DataError("INVALID_MARKET_RESPONSE")
    accepted, errors, seen = {}, {}, set()
    for row in payload["answer"]:
        if not isinstance(row, dict):
            continue
        symbol = row.get("symbol")
        if not isinstance(symbol, str) or symbol not in requested:
            continue
        if symbol in seen:
            accepted.pop(symbol, None)
            errors[symbol] = "DUPLICATE_MARKET_SYMBOL"
            continue
        seen.add(symbol)
        try:
            last, timestamp = numeric(row.get("last")), numeric(row.get("datetime"))
            if last <= 0 or timestamp <= 0:
                raise DataError("INVALID_MARKET_QUOTE")
            observed = dt.datetime.fromtimestamp(timestamp, UTC)
            if observed > at + dt.timedelta(minutes=5):
                raise DataError("FUTURE_MARKET_QUOTE")
            def side(field):
                value = row.get(field)
                if value is None or value == "":
                    return None
                value = numeric(value)
                if value < 0:
                    raise DataError("INVALID_MARKET_QUOTE")
                return value or None
            bid, ask = side("bid"), side("ask")
            if bid is not None and ask is not None and bid > ask:
                raise DataError("CROSSED_MARKET_QUOTE")
            accepted[symbol] = {"kind": "snapshot", "last": last, "bid": bid, "ask": ask, "observedAt": stamp(observed),
                "date": observed.astimezone(BKK).date().isoformat(), "collectedAt": stamp(at), "provider": "TopTrader Public",
                "providerSymbol": symbol, "currency": "THB", "identityVerified": False, "referenceVerified": False,
                "corporateActionsVerified": False}
        except (DataError, ValueError, OverflowError, OSError) as error:
            errors[symbol] = str(error) if isinstance(error, DataError) else "INVALID_MARKET_TIME"
    for symbol in requested:
        if symbol not in accepted and symbol not in errors:
            errors[symbol] = "MARKET_QUOTE_MISSING"
    return accepted, errors


def validate_universe(payload):
    if not isinstance(payload, dict) or payload.get("status") != "ok" or not isinstance(payload.get("answer"), list):
        raise DataError("INVALID_UNIVERSE_RESPONSE")
    result = {}
    for row in payload["answer"]:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol", "")).upper()
        path = str(row.get("path", ""))
        category = str(row.get("category", "")).upper()
        currency = str(row.get("currencyBase", row.get("currency", ""))).upper()
        parts = path.replace("/", "\\").split("\\")
        market = parts[0].upper() if parts else ""
        if not valid_symbol(symbol) or category != "COMMON_STOCK" or currency != "THB" or market not in ("SET", "MAI"):
            continue
        description = clean(str(row.get("description", "")))[:160]
        name = description.split("_", 1)[1].replace("_", " ").strip() if "_" in description else description
        lot = row.get("volumeStep")
        try:
            lot = int(float(lot)) if lot not in (None, "") else None
        except (TypeError, ValueError):
            lot = None
        result[symbol] = {"symbol": symbol, "name": name or symbol, "market": market, "category": "Common Stock", "currency": "THB", "lotSize": lot}
    if not result:
        raise DataError("NO_COMMON_STOCKS")
    return result


def _field(row, names):
    for name in names:
        if name in row:
            return row[name]
    raise DataError("INVALID_CHART_DATA")


def validate_intraday(payload, symbol, at=None):
    at = at or now()
    if not isinstance(payload, dict) or payload.get("status") != "ok" or not isinstance(payload.get("answer"), list):
        raise DataError("INVALID_CHART_RESPONSE")
    rows, seen = [], set()
    for raw in payload["answer"]:
        try:
            if isinstance(raw, dict):
                timestamp = numeric(_field(raw, ["datetime", "timestamp", "time", "dt", "d"]))
                values = [numeric(_field(raw, names)) for names in (["open", "o", "do"], ["high", "h", "dh"], ["low", "l", "dl"], ["close", "c", "dc"])]
            elif isinstance(raw, list) and len(raw) >= 5:
                timestamp, values = numeric(raw[0]), [numeric(item) for item in raw[1:5]]
            else:
                continue
            observed = dt.datetime.fromtimestamp(timestamp, UTC)
            if timestamp in seen or observed > at + dt.timedelta(minutes=5) or observed < at - dt.timedelta(days=10):
                continue
            open_, high, low, close = values
            if any(value <= 0 for value in values) or not low <= min(open_, close) <= max(open_, close) <= high:
                continue
            seen.add(timestamp)
            rows.append({"at": stamp(observed), "timestamp": timestamp, "open": open_, "high": high, "low": low, "close": close})
        except (DataError, ValueError, OverflowError, OSError):
            continue
    rows.sort(key=lambda row: row["timestamp"])
    if not rows:
        raise DataError("NO_CHART_DATA")
    return rows[-1000:]


def daily_summary(rows):
    grouped = {}
    for row in rows:
        day = parse_time(row["at"]).astimezone(BKK).date().isoformat()
        grouped.setdefault(day, []).append(row)
    daily = []
    for day, bars in sorted(grouped.items()):
        bars.sort(key=lambda row: row["timestamp"])
        daily.append({"date": day, "open": bars[0]["open"], "high": max(row["high"] for row in bars),
                      "low": min(row["low"] for row in bars), "close": bars[-1]["close"], "bars": len(bars)})
    return daily[-8:]


def news_for_symbol(symbol, news):
    pattern = re.compile(r"(?<![A-Za-z0-9])" + re.escape(symbol) + r"(?![A-Za-z0-9])", re.I)
    rows = [story for story in news if symbol in story.get("symbols", []) or pattern.search(story.get("title", "") + " " + story.get("excerpt", ""))]
    return sorted(rows, key=lambda row: row["publishedAt"], reverse=True)[:8]


def candidate_rows(news, quotes, at=None):
    at = at or now()
    grouped = {}
    for story in news:
        published = parse_time(story.get("publishedAt"))
        if not published or at - published > dt.timedelta(hours=72):
            continue
        for symbol in story["symbols"]:
            grouped.setdefault(symbol, []).append(story)
    result = []
    for symbol, stories in grouped.items():
        seen, unique = set(), []
        for story in sorted(stories, key=lambda row: row["publishedAt"], reverse=True):
            if story["eventKey"] not in seen:
                unique.append(story)
                seen.add(story["eventKey"])
        quote = quotes.get(symbol)
        risks = any(story["signal"] in ("risk", "mixed") for story in unique)
        theme = unique[0]["themes"][0]
        result.append({"symbol": symbol, "news": unique[:5], "eventCount": len(unique), "sourceCount": len({story["source"] for story in unique}),
            "status": "ทบทวนความเสี่ยง" if risks else "ศึกษาต่อ", "priceStatus": price_status(quote, at), "quote": quote,
            "question": QUESTIONS[theme["id"]], "theme": theme, "latestAt": unique[0]["publishedAt"], "actionable": False,
            "reason": "พบชื่อหุ้นในข่าวที่ได้รับ ยังไม่ได้ยืนยันมูลค่าและความครบของข้อมูล",
            "caution": "ข่าวซ้ำหรือข่าวประชาสัมพันธ์ไม่ใช่หลักฐานอิสระ รายการนี้ไม่ใช่อันดับหุ้นน่าซื้อ"})
    return sorted(result, key=lambda row: (row["latestAt"], row["eventCount"]), reverse=True)


def analysis_snapshot(analysis):
    return {key: analysis.get(key) for key in ("createdAt", "stance", "stanceLabel", "last", "shortChangePercent", "newsCount", "coverage")}


def build_analysis(symbol, company, quote, bars, news, previous=None, at=None):
    at = at or now()
    daily = daily_summary(bars) if bars else []
    change = (daily[-1]["close"] / daily[0]["close"] - 1) * 100 if len(daily) >= 2 else None
    session_range = (max(day["high"] for day in daily) / min(day["low"] for day in daily) - 1) * 100 if daily else None
    risk_count = sum(story["signal"] in ("risk", "mixed") for story in news)
    catalyst_count = sum(story["signal"] in ("catalyst", "mixed") for story in news)
    if not quote or len(daily) < 2:
        stance, label, reason = "insufficient", "ข้อมูลยังไม่พอ", "ยังไม่มีราคาและช่วงข้อมูลอย่างน้อย 2 วันสำหรับอ่านแนวโน้มสั้น"
    elif risk_count and (change is None or change <= 0):
        stance, label, reason = "caution", "ระวังและตรวจความเสี่ยง", "มีคำเกี่ยวกับความเสี่ยงในข่าว พร้อมแนวโน้มราคาที่ยังไม่ยืนยันด้านบวก"
    elif change >= 2 and catalyst_count > risk_count:
        stance, label, reason = "interesting", "น่าสนใจสำหรับศึกษาต่อ", "ราคาเคลื่อนไหวเชิงบวกในช่วงข้อมูลที่รับมา และข่าวมีเหตุการณ์ให้ตรวจสอบต่อ"
    elif change <= -3:
        stance, label, reason = "wait", "รอให้แนวโน้มหยุดอ่อนตัว", "ราคาอ่อนตัวในช่วงข้อมูลที่รับมา จึงควรรอหลักฐานกลับทิศก่อน"
    else:
        stance, label, reason = "wait", "รอข้อมูลยืนยัน", "ภาพราคาระยะสั้นยังไม่ชัดพอ และระบบยังไม่มีงบหรือมูลค่าหุ้นอัตโนมัติ"
    coverage = "medium" if quote and len(daily) >= 3 else "low"
    changes = []
    if previous:
        if previous.get("stance") != stance:
            changes.append(f"มุมมองเปลี่ยนจาก {previous.get('stanceLabel', 'ผลก่อนหน้า')} เป็น {label}")
        old_last = previous.get("last")
        if isinstance(old_last, (int, float)) and quote and old_last > 0:
            delta = (quote["last"] / old_last - 1) * 100
            if abs(delta) >= 0.1:
                changes.append(f"ราคาล่าสุดเปลี่ยน {delta:+.2f}% จากผลก่อนหน้า")
        if previous.get("newsCount") != len(news):
            changes.append(f"จำนวนข่าวที่เชื่อมโยงเปลี่ยนจาก {previous.get('newsCount', 0)} เป็น {len(news)}")
    else:
        changes.append("นี่คือผลวิเคราะห์ครั้งแรกของหุ้นนี้")
    if not changes:
        changes.append("ยังไม่พบการเปลี่ยนแปลงสำคัญจากผลก่อนหน้า")
    evidence = []
    if quote:
        evidence.append({"label": "ราคาล่าสุดที่ผู้ให้บริการส่งมา", "value": f"{quote['last']:.2f} บาท", "source": "TopTrader Public", "observedAt": quote["observedAt"]})
    if daily:
        evidence.append({"label": "ช่วงข้อมูลราคารายวันจากกราฟรายนาที", "value": f"{len(daily)} วัน / {sum(day['bars'] for day in daily)} แท่ง", "source": "TopTrader Public", "observedAt": daily[-1]["date"]})
    if change is not None:
        evidence.append({"label": "การเปลี่ยนแปลงจากราคาปิดวันแรกถึงวันล่าสุดในชุด", "value": f"{change:+.2f}%", "source": "คำนวณบนเครื่อง", "observedAt": daily[-1]["date"]})
    if news:
        evidence.append({"label": "ข่าวที่พบชื่อหุ้น", "value": f"{len(news)} รายการ / {len({story['source'] for story in news})} แหล่ง", "source": "RSS ที่เชื่อมไว้", "observedAt": news[0]["publishedAt"]})
    opposing = []
    if not news:
        opposing.append("ยังไม่พบข่าวที่เชื่อมชื่อหุ้นใน RSS ที่เก็บไว้ จึงอธิบายเหตุการณ์ล่าสุดไม่ได้")
    if risk_count:
        opposing.append(f"พบข่าว {risk_count} รายการที่มีกลุ่มคำเกี่ยวกับความเสี่ยง ต้องอ่านต้นทางก่อนตัดสินใจ")
    if change is not None and change < 0:
        opposing.append(f"ราคาปิดในชุดข้อมูลลดลง {abs(change):.2f}% จากวันแรก")
    if not opposing:
        opposing.append("ยังไม่มีหลักฐานด้านงบ มูลค่า และสถานะผู้ถือหุ้นมาหักล้างภาพระยะสั้น")
    return {
        "symbol": symbol, "company": company, "createdAt": stamp(at), "ruleVersion": "rules-0.2", "actionable": False,
        "stance": stance, "stanceLabel": label, "reason": reason, "coverage": coverage, "horizon": "ติดตาม 1–2 สัปดาห์",
        "last": quote["last"] if quote else None, "quote": quote, "daily": daily, "shortChangePercent": change,
        "rangePercent": session_range, "newsCount": len(news), "riskNewsCount": risk_count, "catalystNewsCount": catalyst_count,
        "news": news[:5], "evidence": evidence, "opposingEvidence": opposing, "changes": changes,
        "beforeBuy": ["อ่านข่าวต้นทางและประกาศบริษัทที่เกี่ยวข้อง", "ตรวจงบล่าสุด กระแสเงินสด หนี้ และการเติบโตจริง", "ประเมินมูลค่าและกำหนดราคาสูงสุดที่ยอมรับได้", "กำหนดขนาดเงินและจุดยอมรับว่าคิดผิดก่อนส่งคำสั่งเอง"],
        "holdingReview": ["ทบทวนเมื่อมุมมองของระบบเปลี่ยนหรือมีข่าวความเสี่ยงใหม่", "ทบทวนเมื่อราคาอ่อนตัวต่อโดยไม่มีข้อมูลพื้นฐานรองรับ", "ขายหรือถือต่อจากแผนส่วนตัวหลังตรวจงบและประกาศบริษัท ไม่ใช้ผลนี้เป็นคำสั่ง"],
        "dataGaps": ["ยังไม่มีงบการเงิน อัตราส่วนมูลค่า และประมาณการกำไรอัตโนมัติ", "กราฟรายนาทีครอบคลุมเท่าที่ API ส่งมาและยังไม่ปรับ corporate actions", "ข่าวมาจาก RSS ปัจจุบันสองแหล่ง ไม่รับรองว่าครบทุกข่าว", "ไม่ได้ยืนยันสถานะ real-time หรือเทียบราคาอิสระทุกครั้ง"],
        "sourceLinks": {"market": TOPTRADER_DOCS, "set": f"https://www.set.or.th/th/market/product/stock/quote/{urllib.parse.quote(symbol)}/price", "sec": "https://secopendata.sec.or.th/datasets"},
    }


def atomic_json(path, data):
    temp = path.with_suffix(".tmp-" + secrets.token_hex(4))
    try:
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


class Store:
    def __init__(self, folder, key="", free_confirmed=False, fetcher=fetch_bytes):
        self.folder = pathlib.Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.path = self.folder / "state.json"
        self.lock, self.refresh_lock = threading.RLock(), threading.Lock()
        self.key, self.free_confirmed, self.fetcher = key, free_confirmed, fetcher
        self.data = {"version": VERSION, "news": [], "quotes": {}, "marketQuotes": {}, "marketSource": {}, "marketBudget": {},
            "lastMarketAttempt": None, "sources": {}, "decisions": {}, "budget": {}, "lastAttempt": None, "lastPriceAttempt": None,
            "lastPriceResult": None, "universe": {}, "universeSource": {}, "lastUniverseAttempt": None, "analyses": {},
            "analysisBudget": {}, "lastAnalysisAttempt": {}}
        migrated = False
        if self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if loaded.get("version") not in LEGACY_VERSIONS or not isinstance(loaded.get("news"), list) or not isinstance(loaded.get("decisions"), dict):
                    raise ValueError()
                self.data.update(loaded)
                self.data["version"] = VERSION
                for key_name, default in (("universe", {}), ("universeSource", {}), ("analyses", {}), ("analysisBudget", {}), ("lastAnalysisAttempt", {})):
                    if not isinstance(self.data.get(key_name), type(default)):
                        self.data[key_name] = default
                migrated = loaded.get("version") != VERSION
            except (ValueError, TypeError, AttributeError):
                raise DataError("LOCAL_STATE_INVALID_KEEP_FILE") from None
        if migrated:
            self.save()

    def save(self):
        atomic_json(self.path, self.data)

    def public(self):
        with self.lock:
            data = copy.deepcopy(self.data)
        data.pop("budget", None)
        data.pop("marketBudget", None)
        data.pop("analysisBudget", None)
        universe = data.pop("universe", {})
        data["universeCount"] = len(universe)
        data["candidates"] = candidate_rows(data["news"], data["quotes"])
        for row in data["candidates"]:
            quote = data["marketQuotes"].get(row["symbol"])
            row["marketQuote"], row["marketPriceStatus"] = quote, price_status(quote)
        data["news"] = [{**story, "stale": not parse_time(story["publishedAt"]) or now() - parse_time(story["publishedAt"]) > dt.timedelta(hours=72)} for story in data["news"]]
        data["priceConfiguration"] = {"configured": bool(self.key), "enabled": bool(self.key and self.free_confirmed), "limitPerDay": 15,
            "limitPerRefresh": 10, "publicProvider": "TopTrader", "publicEnabled": True}
        data["dictionarySize"], data["serverTime"] = len(SYMBOLS), stamp()
        data["limitations"] = ["บทวิเคราะห์เป็นกฎอัตโนมัติจากราคาและ RSS ไม่ใช่ AI ที่เข้าใจงบหรือคำแนะนำเฉพาะบุคคล",
            "กราฟรายนาทีครอบคลุมเท่าที่ API ส่งมา ไม่ใช่ประวัติปรับสิทธิ์ครบชุด", "ข่าว RSS ไม่รับรองความครบถ้วนและข่าวประชาสัมพันธ์ไม่ใช่หลักฐานอิสระ",
            "ไม่มีการส่งคำสั่งซื้อขาย คุณต้องตรวจงบ มูลค่า ประกาศบริษัท และกดยืนยันกับโบรกเกอร์เอง"]
        return data

    def _toptrader(self, path, query=None):
        if path not in ("/v1/market/symbols", "/v1/market/tick", "/v1/market/chart"):
            raise DataError("INVALID_PROVIDER_PATH")
        url = TOPTRADER + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        return decode_json(self.fetcher(url))

    def refresh_universe(self, force=False):
        with self.lock:
            last = parse_time(self.data.get("lastUniverseAttempt"))
            if not force and self.data["universe"] and last and now() - last < dt.timedelta(hours=24):
                return
            if last and now() - last < dt.timedelta(minutes=3) and not self.data["universe"]:
                raise DataError("UNIVERSE_COOLDOWN")
            self.data["lastUniverseAttempt"] = stamp()
            self.save()
        try:
            universe = validate_universe(self._toptrader("/v1/market/symbols"))
            with self.lock:
                self.data["universe"] = universe
                self.data["universeSource"] = {"name": "TopTrader Public", "url": TOPTRADER_DOCS, "status": "ok", "checkedAt": stamp(), "received": len(universe)}
                self.save()
        except DataError as error:
            with self.lock:
                self.data["universeSource"] = {"name": "TopTrader Public", "url": TOPTRADER_DOCS, "status": "error", "checkedAt": stamp(), "error": str(error), "received": len(self.data["universe"])}
                self.save()
            if not self.data["universe"]:
                raise

    def search(self, query):
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 50:
            raise DataError("INVALID_SEARCH")
        self.refresh_universe()
        needle = query.strip().upper()
        rows = []
        with self.lock:
            universe = copy.deepcopy(self.data["universe"])
        for row in universe.values():
            symbol, name = row["symbol"], row["name"].upper()
            if needle in symbol or needle in name:
                score = 0 if symbol == needle else 1 if symbol.startswith(needle) else 2 if name.startswith(needle) else 3
                rows.append((score, len(symbol), symbol, row))
        return [row for _, _, _, row in sorted(rows)[:20]]

    def refresh_market(self, symbols):
        symbols = unique_symbols(symbols, 20)
        if not self.refresh_lock.acquire(False):
            raise DataError("REFRESH_BUSY")
        try:
            with self.lock:
                previous = self.data["marketSource"]
                last = parse_time(self.data["lastMarketAttempt"])
                if last and (now() - last).total_seconds() < 300:
                    raise DataError("MARKET_COOLDOWN")
                today, used = now().date().isoformat(), self.data["marketBudget"].get(now().date().isoformat(), 0)
                if used >= 100:
                    raise DataError("MARKET_DAILY_LIMIT")
                self.data["marketBudget"] = {today: used + 1}
                self.data["lastMarketAttempt"] = stamp()
                self.save()
            try:
                accepted, errors = validate_market_quotes(self._toptrader("/v1/market/tick", {"symbol": ",".join(symbols)}), symbols)
                with self.lock:
                    for symbol, quote in list(accepted.items()):
                        old = self.data["marketQuotes"].get(symbol)
                        if old and parse_time(old.get("observedAt")) and parse_time(quote["observedAt"]) < parse_time(old["observedAt"]):
                            errors[symbol] = "OLDER_THAN_CACHE"
                            del accepted[symbol]
                        else:
                            self.data["marketQuotes"][symbol] = quote
                    self.data["marketSource"] = {"name": "TopTrader Public", "url": TOPTRADER_DOCS,
                        "status": "partial" if accepted and errors else "ok" if accepted else "error", "checkedAt": stamp(),
                        "lastSuccessAt": stamp() if accepted else previous.get("lastSuccessAt"), "received": len(accepted), "requested": len(symbols), "errors": errors}
                    self.save()
            except DataError as error:
                with self.lock:
                    self.data["marketSource"] = {"name": "TopTrader Public", "url": TOPTRADER_DOCS, "status": "error", "checkedAt": stamp(),
                        "lastSuccessAt": previous.get("lastSuccessAt"), "received": 0, "requested": len(symbols), "errors": {"request": str(error)}}
                    self.save()
            return self.public()
        finally:
            self.refresh_lock.release()

    def analyze(self, symbol):
        symbol = symbol.strip().upper() if isinstance(symbol, str) else ""
        if not valid_symbol(symbol):
            raise DataError("INVALID_SYMBOL")
        if not self.refresh_lock.acquire(False):
            raise DataError("REFRESH_BUSY")
        try:
            with self.lock:
                recent = parse_time(self.data["lastAnalysisAttempt"].get(symbol))
                cached = self.data["analyses"].get(symbol, {}).get("current")
                if recent and now() - recent < dt.timedelta(minutes=10) and cached:
                    return copy.deepcopy(cached)
                today, used = now().date().isoformat(), self.data["analysisBudget"].get(now().date().isoformat(), 0)
                if used >= 60:
                    raise DataError("ANALYSIS_DAILY_LIMIT")
                self.data["analysisBudget"] = {today: used + 1}
                self.data["lastAnalysisAttempt"][symbol] = stamp()
                self.save()
            if not self.data["universe"]:
                self.refresh_universe()
            company = self.data["universe"].get(symbol, {"symbol": symbol, "name": symbol, "market": "SET/mai", "category": "Common Stock", "currency": "THB", "lotSize": None})
            quote = None
            accepted, errors = validate_market_quotes(self._toptrader("/v1/market/tick", {"symbol": symbol}), [symbol])
            quote = accepted.get(symbol)
            if not quote:
                raise DataError(errors.get(symbol, "MARKET_QUOTE_MISSING"))
            end = int(now().timestamp())
            bars = validate_intraday(self._toptrader("/v1/market/chart", {"symbol": symbol, "from": end - 7 * 86400 + 1, "to": end, "data": "dohlc"}), symbol)
            linked_news = news_for_symbol(symbol, self.data["news"])
            previous = self.data["analyses"].get(symbol, {}).get("current")
            analysis = build_analysis(symbol, company, quote, bars, linked_news, previous)
            with self.lock:
                history = list(self.data["analyses"].get(symbol, {}).get("history", []))
                history.append(analysis_snapshot(analysis))
                self.data["analyses"][symbol] = {"current": analysis, "history": history[-10:]}
                self.data["marketQuotes"][symbol] = quote
                self.save()
            return copy.deepcopy(analysis)
        finally:
            self.refresh_lock.release()

    def refresh_news(self):
        if not self.refresh_lock.acquire(False):
            raise DataError("REFRESH_BUSY")
        try:
            with self.lock:
                last = parse_time(self.data["lastAttempt"])
                same_feeds = all(self.data["sources"].get(source["id"], {}).get("url") == source["url"] for source in FEEDS)
                if last and same_feeds and (now() - last).total_seconds() < 900:
                    raise DataError("NEWS_COOLDOWN")
                self.data["lastAttempt"] = stamp()
                self.save()
            def one(source):
                try:
                    return source, parse_feed(self.fetcher(source["url"]), source), None
                except DataError as error:
                    return source, [], str(error)
                except Exception:
                    return source, [], "SOURCE_FAILED"
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                outcomes = list(pool.map(one, FEEDS))
            with self.lock:
                merged = {story["id"]: story for story in self.data["news"]}
                for source, rows, error in outcomes:
                    previous = self.data["sources"].get(source["id"], {})
                    self.data["sources"][source["id"]] = {"name": source["name"], "url": source["url"], "status": "error" if error else "ok", "error": error,
                        "checkedAt": stamp(), "lastSuccessAt": previous.get("lastSuccessAt") if error else stamp(), "received": len(rows)}
                    for row in rows:
                        merged[row["id"]] = row
                cutoff = now() - dt.timedelta(days=7)
                self.data["news"] = sorted([story for story in merged.values() if parse_time(story["publishedAt"]) and parse_time(story["publishedAt"]) >= cutoff], key=lambda story: story["publishedAt"], reverse=True)[:400]
                self.save()
            return self.public()
        finally:
            self.refresh_lock.release()

    def reserve_call(self):
        with self.lock:
            today, used = now().date().isoformat(), self.data["budget"].get(now().date().isoformat(), 0)
            if used >= 15:
                raise DataError("LOCAL_DAILY_LIMIT")
            self.data["budget"] = {today: used + 1}
            self.save()

    def eod_request(self, endpoint, query=None):
        self.reserve_call()
        params = {**(query or {}), "api_token": self.key, "fmt": "json"}
        return decode_json(self.fetcher("https://eodhd.com/api/" + endpoint + "?" + urllib.parse.urlencode(params)))

    def refresh_prices(self, symbols):
        if not self.key:
            raise DataError("EODHD_KEY_REQUIRED")
        if not self.free_confirmed:
            raise DataError("FREE_ACCOUNT_CONFIRMATION_REQUIRED")
        symbols = unique_symbols(symbols, 10)
        if not self.refresh_lock.acquire(False):
            raise DataError("REFRESH_BUSY")
        try:
            with self.lock:
                recent = parse_time(self.data["lastPriceAttempt"])
                if recent and (now() - recent).total_seconds() < 3600:
                    raise DataError("PRICE_COOLDOWN")
                self.data["lastPriceAttempt"] = stamp()
                self.save()
            user = self.eod_request("user")
            if not isinstance(user, dict) or user.get("dailyRateLimit") != 20 or user.get("paymentMethod") or user.get("subscriptionType") in ("monthly", "yearly"):
                raise DataError("FREE_ACCOUNT_NOT_VERIFIED")
            provider_used = numeric(user.get("apiRequests"))
            try:
                usage_day = dt.date.fromisoformat(str(user.get("apiRequestsDate"))[:10])
            except ValueError:
                raise DataError("PROVIDER_QUOTA_UNKNOWN") from None
            if provider_used < 0 or not provider_used.is_integer() or usage_day > now().date():
                raise DataError("PROVIDER_QUOTA_UNKNOWN")
            remaining = max(0, 20 - int(provider_used) - 2) if usage_day == now().date() else 18
            results = {}
            for symbol in symbols:
                existing = self.data["quotes"].get(symbol)
                if existing and parse_time(existing["collectedAt"]) and now() - parse_time(existing["collectedAt"]) < dt.timedelta(hours=20):
                    results[symbol] = "cached"
                    continue
                if remaining <= 0:
                    results[symbol] = "PROVIDER_DAILY_LIMIT"
                    break
                remaining -= 1
                try:
                    payload = self.eod_request("eod/" + symbol + ".BK", {"from": (now().date() - dt.timedelta(days=150)).isoformat(), "to": now().astimezone(BKK).date().isoformat(), "period": "d", "order": "a"})
                    quote = validate_bars(payload)
                    quote["provider"], quote["providerSymbol"] = "EODHD", symbol + ".BK"
                    with self.lock:
                        self.data["quotes"][symbol] = quote
                        self.save()
                    results[symbol] = "received_unverified"
                except DataError as error:
                    results[symbol] = str(error)
                    if str(error) in ("UPSTREAM_HTTP_401", "UPSTREAM_HTTP_403", "UPSTREAM_HTTP_429", "LOCAL_DAILY_LIMIT"):
                        break
                time.sleep(3.1)
            with self.lock:
                self.data["lastPriceResult"] = results
                self.save()
            return self.public()
        finally:
            self.refresh_lock.release()

    def decide(self, symbol, choice):
        symbol = symbol.strip().upper() if isinstance(symbol, str) else ""
        if not valid_symbol(symbol) or choice not in ("watch", "skip", "clear"):
            raise DataError("INVALID_DECISION")
        with self.lock:
            if choice == "clear":
                self.data["decisions"].pop(symbol, None)
            else:
                self.data["decisions"][symbol] = {"choice": choice, "at": stamp(), "kind": "RESEARCH_BOOKMARK"}
            self.save()
        return self.public()


def handler_for(store, token):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *args):
            pass

        def allowed(self):
            port = self.server.server_address[1]
            return self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}")

        def send(self, status, body, content="application/json; charset=utf-8"):
            if isinstance(body, dict):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.allowed():
                return self.send(403, {"error": "HOST_REJECTED"})
            if self.path == "/api/state":
                return self.send(200, {**store.public(), "csrf": token})
            if self.path == "/api/health":
                return self.send(200, {"ok": True, "version": VERSION, "scope": "local-trial", "assistant": "rule-based"})
            if self.path == "/api/export":
                state = store.public()
                summaries = {symbol: analysis_snapshot(record["current"]) for symbol, record in state["analyses"].items() if record.get("current")}
                return self.send(200, {"version": VERSION, "exportedAt": stamp(), "sources": state["sources"], "universeSource": state["universeSource"],
                    "newsCount": len(state["news"]), "candidateCount": len(state["candidates"]), "analysisCount": len(summaries), "analysisSummaries": summaries,
                    "priceCount": len(set(state["quotes"]) | set(state["marketQuotes"])), "marketSource": state["marketSource"],
                    "lastPriceResult": state["lastPriceResult"], "decisions": state["decisions"], "scope": "local-trial-feedback"})
            assets = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"), "/styles.css": ("styles.css", "text/css; charset=utf-8")}
            if self.path not in assets:
                return self.send(404, {"error": "NOT_FOUND"})
            file, mime = assets[self.path]
            return self.send(200, (ROOT / "public" / file).read_bytes(), mime)

        def do_POST(self):
            if not self.allowed():
                return self.send(403, {"error": "HOST_REJECTED"})
            origin = self.headers.get("Origin")
            if origin and origin != "http://" + self.headers.get("Host", ""):
                return self.send(403, {"error": "ORIGIN_REJECTED"})
            if not secrets.compare_digest(self.headers.get("X-Radar-Token", ""), token):
                return self.send(403, {"error": "TOKEN_REQUIRED"})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4096:
                    raise DataError("INVALID_REQUEST")
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise DataError("INVALID_REQUEST")
                extra = {}
                if self.path == "/api/refresh-news":
                    data = store.refresh_news()
                elif self.path == "/api/refresh-market":
                    data = store.refresh_market(payload.get("symbols"))
                elif self.path == "/api/refresh-prices":
                    data = store.refresh_prices(payload.get("symbols"))
                elif self.path == "/api/decision":
                    data = store.decide(payload.get("symbol"), payload.get("choice"))
                elif self.path == "/api/search":
                    extra["searchResults"] = store.search(payload.get("query"))
                    data = store.public()
                elif self.path == "/api/analyze":
                    extra["analysis"] = store.analyze(payload.get("symbol"))
                    data = store.public()
                elif self.path == "/api/stop":
                    if store.refresh_lock.locked():
                        raise DataError("REFRESH_BUSY")
                    self.send(200, {"ok": True})
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                    return
                else:
                    return self.send(404, {"error": "NOT_FOUND"})
                self.send(200, {**data, **extra, "csrf": token})
            except DataError as error:
                self.send(409, {"error": str(error)})
            except (ValueError, TypeError):
                self.send(400, {"error": "INVALID_REQUEST"})
            except Exception:
                self.send(500, {"error": "LOCAL_OPERATION_FAILED"})
    return Handler


@contextlib.contextmanager
def exclusive(folder):
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "server.lock").open("a+b") as file:
        file.seek(0)
        file.write(b"0")
        file.flush()
        file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise DataError("TRIAL_ALREADY_RUNNING") from None
        try:
            yield
        finally:
            if os.name == "nt":
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(file.fileno(), fcntl.LOCK_UN)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--eodhd", action="store_true")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--market-once", action="store_true")
    parser.add_argument("--data-dir", default=str(ROOT / "local-data"))
    args = parser.parse_args()
    key = os.environ.get("EODHD_API_KEY", "")
    confirmed = os.environ.get("ALPHAWEEK_EODHD_FREE") == "1"
    if args.eodhd:
        print("Use an EODHD FREE account only. No broker password. No key is saved. Type FREE to continue:")
        confirmed = input().strip() == "FREE"
        if confirmed:
            key = getpass.getpass("EODHD free API key (hidden): ").strip()
    try:
        with exclusive(pathlib.Path(args.data_dir)):
            store = Store(args.data_dir, key, confirmed)
            if args.once:
                state = store.refresh_news()
                print(json.dumps({"news": len(state["news"]), "candidates": len(state["candidates"]), "sources": state["sources"]}, ensure_ascii=True))
                return
            if args.market_once:
                candidates = [row["symbol"] for row in store.public()["candidates"]]
                symbols = list(dict.fromkeys(candidates + ["PTT", "AOT", "KBANK", "ADVANC", "CPALL", "SCB", "DELTA", "BDMS", "CPN", "SCC"]))[:20]
                state = store.refresh_market(symbols)
                print(json.dumps({"quotes": len(state["marketQuotes"]), "source": state["marketSource"]}, ensure_ascii=True))
                return
            server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(store, secrets.token_urlsafe(32)))
            server.daemon_threads = True
            print(f"AlphaWeek Research Desk: http://127.0.0.1:{args.port}", flush=True)
            print("Public market data + RSS. Rule-based research only; no orders.", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
    except (DataError, OSError) as error:
        print(str(error) if isinstance(error, DataError) else "LOCAL_START_FAILED: check port and folder access.", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
