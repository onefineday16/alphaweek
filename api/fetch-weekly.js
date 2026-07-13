/**
 * AlphaWeek — api/fetch-weekly.js
 * Version: v07-fundamentals (V26 responsive market explorer + fundamentals)
 */
'use strict';

const API_VERSION = 'v07-fundamentals';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YAHOO_QUOTE_SUMMARY_BASE = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/';
const YAHOO_QUOTE_BASE = 'https://query1.finance.yahoo.com/v7/finance/quote';
const SET_INDEX = { symbol: 'SET', yahoo: '^SET.BK' };
const FETCH_TIMEOUT_MS = 15000;
const MAX_SYMBOLS_PER_REQUEST = 10;
const FETCH_CONCURRENCY = 3;

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
      return res.status(400).json({ ok: false, api_version: API_VERSION, error: 'seed disabled in v05 route' });
    }
    const body = parseBody(req);
    const requestedSymbols = extractRequestedSymbols(req, body);
    const universe = String((body && body.universe) || (req.query && req.query.universe) || 'watchlist');
    const result = requestedSymbols.length
      ? await runSymbolBatch(requestedSymbols, { universe, source: body && body.source })
      : await runWeekly();
    const status = result.save_ok ? 200 : 502;
    return res.status(status).json({
      ok: result.save_ok,
      mode: requestedSymbols.length ? 'universe-batch' : 'weekly',
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

function parseBody(req) {
  if (!req || !req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(String(req.body || '{}')); }
  catch (err) { return {}; }
}

function extractRequestedSymbols(req, body) {
  let raw = [];
  if (body && Array.isArray(body.symbols)) raw = body.symbols;
  else if (req.query && req.query.symbols) raw = String(req.query.symbols).split(',');
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const s = normalizeThaiSymbol(item);
    if (!s.symbol || seen.has(s.symbol)) continue;
    seen.add(s.symbol);
    out.push(s.symbol);
  }
  if (out.length > MAX_SYMBOLS_PER_REQUEST) {
    throw new Error('too many symbols: max ' + MAX_SYMBOLS_PER_REQUEST + ' per request');
  }
  return out;
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

  const fundamentalsResult = await fetchAllFundamentals(symbols.filter((s) => s.symbol !== 'SET'));
  const fundamentalsRows = fundamentalsResult.rows;
  const existingNews = await getExistingNews(weekEnding);
  const saved = await postToAppsScript({
    action: 'saveWeeklyMerge',
    pin: process.env.ALPHAWEEK_PIN,
    week_ending: weekEnding,
    rows,
    news: existingNews,
    meta: { source: 'weekly-refresh', api_version: API_VERSION }
  });
  const saveOk = !!(saved && saved.ok);
  const fundamentalsSave = await saveFundamentalsBestEffort(fundamentalsRows, {
    source: 'weekly-refresh',
    api_version: API_VERSION
  });

  return {
    api_version: API_VERSION,
    week_ending: weekEnding,
    watchlist_count: watchlist.length,
    symbols_requested: symbols.map((s) => s.symbol),
    symbols_ok: rows.length,
    symbols_ok_symbols: rows.map((r) => r.symbol),
    symbols_failed: errors,
    news_preserved: existingNews.length,
    save_mode: 'merge',
    sources: countBy(rows, 'source'),
    save_ok: saveOk,
    error: saveOk ? undefined : 'apps script saveWeeklyMerge failed: ' + String((saved && (saved.error || JSON.stringify(saved))) || 'empty response'),
    apps_script: saved,
    fundamentals_requested: fundamentalsResult.requested,
    fundamentals_ok: fundamentalsRows.length,
    fundamentals_failed: fundamentalsResult.errors,
    fundamentals_sources: countBy(fundamentalsRows, 'source'),
    fundamentals_save_ok: fundamentalsSave.ok,
    fundamentals_save_error: fundamentalsSave.error,
    fundamentals_apps_script: fundamentalsSave.response
  };
}

async function runSymbolBatch(symbolInputs, meta) {
  const symbols = normalizeSymbolList(symbolInputs);
  if (!symbols.length) throw new Error('symbols required for universe batch');
  if (symbols.length > MAX_SYMBOLS_PER_REQUEST) throw new Error('too many symbols: max ' + MAX_SYMBOLS_PER_REQUEST);

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

  const fundamentalsResult = await fetchAllFundamentals(symbols.filter((s) => s.symbol !== 'SET'));
  const fundamentalsRows = fundamentalsResult.rows;
  const saved = await postToAppsScript({
    action: 'saveWeeklyMerge',
    pin: process.env.ALPHAWEEK_PIN,
    week_ending: weekEnding,
    rows,
    meta: {
      universe: meta && meta.universe,
      source: meta && meta.source,
      api_version: API_VERSION
    }
  });
  const saveOk = !!(saved && saved.ok);
  const fundamentalsSave = await saveFundamentalsBestEffort(fundamentalsRows, {
    universe: meta && meta.universe,
    source: meta && meta.source,
    api_version: API_VERSION
  });

  return {
    api_version: API_VERSION,
    week_ending: weekEnding,
    universe: meta && meta.universe,
    symbols_requested: symbols.map((s) => s.symbol),
    symbols_ok: rows.length,
    symbols_ok_symbols: rows.map((r) => r.symbol),
    symbols_failed: errors,
    sources: countBy(rows, 'source'),
    save_mode: 'merge',
    save_ok: saveOk,
    error: saveOk ? undefined : 'apps script saveWeeklyMerge failed: ' + String((saved && (saved.error || JSON.stringify(saved))) || 'empty response'),
    apps_script: saved,
    fundamentals_requested: fundamentalsResult.requested,
    fundamentals_ok: fundamentalsRows.length,
    fundamentals_failed: fundamentalsResult.errors,
    fundamentals_sources: countBy(fundamentalsRows, 'source'),
    fundamentals_save_ok: fundamentalsSave.ok,
    fundamentals_save_error: fundamentalsSave.error,
    fundamentals_apps_script: fundamentalsSave.response
  };
}

function normalizeSymbolList(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const s = normalizeThaiSymbol(item);
    if (!s.symbol || seen.has(s.symbol)) continue;
    seen.add(s.symbol);
    out.push(s);
  }
  return out;
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
  return mapWithConcurrency(symbols, FETCH_CONCURRENCY, async (s) => {
    try {
      return { symbol: s.symbol, bars: await fetchYahooBars(s.yahoo, range), source: 'yahoo_chart' };
    } catch (err) {
      return { symbol: s.symbol, error: String(err && err.message || err) };
    }
  });
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
  const prior20 = upTo.filter((b) => b.date < weekStart).slice(-20);
  const avgVolPrior20 = prior20.length === 20 ? avg(prior20.map((b) => b.volume)) : 0;
  const last20Closes = upTo.slice(-20);
  const sma20 = last20Closes.length === 20 ? avg(last20Closes.map((b) => b.close)) : null;
  return {
    close: round2(close),
    prev_close: prevClose === null ? '' : round2(prevClose),
    change_pct_1w: pctChange(close, prevClose),
    change_pct_4w: pctChange(close, close4w),
    change_pct_12w: pctChange(close, close12w),
    week_high: round2(weekHigh),
    week_low: round2(weekLow),
    avg_volume_1w: Math.round(avgVol1w),
    avg_volume_4w: avgVolPrior20 > 0 ? Math.round(avgVolPrior20) : '',
    volume_ratio: avgVolPrior20 > 0 ? round2(avgVol1w / avgVolPrior20) : '',
    sma20_position: sma20 === null ? '' : (close >= sma20 ? 'above' : 'below')
  };
}


async function fetchAllFundamentals(symbols) {
  const normalized = normalizeSymbolList((symbols || []).map((s) => s.symbol || s)).filter((s) => s.symbol !== 'SET');
  const results = await mapWithConcurrency(normalized, FETCH_CONCURRENCY, async (s) => {
    try {
      return { symbol: s.symbol, row: await fetchYahooFundamentals(s) };
    } catch (err) {
      return { symbol: s.symbol, error: String(err && err.message || err) };
    }
  });
  return {
    requested: normalized.map((s) => s.symbol),
    rows: results.filter((r) => r.row).map((r) => r.row),
    errors: results.filter((r) => r.error).map((r) => ({ symbol: r.symbol, error: r.error }))
  };
}

async function fetchYahooFundamentals(symbol) {
  const modules = 'price,summaryDetail,defaultKeyStatistics,financialData';
  const summaryUrl = YAHOO_QUOTE_SUMMARY_BASE + encodeURIComponent(symbol.yahoo) +
    '?modules=' + encodeURIComponent(modules);
  let summaryError = '';

  try {
    const json = await fetchJSON(summaryUrl, { headers: yahooHeaders() });
    const result = json && json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
    if (result) {
      const row = normalizeQuoteSummaryFundamentals(symbol.symbol, result);
      if (hasCoreFundamental(row)) return row;
      summaryError = 'quoteSummary returned no core fundamentals';
    } else {
      summaryError = 'quoteSummary empty result';
    }
  } catch (err) {
    summaryError = String(err && err.message || err);
  }

  try {
    const quoteUrl = YAHOO_QUOTE_BASE + '?symbols=' + encodeURIComponent(symbol.yahoo);
    const json = await fetchJSON(quoteUrl, { headers: yahooHeaders() });
    const q = json && json.quoteResponse && json.quoteResponse.result && json.quoteResponse.result[0];
    if (!q) throw new Error('quote endpoint empty result');
    const row = normalizeQuoteFundamentals(symbol.symbol, q);
    if (!hasCoreFundamental(row)) throw new Error('quote endpoint returned no core fundamentals');
    return row;
  } catch (err) {
    throw new Error('yahoo fundamentals unavailable; summary=' + summaryError + '; quote=' + String(err && err.message || err));
  }
}

function normalizeQuoteSummaryFundamentals(symbol, result) {
  const price = result.price || {};
  const summary = result.summaryDetail || {};
  const stats = result.defaultKeyStatistics || {};
  const financial = result.financialData || {};
  const fetchedAt = new Date().toISOString();
  const asOf = yahooDate(rawValue(stats.mostRecentQuarter)) || yahooDate(rawValue(price.regularMarketTime)) || fetchedAt.slice(0, 10);
  return cleanFundamentalRow({
    symbol,
    as_of_date: asOf,
    pe_ttm: firstNumber(rawValue(summary.trailingPE), rawValue(stats.trailingPE)),
    pbv: rawValue(stats.priceToBook),
    dividend_yield_pct: percentFromFraction(firstNumber(rawValue(summary.dividendYield), rawValue(summary.trailingAnnualDividendYield))),
    market_cap: firstNumber(rawValue(price.marketCap), rawValue(summary.marketCap)),
    eps_ttm: rawValue(stats.trailingEps),
    roe_pct: percentFromFraction(rawValue(financial.returnOnEquity)),
    debt_to_equity: rawValue(financial.debtToEquity),
    revenue_growth_yoy_pct: percentFromFraction(rawValue(financial.revenueGrowth)),
    net_profit_growth_yoy_pct: percentFromFraction(rawValue(financial.earningsGrowth)),
    financial_period: yahooDate(rawValue(stats.mostRecentQuarter)),
    source: 'yahoo_quoteSummary',
    fetched_at: fetchedAt
  });
}

function normalizeQuoteFundamentals(symbol, q) {
  const fetchedAt = new Date().toISOString();
  return cleanFundamentalRow({
    symbol,
    as_of_date: yahooDate(q.regularMarketTime) || fetchedAt.slice(0, 10),
    pe_ttm: q.trailingPE,
    pbv: q.priceToBook,
    dividend_yield_pct: percentFromFraction(firstNumber(q.dividendYield, q.trailingAnnualDividendYield)),
    market_cap: q.marketCap,
    eps_ttm: firstNumber(q.epsTrailingTwelveMonths, q.trailingEps),
    roe_pct: '',
    debt_to_equity: '',
    revenue_growth_yoy_pct: '',
    net_profit_growth_yoy_pct: '',
    financial_period: '',
    source: 'yahoo_quote',
    fetched_at: fetchedAt
  });
}

function cleanFundamentalRow(row) {
  const out = Object.assign({}, row);
  ['pe_ttm', 'pbv', 'dividend_yield_pct', 'market_cap', 'eps_ttm', 'roe_pct',
    'debt_to_equity', 'revenue_growth_yoy_pct', 'net_profit_growth_yoy_pct'].forEach((key) => {
      const n = Number(out[key]);
      out[key] = Number.isFinite(n) ? round4(n) : '';
  });
  if (Number(out.pe_ttm) <= 0) out.pe_ttm = '';
  if (Number(out.pbv) <= 0) out.pbv = '';
  if (Number(out.market_cap) <= 0) out.market_cap = '';
  return out;
}

function hasCoreFundamental(row) {
  return !!(row && [row.pe_ttm, row.pbv, row.dividend_yield_pct, row.market_cap, row.roe_pct]
    .some((v) => v !== '' && v !== null && v !== undefined));
}

async function saveFundamentalsBestEffort(rows, meta) {
  if (!rows || !rows.length) return { ok: false, error: 'no fundamental rows returned', response: null };
  try {
    const response = await postToAppsScript({
      action: 'saveFundamentalsMerge',
      pin: process.env.ALPHAWEEK_PIN,
      rows,
      meta: meta || {}
    });
    return {
      ok: !!(response && response.ok),
      error: response && response.ok ? undefined : String((response && (response.error || JSON.stringify(response))) || 'empty response'),
      response
    };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), response: null };
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const input = Array.isArray(items) ? items : [];
  const results = new Array(input.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit || 1), input.length || 1) }, async () => {
    while (true) {
      const index = next++;
      if (index >= input.length) return;
      results[index] = await worker(input[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function yahooHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (AlphaWeek V26)',
    'Accept': 'application/json,text/plain,*/*'
  };
}

function rawValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'raw')) return value.raw;
  return value;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return '';
}

function percentFromFraction(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return Math.abs(n) <= 1.5 ? n * 100 : n;
}

function yahooDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000).toISOString().slice(0, 10);
}

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
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
