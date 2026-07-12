/**
 * AlphaWeek — api/fetch-weekly.js
 * Version: v02 (Phase 1.6l — PIN-auth refresh from frontend + CORS)
 *
 * หน้าที่: ดึงราคาหุ้นไทยรายสัปดาห์ + ข่าว RSS แล้ว POST ลง Apps Script (Google Sheets)
 *
 * Trigger:
 *   1. Vercel Cron (ศุกร์ 11:30 UTC = 18:30 ไทย) — ดู vercel.json
 *   2. Manual admin: GET /api/fetch-weekly?token=<MANUAL_TRIGGER_TOKEN>
 *   3. Frontend button: POST /api/fetch-weekly with JSON { pin: <ALPHAWEEK_PIN> }
 *   4. Seed ย้อนหลัง (K3, รันครั้งเดียว): GET /api/fetch-weekly?token=<TOKEN>&seed=1
 *      — เขียน weekly_data ย้อนหลัง ~13 สัปดาห์ (ไม่มีข่าวย้อนหลัง)
 *
 * Env vars (Vercel):
 *   APPS_SCRIPT_URL       — Web App URL (ลงท้าย /exec)
 *   ALPHAWEEK_PIN         — PIN เดียวกับ CONFIG.PIN ใน Apps Script
 *   MANUAL_TRIGGER_TOKEN  — token สำหรับ manual trigger
 *   SETSMART_API_KEY      — (ทีหลัง K1) ถ้าตั้งไว้จะพยายามใช้ SET SMART ก่อน Yahoo
 *
 * Data source: Yahoo Finance (primary ชั่วคราว — D9) → SET SMART เมื่อ K1 พร้อม
 */

'use strict';

// ==================== CONSTANTS ====================

var YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

// SET Index บน Yahoo = ^SET.BK (K5 ยืนยันแล้ว) — ต้อง encode ^ เป็น %5E
var SET_INDEX = { symbol: 'SET', yahoo: '^SET.BK' };

// RSS feeds (K4: Yahoo verify แล้ว · CNBC มี URL ทางการแต่เสี่ยง bot detection ·
// MarketWatch/Bangkok Post ยังไม่ verify — ทุก feed ใช้กลไก fail-skip)
var RSS_FEEDS = [
  { source: 'CNBC', url: 'https://www.cnbc.com/id/20409666/device/rss/rss.html' },
  { source: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
  { source: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { source: 'Bangkok Post', url: 'https://www.bangkokpost.com/rss/data/business.xml' }
];

var NEWS_KEYWORDS = [
  'fed', 'rate', 'interest', 'inflation', 'oil', 'china', 'tariff', 'trade',
  'thailand', 'thai', 'asia', 'export', 'gdp', 'recession', 'dollar', 'baht',
  'stock', 'market', 'earnings', 'bank', 'energy', 'tech'
];

var NEWS_MIN = 5;
var NEWS_MAX = 8;
var SEED_WEEKS = 13;
var FETCH_TIMEOUT_MS = 15000;

// ==================== HANDLER ====================

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Auth modes:
  // 1) Vercel Cron header.
  // 2) Admin manual token query.
  // 3) Frontend POST with AlphaWeek PIN. PIN is not embedded in frontend; user stores it locally.
  var isCron = !!req.headers['x-vercel-cron'];
  var token = (req.query && req.query.token) || '';
  var isManualToken = !!process.env.MANUAL_TRIGGER_TOKEN &&
    token === process.env.MANUAL_TRIGGER_TOKEN;
  var body = safeBody(req);
  var pin = (body && body.pin) || (req.headers && (req.headers['x-alphaweek-pin'] || req.headers['X-AlphaWeek-Pin'])) || (req.query && req.query.pin) || '';
  var isPinManual = !!process.env.ALPHAWEEK_PIN && String(pin) === String(process.env.ALPHAWEEK_PIN);

  if (!isCron && !isManualToken && !isPinManual) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  var missing = ['APPS_SCRIPT_URL', 'ALPHAWEEK_PIN'].filter(function (k) {
    return !process.env[k];
  });
  if (missing.length > 0) {
    return res.status(500).json({ ok: false, error: 'missing env: ' + missing.join(', ') });
  }

  var seedMode = String((req.query && req.query.seed) || '') === '1';
  if (seedMode && !isManualToken) {
    // seed ต้องเป็น manual token เท่านั้น (กันหน้าเว็บ/cron ไปรัน seed โดยไม่ตั้งใจ)
    return res.status(401).json({ ok: false, error: 'seed requires manual token' });
  }

  try {
    var result = seedMode ? await runSeed() : await runWeekly();
    return res.status(200).json({
      ok: true,
      mode: seedMode ? 'seed' : 'weekly',
      auth_mode: isCron ? 'cron' : (isManualToken ? 'token' : 'pin'),
      refreshed_at: new Date().toISOString(),
      result: result
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AlphaWeek-Pin');
}

function safeBody(req) {
  if (!req || !req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch (err) { return {}; }
}

// ==================== MAIN FLOWS ====================

/** รอบปกติรายสัปดาห์: สัปดาห์ล่าสุด 1 สัปดาห์ + ข่าว */
async function runWeekly() {
  var watchlist = await getWatchlist();
  var symbols = activeSymbols(watchlist);
  var weekEnding = lastFridayISO(new Date());

  var quotes = await fetchAllQuotes(symbols, '4mo');
  var rows = [];
  var errors = [];
  quotes.forEach(function (q) {
    if (q.error) { errors.push({ symbol: q.symbol, error: q.error }); return; }
    var m = computeWeeklyMetrics(q.bars, weekEnding);
    if (!m) { errors.push({ symbol: q.symbol, error: 'no bars in week' }); return; }
    m.symbol = q.symbol;
    m.source = q.source;
    rows.push(m);
  });

  var news = await fetchWeeklyNews(weekEnding);

  var saved = await postToAppsScript({
    action: 'saveWeekly',
    pin: process.env.ALPHAWEEK_PIN,
    week_ending: weekEnding,
    rows: rows,
    news: news
  });

  return {
    week_ending: weekEnding,
    symbols_ok: rows.length,
    symbols_failed: errors,
    news_count: news.length,
    sources: countBy(rows, 'source'),
    apps_script: saved
  };
}

/** Seed ย้อนหลัง (K3): เขียน weekly_data ~13 สัปดาห์ล่าสุด — ข่าวเฉพาะสัปดาห์ล่าสุดไม่แตะ */
async function runSeed() {
  var watchlist = await getWatchlist();
  var symbols = activeSymbols(watchlist);

  // ใช้ range=1y เพื่อให้ 12w มีข้อมูลครบทุกสัปดาห์ที่ seed
  var quotes = await fetchAllQuotes(symbols, '1y');
  var weeks = lastNFridaysISO(new Date(), SEED_WEEKS);

  var summary = [];
  for (var i = weeks.length - 1; i >= 0; i--) { // เก่าสุด → ใหม่สุด
    var week = weeks[i];
    var rows = [];
    quotes.forEach(function (q) {
      if (q.error) return;
      var m = computeWeeklyMetrics(q.bars, week);
      if (!m) return;
      m.symbol = q.symbol;
      m.source = q.source;
      rows.push(m);
    });
    if (rows.length === 0) { summary.push({ week_ending: week, rows: 0, skipped: true }); continue; }
    /* eslint-disable no-await-in-loop */
    var saved = await postToAppsScript({
      action: 'saveWeekly',
      pin: process.env.ALPHAWEEK_PIN,
      week_ending: week,
      rows: rows,
      news: [] // ไม่มีข่าวย้อนหลัง — saveWeekly จะเคลียร์ news ของ week นั้น (ว่างอยู่แล้ว)
    });
    summary.push({ week_ending: week, rows: rows.length, saved: !!(saved && saved.ok) });
  }
  return { weeks_seeded: summary, symbols_failed: quotes.filter(function (q) { return q.error; }) };
}

// ==================== DATA SOURCES ====================

async function getWatchlist() {
  var url = process.env.APPS_SCRIPT_URL + '?action=watchlist';
  var json = await fetchJSON(url);
  if (!json || !json.ok) throw new Error('watchlist fetch failed: ' + JSON.stringify(json));
  return json.data || [];
}

function activeSymbols(watchlist) {
  var syms = watchlist
    .filter(function (w) { return String(w.active).toUpperCase() === 'Y'; })
    .map(function (w) { return { symbol: w.symbol, yahoo: w.symbol + '.BK' }; });
  syms.push(SET_INDEX); // SET Index ติดไปด้วยเสมอ
  return syms;
}

/** ดึงราคาทุก symbol — SET SMART ก่อน (ถ้ามี key) แล้ว fallback Yahoo รายตัว */
async function fetchAllQuotes(symbols, range) {
  var out = [];
  for (var i = 0; i < symbols.length; i++) {
    var s = symbols[i];
    var bars = null;
    var source = '';
    // --- SET SMART (K1: ยังไม่พร้อม — โครงไว้ สลับได้ด้วย env var) ---
    if (process.env.SETSMART_API_KEY) {
      try {
        bars = await fetchSetSmartBars(s.symbol, range);
        source = 'setsmart';
      } catch (e) { bars = null; }
    }
    // --- Yahoo (primary ชั่วคราว / fallback) ---
    if (!bars) {
      try {
        bars = await fetchYahooBars(s.yahoo, range);
        source = 'yahoo';
      } catch (e2) {
        out.push({ symbol: s.symbol, error: String(e2 && e2.message || e2) });
        continue;
      }
    }
    out.push({ symbol: s.symbol, bars: bars, source: source });
  }
  return out;
}

/**
 * SET SMART — ยังไม่ implement จริง (K1: รอสมัคร + สเปก API)
 * เมื่อพร้อม: แทนที่ฟังก์ชันนี้ให้คืน bars รูปแบบเดียวกับ fetchYahooBars
 * รูปแบบ bars: [{ date:'YYYY-MM-DD', close, high, low, volume }] เรียงเก่า→ใหม่
 */
async function fetchSetSmartBars(symbol, range) {
  throw new Error('SET SMART not implemented yet (K1)');
}

async function fetchYahooBars(yahooSymbol, range) {
  var url = YAHOO_BASE + encodeURIComponent(yahooSymbol) +
    '?range=' + encodeURIComponent(range) + '&interval=1d';
  var json = await fetchJSON(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (AlphaWeek personal weekly fetcher)' }
  });
  var r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp) throw new Error('yahoo: empty result for ' + yahooSymbol);
  var q = r.indicators && r.indicators.quote && r.indicators.quote[0];
  if (!q) throw new Error('yahoo: no quote data for ' + yahooSymbol);
  var tz = 'Asia/Bangkok';
  var bars = [];
  for (var i = 0; i < r.timestamp.length; i++) {
    var close = q.close && q.close[i];
    if (close === null || close === undefined) continue; // ข้ามวันไม่มีข้อมูล
    bars.push({
      date: isoDateInTZ(new Date(r.timestamp[i] * 1000), tz),
      close: close,
      high: numOr(q.high && q.high[i], close),
      low: numOr(q.low && q.low[i], close),
      volume: numOr(q.volume && q.volume[i], 0)
    });
  }
  if (bars.length === 0) throw new Error('yahoo: zero bars for ' + yahooSymbol);
  return bars;
}

// ==================== METRICS ====================

/**
 * คำนวณ metrics ของสัปดาห์ที่จบวันศุกร์ weekEnding (YYYY-MM-DD)
 * bars: เรียงเก่า→ใหม่ · คืน null ถ้าไม่มี bar ในสัปดาห์นั้น
 * ค่าที่คำนวณไม่ได้ (ข้อมูลย้อนหลังไม่พอ) = '' ตาม schema
 */
function computeWeeklyMetrics(bars, weekEnding) {
  var upTo = bars.filter(function (b) { return b.date <= weekEnding; });
  if (upTo.length === 0) return null;

  var weekStart = addDaysISO(weekEnding, -6); // จ.–ศ. อยู่ในช่วง 7 วันนี้
  var weekBars = upTo.filter(function (b) { return b.date >= weekStart; });
  if (weekBars.length === 0) return null;

  var close = weekBars[weekBars.length - 1].close;
  var prevClose = closeOnOrBefore(upTo, addDaysISO(weekEnding, -7));
  var close4w = closeOnOrBefore(upTo, addDaysISO(weekEnding, -28));
  var close12w = closeOnOrBefore(upTo, addDaysISO(weekEnding, -84));

  var weekHigh = Math.max.apply(null, weekBars.map(function (b) { return b.high; }));
  var weekLow = Math.min.apply(null, weekBars.map(function (b) { return b.low; }));
  var avgVol1w = avg(weekBars.map(function (b) { return b.volume; }));

  var last20 = upTo.slice(-20);
  var avgVol4w = avg(last20.map(function (b) { return b.volume; }));
  var sma20 = last20.length === 20 ? avg(last20.map(function (b) { return b.close; })) : null;

  return {
    close: round2(close),
    prev_close: prevClose === null ? '' : round2(prevClose),
    change_pct_1w: pctChange(close, prevClose),
    change_pct_4w: pctChange(close, close4w),
    change_pct_12w: pctChange(close, close12w),
    week_high: round2(weekHigh),
    week_low: round2(weekLow),
    avg_volume_1w: Math.round(avgVol1w),
    avg_volume_4w: Math.round(avgVol4w),
    volume_ratio: avgVol4w > 0 ? round2(avgVol1w / avgVol4w) : '',
    sma20_position: sma20 === null ? '' : (close >= sma20 ? 'above' : 'below')
  };
}

function closeOnOrBefore(bars, dateISO) {
  for (var i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= dateISO) return bars[i].close;
  }
  return null;
}

function pctChange(now, past) {
  if (past === null || past === undefined || past === 0) return '';
  return round2(((now - past) / past) * 100);
}

// ==================== NEWS (RSS) ====================

async function fetchWeeklyNews(weekEnding) {
  var all = [];
  for (var i = 0; i < RSS_FEEDS.length; i++) {
    var feed = RSS_FEEDS[i];
    try {
      /* eslint-disable no-await-in-loop */
      var xml = await fetchText(feed.url);
      var items = parseRSSItems(xml).slice(0, 15);
      items.forEach(function (it) { it.source = feed.source; });
      all = all.concat(items);
    } catch (e) {
      // feed ใด fail ข้ามไป — ไม่ล้ม batch (ตาม ARCHITECTURE)
    }
  }
  // คัดด้วย keyword ก่อน ถ้าได้ไม่ถึงขั้นต่ำเติมข่าวล่าสุดที่เหลือ
  var matched = all.filter(function (it) { return matchesKeywords(it.headline + ' ' + it.summary); });
  var rest = all.filter(function (it) { return matched.indexOf(it) === -1; });
  var picked = dedupeByHeadline(matched).slice(0, NEWS_MAX);
  if (picked.length < NEWS_MIN) {
    picked = picked.concat(dedupeByHeadline(rest).slice(0, NEWS_MIN - picked.length));
  }
  return picked.map(function (it) {
    return {
      headline: it.headline,
      summary: truncate(it.summary, 300),
      source: it.source,
      url: it.url,
      published_at: it.published_at
    };
  });
}

/** parser RSS อย่างง่าย (ไม่ใช้ dependency) — รองรับ <item> มาตรฐาน + CDATA */
function parseRSSItems(xml) {
  var items = [];
  var re = /<item[\s>][\s\S]*?<\/item>/gi;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var block = m[0];
    items.push({
      headline: cleanXMLText(firstTag(block, 'title')),
      summary: cleanXMLText(firstTag(block, 'description')),
      url: cleanXMLText(firstTag(block, 'link')),
      published_at: cleanXMLText(firstTag(block, 'pubDate'))
    });
  }
  return items.filter(function (it) { return it.headline; });
}

function firstTag(block, tag) {
  var re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  var m = re.exec(block);
  return m ? m[1] : '';
}

function cleanXMLText(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesKeywords(text) {
  var t = String(text || '').toLowerCase();
  return NEWS_KEYWORDS.some(function (k) { return t.indexOf(k) !== -1; });
}

function dedupeByHeadline(items) {
  var seen = {};
  return items.filter(function (it) {
    var key = it.headline.toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

// ==================== APPS SCRIPT ====================

async function postToAppsScript(payload) {
  var resp = await fetchWithTimeout(process.env.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow' // Apps Script redirect ไป googleusercontent เสมอ
  });
  var text = await resp.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error('apps script non-JSON response: ' + text.slice(0, 200)); }
}

// ==================== DATE HELPERS ====================

/** วันศุกร์ล่าสุด (รวมวันนี้ถ้าเป็นศุกร์) เป็น YYYY-MM-DD ตามเวลาไทย */
function lastFridayISO(now) {
  var bkkISO = isoDateInTZ(now, 'Asia/Bangkok');
  var d = new Date(bkkISO + 'T00:00:00Z');
  var dow = d.getUTCDay(); // 0=อา ... 5=ศ
  var back = (dow - 5 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function lastNFridaysISO(now, n) {
  var out = [];
  var f = lastFridayISO(now);
  for (var i = 0; i < n; i++) {
    out.push(addDaysISO(f, -7 * i));
  }
  return out; // ใหม่สุด → เก่าสุด
}

function addDaysISO(iso, days) {
  var d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoDateInTZ(date, tz) {
  // en-CA ให้รูปแบบ YYYY-MM-DD ตรงๆ
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

// ==================== FETCH / MISC HELPERS ====================

async function fetchWithTimeout(url, opts) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url, opts) {
  var resp = await fetchWithTimeout(url, Object.assign({ redirect: 'follow' }, opts || {}));
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
  return resp.json();
}

async function fetchText(url, opts) {
  var resp = await fetchWithTimeout(url, Object.assign({ redirect: 'follow' }, opts || {}));
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
  return resp.text();
}

function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  var s = 0;
  for (var i = 0; i < arr.length; i++) s += Number(arr[i]) || 0;
  return s / arr.length;
}

function numOr(v, fallback) {
  return (v === null || v === undefined || isNaN(Number(v))) ? fallback : Number(v);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function countBy(rows, key) {
  var out = {};
  rows.forEach(function (r) { out[r[key]] = (out[r[key]] || 0) + 1; });
  return out;
}
