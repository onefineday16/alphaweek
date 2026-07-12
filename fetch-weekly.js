/**
 * AlphaWeek — api/fetch-weekly.js
 * Version: v04-hotfix (public refresh + explicit save diagnostics)
 */
'use strict';

const API_VERSION = 'v04-hotfix';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const SET_INDEX = { symbol: 'SET', yahoo: '^SET.BK' };
const FETCH_TIMEOUT_MS = 15000;

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const isCron = !!req.headers['x-vercel-cron'];
  const token = (req.query && req.query.token) || '';
  const isManualToken = !!process.env.MANUAL_TRIGGER_TOKEN && token === process.env.MANUAL_TRIGGER_TOKEN;
  const isPublicRefresh = req.method === 'POST' || req.method === 'GET';

  if (!isCron && !isManualToken && !isPublicRefresh) {
    return res.status(401).json({ ok: false, api_version: API_VERSION, error: 'unauthorized' });
  }

  const missing = ['APPS_SCRIPT_URL', 'ALPHAWEEK_PIN'].filter((k) => !process.env[k]);
  if (missing.length) {
    return res.status(500).json({ ok: false, api_version: API_VERSION, error: 'missing env: ' + missing.join(', ') });
  }

  const seedMode = String((req.query && req.query.seed) || '') === '1';
  if (seedMode && !isManualToken) {
    return res.status(401).json({ ok: false, api_version: API_VERSION, error: 'seed requires manual token' });
  }

  try {
    if (seedMode) {
      return res.status(400).json({ ok: false, api_version: API_VERSION, error: 'seed disabled in hotfix route; restore full v04 after production API is confirmed' });
    }
    const result = await runWeekly();
    const status = result.save_ok ? 200 : 502;
    return res.status(status).json({
      ok: result.save_ok,
      mode: 'weekly',
      auth_mode: isCron ? 'cron' : (isManualToken ? 'token' : 'public'),
      api_version: API_VERSION,
      refreshed_at: new Date().toISOString(),
      error: result.save_ok ? undefined : result.error,
      result
    });
  } catch (err) {
    return res.status(500).json({ ok: false, api_version: API_VERSION, error: String(err && err.message || err) });
  }
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function runWeekly() {
  const watchlist = await getWatchlist();
  const symbols = activeSymbols(watchlist);
  const weekEnding = lastFridayISO(new Date());
  const quotes = await fetchAllQuotes(symbols, '4mo');
  const rows = [];
  const errors = [];

  for (const q of quotes) {
    if (q.error) { errors.push({ symbol: q.symbol, error: q.error }); continue; }
    const m = computeWeeklyMetrics(q.bars, weekEnding);
    if (!m) { errors.push({ symbol: q.symbol, error: 'no bars in week' }); continue; }
    m.symbol = q.symbol;
    m.source = q.source;
    rows.push(m);
  }

  const existingNews = await getExistingNews(weekEnding);
  const saved = await postToAppsScript({
    action: 'saveWeekly',
    pin: process.env.ALPHAWEEK_PIN,
    week_ending: weekEnding,
    rows,
    news: existingNews
  });
  const saveOk = !!(saved && saved.ok);

  return {
    api_version: API_VERSION,
    week_ending: weekEnding,
    watchlist_count: watchlist.length,
    symbols_requested: symbols.map((s) => s.symbol),
    symbols_ok: rows.length,
    symbols_ok_symbols: rows.map((r) => r.symbol),
    symbols_failed: errors,
    news_preserved: existingNews.length,
    sources: countBy(rows, 'source'),
    save_ok: saveOk,
    error: saveOk ? undefined : 'apps script saveWeekly failed: ' + String((saved && (saved.error || JSON.stringify(saved))) || 'empty response'),
    apps_script: saved
  };
}

async function getWatchlist() {
  const json = await fetchJSON(process.env.APPS_SCRIPT_URL + '?action=watchlist');
  if (!json || !json.ok) throw new Error('watchlist fetch failed: ' + JSON.stringify(json));
  return json.data || [];
}

async function getExistingNews(weekEnding) {
  try {
    const json = await fetchJSON(process.env.APPS_SCRIPT_URL + '?action=dashboard&week=' + encodeURIComponent(weekEnding));
    const news = json && json.ok && json.data && Array.isArray(json.data.news) ? json.data.news : [];
    return news.map((n) => ({
      headline: n.headline || '',
      summary: n.summary || '',
      source: n.source || '',
      url: n.url || '',
      published_at: n.published_at || ''
    })).filter((n) => n.headline);
  } catch (err) {
    return [];
  }
}

function activeSymbols(watchlist) {
  const seen = new Set();
  const out = [];
  for (const w of watchlist || []) {
    if (String(w.active || 'Y').toUpperCase() === 'N') continue;
    const s = normalizeThaiSymbol(w.symbol);
    if (!s.symbol || seen.has(s.symbol)) continue;
    seen.add(s.symbol);
    out.push(s);
  }
  out.push(SET_INDEX);
  return out;
}

function normalizeThaiSymbol(input) {
  let raw = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  raw = raw.replace(/^SET:/, '');
  if (raw === 'SET' || raw === '^SET.BK') return SET_INDEX;
  const base = raw.replace(/\.BK$/, '');
  return { symbol: base, yahoo: base.includes('.') ? base : base + '.BK' };
}

async function fetchAllQuotes(symbols, range) {
  const out = [];
  for (const s of symbols) {
    try {
      out.push({ symbol: s.symbol, bars: await fetchYahooBars(s.yahoo, range), source: 'yahoo' });
    } catch (err) {
      out.push({ symbol: s.symbol, error: String(err && err.message || err) });
    }
  }
  return out;
}

async function fetchYahooBars(yahooSymbol, range) {
  const url = YAHOO_BASE + encodeURIComponent(yahooSymbol) + '?range=' + encodeURIComponent(range) + '&interval=1d';
  const json = await fetchJSON(url, { headers: { 'User-Agent': 'Mozilla/5.0 (AlphaWeek hotfix)' } });
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp) throw new Error('yahoo: empty result for ' + yahooSymbol);
  const q = r.indicators && r.indicators.quote && r.indicators.quote[0];
  if (!q) throw new Error('yahoo: no quote data for ' + yahooSymbol);
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const close = q.close && q.close[i];
    if (close === null || close === undefined) continue;
    bars.push({
      date: isoDateInTZ(new Date(r.timestamp[i] * 1000), 'Asia/Bangkok'),
      close,
      high: numOr(q.high && q.high[i], close),
      low: numOr(q.low && q.low[i], close),
      volume: numOr(q.volume && q.volume[i], 0)
    });
  }
  if (!bars.length) throw new Error('yahoo: zero bars for ' + yahooSymbol);
  return bars;
}

function computeWeeklyMetrics(bars, weekEnding) {
  const upTo = bars.filter((b) => b.date <= weekEnding);
  if (!upTo.length) return null;
  const weekStart = addDaysISO(weekEnding, -6);
  const weekBars = upTo.filter((b) => b.date >= weekStart);
  if (!weekBars.length) return null;
  const close = weekBars[weekBars.length - 1].close;
  const prevClose = closeOnOrBefore(upTo, addDaysISO(weekEnding, -7));
  const close4w = closeOnOrBefore(upTo, addDaysISO(weekEnding, -28));
  const close12w = closeOnOrBefore(upTo, addDaysISO(weekEnding, -84));
  const weekHigh = Math.max(...weekBars.map((b) => b.high));
  const weekLow = Math.min(...weekBars.map((b) => b.low));
  const avgVol1w = avg(weekBars.map((b) => b.volume));
  const last20 = upTo.slice(-20);
  const avgVol4w = avg(last20.map((b) => b.volume));
  const sma20 = last20.length === 20 ? avg(last20.map((b) => b.close)) : null;
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

async function postToAppsScript(payload) {
  const resp = await fetchWithTimeout(process.env.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error('apps script HTTP ' + resp.status + ': ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch (err) { throw new Error('apps script non-JSON response: ' + text.slice(0, 200)); }
}

async function fetchJSON(url, opts) {
  const resp = await fetchWithTimeout(url, Object.assign({ redirect: 'follow' }, opts || {}));
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
  return resp.json();
}

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try { return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal })); }
  finally { clearTimeout(timer); }
}

function lastFridayISO(now) {
  const bkkISO = isoDateInTZ(now, 'Asia/Bangkok');
  const d = new Date(bkkISO + 'T00:00:00Z');
  const back = (d.getUTCDay() - 5 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}
function addDaysISO(iso, days) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function isoDateInTZ(date, tz) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function closeOnOrBefore(bars, dateISO) { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].date <= dateISO) return bars[i].close; return null; }
function pctChange(now, past) { if (past === null || past === undefined || past === 0) return ''; return round2(((now - past) / past) * 100); }
function avg(arr) { return arr && arr.length ? arr.reduce((s, v) => s + (Number(v) || 0), 0) / arr.length : 0; }
function numOr(v, fallback) { return (v === null || v === undefined || isNaN(Number(v))) ? fallback : Number(v); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function countBy(rows, key) { return rows.reduce((m, r) => { m[r[key]] = (m[r[key]] || 0) + 1; return m; }, {}); }
