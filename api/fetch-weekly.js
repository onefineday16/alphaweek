/**
 * AlphaWeek — api/fetch-weekly.js
 * Version: v09-financial-diagnostics (V26.2 per-symbol diagnostics and targeted retry)
 */
'use strict';


const API_VERSION = 'v09-financial-diagnostics';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YAHOO_QUOTE_SUMMARY_BASE = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/';
const YAHOO_QUOTE_BASE = 'https://query1.finance.yahoo.com/v7/finance/quote';
const SET_INDEX = { symbol: 'SET', yahoo: '^SET.BK' };
const PRICE_FETCH_TIMEOUT_MS = 12000;
const APPS_SCRIPT_TIMEOUT_MS = 12000;
const FINANCIAL_CORE_TIMEOUT_MS = 4500;
const FINANCIAL_ENRICH_TIMEOUT_MS = 3500;
const FINANCIAL_REQUEST_BUDGET_MS = 8500;
const PRICE_MAX_SYMBOLS_PER_REQUEST = 10;
const FINANCIAL_MAX_SYMBOLS_PER_REQUEST = 5;
const PRICE_FETCH_CONCURRENCY = 3;
const FINANCIAL_FETCH_CONCURRENCY = 2;
const CORE_FUNDAMENTAL_FIELDS = ['pe_ttm', 'pbv', 'dividend_yield_pct', 'market_cap', 'eps_ttm'];
const ENRICHMENT_FUNDAMENTAL_FIELDS = ['roe_pct', 'debt_to_equity', 'revenue_growth_yoy_pct', 'net_profit_growth_yoy_pct', 'financial_period'];
const ALL_FUNDAMENTAL_FIELDS = CORE_FUNDAMENTAL_FIELDS.concat(ENRICHMENT_FUNDAMENTAL_FIELDS);


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
      return res.status(400).json({ ok: false, api_version: API_VERSION, error: 'seed disabled in v08 route' });
    }
    const body = parseBody(req);
    const refreshType = normalizeRefreshType((body && body.refresh_type) || (req.query && req.query.refresh_type));
    const requestedSymbols = extractRequestedSymbols(req, body, refreshType);
    const universe = String((body && body.universe) || (req.query && req.query.universe) || 'watchlist');


    let result;
    let mode;
    if (refreshType === 'financial') {
      if (!requestedSymbols.length) {
        return res.status(400).json({ ok: false, api_version: API_VERSION, error: 'financial refresh requires 1-5 symbols' });
      }
      result = await runFinancialBatch(requestedSymbols, {
        universe,
        source: body && body.source,
        force: parseBoolean(body && body.force),
        maxAgeDays: clampNumber(body && body.max_age_days, 0, 30, 7),
        financialMode: normalizeFinancialMode(body && body.financial_mode)
      });
      mode = 'financial-batch';
    } else {
      result = requestedSymbols.length
        ? await runPriceBatch(requestedSymbols, { universe, source: body && body.source })
        : await runWeeklyPrices();
      mode = requestedSymbols.length ? 'price-batch' : 'weekly-prices';
    }


    const routeOk = refreshType === 'financial' ? !!result.operation_ok : !!result.save_ok;
    const transportOk = refreshType === 'financial' ? true : routeOk;
    return res.status(transportOk ? 200 : 502).json({
      ok: transportOk,
      refresh_type: refreshType,
      mode,
      auth_mode: isCron ? 'cron' : (isManualToken ? 'token' : 'public'),
      api_version: API_VERSION,
      refreshed_at: new Date().toISOString(),
      error: routeOk ? undefined : result.error,
      result
    });
  } catch (err) {
    return res.status(500).json({ ok: false, api_version: API_VERSION, error: normalizeErrorMessage(err, 'refresh route') });
  }
};


function normalizeRefreshType(value) {
  return String(value || 'prices').toLowerCase() === 'financial' ? 'financial' : 'prices';
}


function normalizeFinancialMode(value) {
  const mode = String(value || 'all').toLowerCase();
  return ['all', 'failed', 'missing'].includes(mode) ? mode : 'all';
}




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


function extractRequestedSymbols(req, body, refreshType) {
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
  const max = refreshType === 'financial' ? FINANCIAL_MAX_SYMBOLS_PER_REQUEST : PRICE_MAX_SYMBOLS_PER_REQUEST;
  if (out.length > max) throw new Error('too many symbols: max ' + max + ' for ' + refreshType);
  return out;
}


async function runWeeklyPrices() {
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
    action: 'saveWeeklyMerge',
    pin: process.env.ALPHAWEEK_PIN,
    week_ending: weekEnding,
    rows,
    news: existingNews,
    meta: { source: 'weekly-price-refresh', api_version: API_VERSION }
  }, 'Apps Script weekly price save');
  const saveOk = !!(saved && saved.ok);


  return {
    api_version: API_VERSION,
    refresh_type: 'prices',
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
    error: saveOk ? undefined : 'Apps Script saveWeeklyMerge failed: ' + String((saved && (saved.error || JSON.stringify(saved))) || 'empty response'),
    apps_script: saved
  };
}


async function runPriceBatch(symbolInputs, meta) {
  const symbols = normalizeSymbolList(symbolInputs);
  if (!symbols.length) throw new Error('symbols required for price batch');
  if (symbols.length > PRICE_MAX_SYMBOLS_PER_REQUEST) throw new Error('too many symbols: max ' + PRICE_MAX_SYMBOLS_PER_REQUEST);


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
  }, 'Apps Script price batch save');
  const saveOk = !!(saved && saved.ok);


  return {
    api_version: API_VERSION,
    refresh_type: 'prices',
    week_ending: weekEnding,
    universe: meta && meta.universe,
    symbols_requested: symbols.map((s) => s.symbol),
    symbols_ok: rows.length,
    symbols_ok_symbols: rows.map((r) => r.symbol),
    symbols_failed: errors,
    sources: countBy(rows, 'source'),
    save_mode: 'merge',
    save_ok: saveOk,
    error: saveOk ? undefined : 'Apps Script saveWeeklyMerge failed: ' + String((saved && (saved.error || JSON.stringify(saved))) || 'empty response'),
    apps_script: saved
  };
}


async function runFinancialBatch(symbolInputs, meta) {
  const symbols = normalizeSymbolList(symbolInputs).filter((s) => s.symbol !== 'SET');
  if (!symbols.length) throw new Error('symbols required for financial batch');
  if (symbols.length > FINANCIAL_MAX_SYMBOLS_PER_REQUEST) throw new Error('too many symbols: max ' + FINANCIAL_MAX_SYMBOLS_PER_REQUEST);


  const force = !!(meta && meta.force);
  const maxAgeDays = clampNumber(meta && meta.maxAgeDays, 0, 30, 7);
  const financialMode = normalizeFinancialMode(meta && meta.financialMode);
  const deadline = Date.now() + FINANCIAL_REQUEST_BUDGET_MS;
  let existingRows = [];
  const warnings = [];


  try {
    existingRows = await getExistingFundamentals(deadline);
  } catch (err) {
    warnings.push(buildWarning('', 'freshness-read', err, 'Apps Script fundamentals read'));
  }


  const existingMap = {};
  existingRows.forEach((row) => { existingMap[normalizeSymbolKey(row.symbol)] = row; });
  const pending = [];
  const symbolResults = [];


  symbols.forEach((symbol) => {
    const existing = existingMap[symbol.symbol] || null;
    const mayUseFreshCache = financialMode === 'all' && !force;
    if (mayUseFreshCache && isFreshFundamental(existing, maxAgeDays)) {
      symbolResults.push(buildFreshSymbolResult(symbol.symbol, existing));
    } else {
      pending.push(symbol);
    }
  });


  if (!pending.length) {
    const coverage = buildFinancialCoverage(symbolResults);
    return {
      api_version: API_VERSION,
      refresh_type: 'financial',
      financial_mode: financialMode,
      operation_ok: true,
      save_ok: true,
      symbols_requested: symbols.map((s) => s.symbol),
      symbols_refreshed: [],
      symbols_partial: [],
      symbols_skipped_fresh: symbolResults.filter((r) => r.status === 'fresh').map((r) => r.symbol),
      symbols_failed: [],
      symbol_results: symbolResults,
      coverage,
      warnings,
      max_age_days: maxAgeDays,
      force,
      saved_rows: 0,
      message: 'all requested fundamentals are still fresh'
    };
  }


  let coreRows = [];
  let coreBatchError = '';
  try {
    coreRows = await fetchYahooQuoteBatch(pending, deadline);
  } catch (err) {
    coreBatchError = normalizeErrorMessage(err, 'Yahoo financial core');
    warnings.push(buildWarning('', 'core', err, 'Yahoo financial core'));
  }
  const coreMap = {};
  coreRows.forEach((row) => { coreMap[normalizeSymbolKey(row.symbol)] = row; });


  const enrichmentResults = await mapWithConcurrency(pending, FINANCIAL_FETCH_CONCURRENCY, async (symbol) => {
    if (remainingBudget(deadline) < 700) {
      return { symbol: symbol.symbol, error: 'optional enrichment skipped: route budget nearly exhausted', code: 'BUDGET_EXHAUSTED', retryable: true };
    }
    try {
      const row = await fetchYahooSummaryFundamentals(symbol, deadline);
      return { symbol: symbol.symbol, row };
    } catch (err) {
      return {
        symbol: symbol.symbol,
        error: normalizeErrorMessage(err, 'Yahoo quoteSummary ' + symbol.symbol),
        code: errorCode(err),
        retryable: isRetryableError(err)
      };
    }
  });
  const enrichmentMap = {};
  const enrichmentResultMap = {};
  enrichmentResults.forEach((item) => {
    enrichmentResultMap[item.symbol] = item;
    if (item.row) enrichmentMap[item.symbol] = item.row;
  });


  const rows = [];
  const pendingDiagnostics = [];
  pending.forEach((symbol) => {
    const core = coreMap[symbol.symbol] || null;
    const enrichment = enrichmentMap[symbol.symbol] || null;
    const enrichmentResult = enrichmentResultMap[symbol.symbol] || null;
    const merged = mergeFundamentalRows(core, enrichment, symbol.symbol);
    const existing = existingMap[symbol.symbol] || null;
    const effective = mergeExistingFundamentalRow(existing, merged, symbol.symbol);


    if (enrichmentResult && enrichmentResult.error) {
      warnings.push({
        symbol: symbol.symbol,
        stage: 'enrichment',
        code: enrichmentResult.code || 'ENRICHMENT_FAILED',
        retryable: enrichmentResult.retryable !== false,
        error: enrichmentResult.error
      });
    }


    const diagnostic = buildFetchedSymbolResult({
      symbol: symbol.symbol,
      core,
      enrichment,
      merged: effective,
      providerRow: merged,
      existing,
      coreBatchError,
      enrichmentError: enrichmentResult && enrichmentResult.error,
      enrichmentCode: enrichmentResult && enrichmentResult.code,
      enrichmentRetryable: enrichmentResult && enrichmentResult.retryable
    });
    pendingDiagnostics.push(diagnostic);
    if (hasAnyFundamentalField(merged)) rows.push(merged);
  });


  const saved = await saveFundamentalsBestEffort(rows, {
    universe: meta && meta.universe,
    source: meta && meta.source,
    api_version: API_VERSION,
    financial_mode: financialMode,
    max_age_days: maxAgeDays,
    force
  });


  if (rows.length && !saved.ok) {
    pendingDiagnostics.forEach((result) => {
      if (result.status === 'failed') return;
      result.status = 'failed';
      result.stage = 'save';
      result.error_code = 'SAVE_FAILED';
      result.message = saved.error || 'Apps Script fundamentals save failed';
      result.retryable = true;
      result.saved = false;
    });
  } else if (saved.ok) {
    pendingDiagnostics.forEach((result) => {
      if (result.status !== 'failed') result.saved = true;
    });
  }


  symbolResults.push(...pendingDiagnostics);
  const refreshed = symbolResults.filter((r) => r.saved && ['updated', 'partial'].includes(r.status));
  const partial = symbolResults.filter((r) => r.status === 'partial');
  const fresh = symbolResults.filter((r) => r.status === 'fresh');
  const failed = symbolResults.filter((r) => r.status === 'failed');
  const coverage = buildFinancialCoverage(symbolResults);
  const operationOk = refreshed.length > 0 || fresh.length > 0;


  return {
    api_version: API_VERSION,
    refresh_type: 'financial',
    financial_mode: financialMode,
    operation_ok: operationOk,
    save_ok: rows.length ? saved.ok : fresh.length > 0,
    error: operationOk ? undefined : (saved.error || 'no financial rows saved'),
    symbols_requested: symbols.map((s) => s.symbol),
    symbols_refreshed: refreshed.map((r) => r.symbol),
    symbols_partial: partial.map((r) => r.symbol),
    symbols_skipped_fresh: fresh.map((r) => r.symbol),
    symbols_failed: failed.map((r) => ({ symbol: r.symbol, error: r.message, stage: r.stage, code: r.error_code, retryable: r.retryable })),
    symbol_results: symbolResults,
    coverage,
    warnings,
    max_age_days: maxAgeDays,
    force,
    sources: countBy(rows, 'source'),
    saved_rows: saved.ok ? refreshed.length : 0,
    apps_script: saved.response
  };
}


function buildFreshSymbolResult(symbol, row) {
  const fields = inspectFundamentalFields(row);
  return {
    symbol,
    status: 'fresh',
    core_status: fieldGroupStatus(fields.core_available, CORE_FUNDAMENTAL_FIELDS.length, 'cached'),
    enrichment_status: fieldGroupStatus(fields.enrichment_available, ENRICHMENT_FUNDAMENTAL_FIELDS.length, 'cached'),
    core_available: fields.core_available,
    enrichment_available: fields.enrichment_available,
    available_fields: fields.available_fields,
    missing_fields: fields.missing_fields,
    source: String((row && row.source) || 'stored'),
    fetched_at: String((row && (row.fetched_at || row.as_of_date)) || ''),
    stage: 'cache',
    error_code: '',
    message: fields.missing_fields.length ? 'Fresh cached data; some fields are unavailable' : 'Fresh cached data',
    retryable: fields.missing_fields.length > 0,
    saved: false
  };
}


function buildFetchedSymbolResult(input) {
  const merged = input.merged || {};
  const providerRow = input.providerRow || {};
  const fields = inspectFundamentalFields(merged);
  const providerFields = inspectFundamentalFields(providerRow);
  const hasProviderData = providerFields.available_fields.length > 0;
  if (!hasProviderData) {
    const providerMessage = input.enrichmentError || input.coreBatchError || 'no usable financial fields returned';
    const retained = fields.available_fields.length ? ' · Last-good stored values retained' : '';
    return {
      symbol: input.symbol,
      status: 'failed',
      core_status: input.coreBatchError ? 'failed' : 'missing',
      enrichment_status: input.enrichmentError ? 'failed' : 'missing',
      core_available: fields.core_available,
      enrichment_available: fields.enrichment_available,
      available_fields: fields.available_fields,
      missing_fields: fields.missing_fields,
      source: String((input.existing && input.existing.source) || ''),
      fetched_at: String((input.existing && (input.existing.fetched_at || input.existing.as_of_date)) || ''),
      stage: input.enrichmentError ? 'enrichment' : (input.coreBatchError ? 'core' : 'provider'),
      error_code: input.enrichmentCode || (input.coreBatchError ? 'CORE_FAILED' : 'NO_DATA'),
      message: providerMessage + retained,
      retryable: input.enrichmentRetryable !== false,
      saved: false
    };
  }


  const isPartial = fields.missing_fields.length > 0 || !!input.enrichmentError || !!input.coreBatchError;
  const missingMessage = fields.missing_fields.length ? 'Missing: ' + fields.missing_fields.join(', ') : '';
  const warningMessage = input.enrichmentError || input.coreBatchError || '';
  return {
    symbol: input.symbol,
    status: isPartial ? 'partial' : 'updated',
    core_status: fieldGroupStatus(fields.core_available, CORE_FUNDAMENTAL_FIELDS.length),
    enrichment_status: input.enrichmentError
      ? (fields.enrichment_available.length ? 'partial' : 'failed')
      : fieldGroupStatus(fields.enrichment_available, ENRICHMENT_FUNDAMENTAL_FIELDS.length),
    core_available: fields.core_available,
    enrichment_available: fields.enrichment_available,
    available_fields: fields.available_fields,
    missing_fields: fields.missing_fields,
    source: String(merged.source || ''),
    fetched_at: String(merged.fetched_at || merged.as_of_date || ''),
    stage: isPartial ? (input.enrichmentError ? 'enrichment' : (input.coreBatchError ? 'core' : 'coverage')) : 'saved',
    error_code: input.enrichmentCode || (input.coreBatchError ? 'CORE_PARTIAL' : ''),
    message: [warningMessage, missingMessage].filter(Boolean).join(' · ') || 'Financial data updated',
    retryable: isPartial,
    saved: false
  };
}


function mergeExistingFundamentalRow(existing, incoming, symbol) {
  const out = Object.assign({}, existing || {});
  Object.keys(incoming || {}).forEach((key) => {
    if (hasFieldValue(incoming[key])) out[key] = incoming[key];
  });
  out.symbol = symbol;
  if (!out.source && incoming && incoming.source) out.source = incoming.source;
  return cleanFundamentalRow(out);
}


function hasAnyFundamentalField(row) {
  return inspectFundamentalFields(row).available_fields.length > 0;
}


function inspectFundamentalFields(row) {
  const available = ALL_FUNDAMENTAL_FIELDS.filter((field) => hasFieldValue(row && row[field]));
  const coreAvailable = CORE_FUNDAMENTAL_FIELDS.filter((field) => available.includes(field));
  const enrichmentAvailable = ENRICHMENT_FUNDAMENTAL_FIELDS.filter((field) => available.includes(field));
  return {
    available_fields: available,
    missing_fields: ALL_FUNDAMENTAL_FIELDS.filter((field) => !available.includes(field)),
    core_available: coreAvailable,
    enrichment_available: enrichmentAvailable
  };
}


function hasFieldValue(value) {
  return value !== '' && value !== null && value !== undefined;
}


function fieldGroupStatus(available, total, prefix) {
  const count = Array.isArray(available) ? available.length : 0;
  const base = count === 0 ? 'missing' : (count >= total ? 'complete' : 'partial');
  return prefix ? prefix + '-' + base : base;
}


function buildFinancialCoverage(results) {
  const rows = Array.isArray(results) ? results : [];
  const fetchedTimes = rows.map((r) => Date.parse(r.fetched_at)).filter(Number.isFinite);
  return {
    requested: rows.length,
    core_covered: rows.filter((r) => (r.core_available || []).length > 0).length,
    full_covered: rows.filter((r) => (r.missing_fields || []).length === 0).length,
    updated: rows.filter((r) => r.status === 'updated').length,
    partial: rows.filter((r) => r.status === 'partial').length,
    fresh: rows.filter((r) => r.status === 'fresh').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    oldest_fetched_at: fetchedTimes.length ? new Date(Math.min(...fetchedTimes)).toISOString() : '',
    newest_fetched_at: fetchedTimes.length ? new Date(Math.max(...fetchedTimes)).toISOString() : ''
  };
}


function buildWarning(symbol, stage, err, fallbackStage) {
  return {
    symbol: symbol || '',
    stage,
    code: errorCode(err),
    retryable: isRetryableError(err),
    error: normalizeErrorMessage(err, fallbackStage || stage)
  };
}


function errorCode(err) {
  if (!err) return 'UNKNOWN';
  if (err.code === 'ETIMEDOUT') return 'TIMEOUT';
  const status = Number(err.status);
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'UPSTREAM_5XX';
  if (status >= 400) return 'UPSTREAM_4XX';
  const message = String(err.message || err);
  if (/budget/i.test(message)) return 'BUDGET_EXHAUSTED';
  if (/empty result|no usable/i.test(message)) return 'NO_DATA';
  return 'PROVIDER_ERROR';
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
  const json = await fetchJSON(process.env.APPS_SCRIPT_URL + '?action=watchlist', {}, { stage: 'Apps Script watchlist read', timeoutMs: APPS_SCRIPT_TIMEOUT_MS });
  if (!json || !json.ok) throw new Error('watchlist fetch failed: ' + JSON.stringify(json));
  return json.data || [];
}


async function getExistingNews(weekEnding) {
  try {
    const json = await fetchJSON(process.env.APPS_SCRIPT_URL + '?action=dashboard&week=' + encodeURIComponent(weekEnding), {}, { stage: 'Apps Script news read', timeoutMs: APPS_SCRIPT_TIMEOUT_MS });
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
  return mapWithConcurrency(symbols, PRICE_FETCH_CONCURRENCY, async (s) => {
    try {
      return { symbol: s.symbol, bars: await fetchYahooBars(s.yahoo, range), source: 'yahoo_chart' };
    } catch (err) {
      return { symbol: s.symbol, error: String(err && err.message || err) };
    }
  });
}


async function fetchYahooBars(yahooSymbol, range) {
  const url = YAHOO_BASE + encodeURIComponent(yahooSymbol) + '?range=' + encodeURIComponent(range) + '&interval=1d';
  const json = await fetchJSON(url, { headers: { 'User-Agent': 'Mozilla/5.0 (AlphaWeek V26.2)' } }, { stage: 'Yahoo chart ' + yahooSymbol, timeoutMs: PRICE_FETCH_TIMEOUT_MS });
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




async function getExistingFundamentals(deadline) {
  const url = process.env.APPS_SCRIPT_URL + '?action=fundamentals';
  const json = await fetchJSON(url, {}, {
    stage: 'Apps Script fundamentals read',
    timeoutMs: Math.min(APPS_SCRIPT_TIMEOUT_MS, Math.max(500, remainingBudget(deadline))),
    deadline
  });
  if (!json || !json.ok) throw new Error('fundamentals read failed: ' + JSON.stringify(json));
  return Array.isArray(json.data) ? json.data : [];
}


async function fetchYahooQuoteBatch(symbols, deadline) {
  if (!symbols.length) return [];
  const url = YAHOO_QUOTE_BASE + '?symbols=' + encodeURIComponent(symbols.map((s) => s.yahoo).join(','));
  const json = await fetchJSONWithRetry(url, { headers: yahooHeaders() }, {
    stage: 'Yahoo financial core batch',
    timeoutMs: FINANCIAL_CORE_TIMEOUT_MS,
    deadline,
    retry: true
  });
  const results = json && json.quoteResponse && Array.isArray(json.quoteResponse.result) ? json.quoteResponse.result : [];
  return results.map((q) => {
    const symbol = normalizeSymbolKey(q.symbol);
    return normalizeQuoteFundamentals(symbol, q);
  }).filter(hasCoreFundamental);
}


async function fetchYahooSummaryFundamentals(symbol, deadline) {
  const modules = 'price,summaryDetail,defaultKeyStatistics,financialData';
  const summaryUrl = YAHOO_QUOTE_SUMMARY_BASE + encodeURIComponent(symbol.yahoo) +
    '?modules=' + encodeURIComponent(modules);
  const json = await fetchJSONWithRetry(summaryUrl, { headers: yahooHeaders() }, {
    stage: 'Yahoo quoteSummary ' + symbol.symbol,
    timeoutMs: FINANCIAL_ENRICH_TIMEOUT_MS,
    deadline,
    retry: true
  });
  const result = json && json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
  if (!result) throw new Error('quoteSummary empty result');
  const row = normalizeQuoteSummaryFundamentals(symbol.symbol, result);
  if (!hasCoreFundamental(row)) throw new Error('quoteSummary returned no usable fundamentals');
  return row;
}


function mergeFundamentalRows(core, enrichment, symbol) {
  const fetchedAt = new Date().toISOString();
  const base = cleanFundamentalRow(Object.assign({
    symbol,
    as_of_date: fetchedAt.slice(0, 10),
    pe_ttm: '', pbv: '', dividend_yield_pct: '', market_cap: '', eps_ttm: '',
    roe_pct: '', debt_to_equity: '', revenue_growth_yoy_pct: '', net_profit_growth_yoy_pct: '',
    financial_period: '', source: '', fetched_at: fetchedAt
  }, core || {}));
  const extra = enrichment || {};
  Object.keys(extra).forEach((key) => {
    if (extra[key] !== '' && extra[key] !== null && extra[key] !== undefined) base[key] = extra[key];
  });
  base.symbol = symbol;
  base.fetched_at = fetchedAt;
  if (core && enrichment) base.source = 'yahoo_quote+yahoo_quoteSummary';
  else if (enrichment) base.source = enrichment.source || 'yahoo_quoteSummary';
  else if (core) base.source = core.source || 'yahoo_quote';
  return cleanFundamentalRow(base);
}


function isFreshFundamental(row, maxAgeDays) {
  if (!row || maxAgeDays <= 0) return false;
  const raw = row.fetched_at || row.as_of_date;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return false;
  const age = Date.now() - time;
  return age >= 0 && age <= maxAgeDays * 86400000;
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
      const raw = out[key];
      if (raw === '' || raw === null || raw === undefined) { out[key] = ''; return; }
      const n = Number(raw);
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
    }, 'Apps Script fundamentals save');
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
    'User-Agent': 'Mozilla/5.0 (AlphaWeek V26.2)',
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


async function postToAppsScript(payload, stage) {
  const resp = await fetchWithTimeout(process.env.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  }, { stage: stage || 'Apps Script write', timeoutMs: APPS_SCRIPT_TIMEOUT_MS });
  const text = await resp.text();
  if (!resp.ok) throw httpError(resp.status, (stage || 'Apps Script write') + ': ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch (err) { throw new Error((stage || 'Apps Script write') + ' returned non-JSON: ' + text.slice(0, 200)); }
}


async function fetchJSON(url, opts, meta) {
  const resp = await fetchWithTimeout(url, Object.assign({ redirect: 'follow' }, opts || {}), meta || {});
  if (!resp.ok) throw httpError(resp.status, (meta && meta.stage ? meta.stage + ': ' : '') + 'HTTP ' + resp.status);
  return resp.json();
}


async function fetchJSONWithRetry(url, opts, meta) {
  const settings = Object.assign({ retry: false }, meta || {});
  const attempts = settings.retry ? 2 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchJSON(url, opts, settings);
    } catch (err) {
      lastError = err;
      const canRetry = attempt < attempts && isRetryableError(err) && remainingBudget(settings.deadline) > 900;
      if (!canRetry) throw err;
      await sleep(180);
    }
  }
  throw lastError;
}


async function fetchWithTimeout(url, opts, meta) {
  const settings = meta || {};
  const stage = settings.stage || 'external request';
  const remaining = remainingBudget(settings.deadline);
  let timeoutMs = Number(settings.timeoutMs || PRICE_FETCH_TIMEOUT_MS);
  if (Number.isFinite(remaining)) timeoutMs = Math.min(timeoutMs, Math.max(250, remaining - 100));
  if (timeoutMs <= 250 && Number.isFinite(remaining) && remaining <= 250) {
    throw new Error(stage + ' skipped: route budget exhausted');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, opts || {}, { signal: controller.signal }));
  } catch (err) {
    if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || err)))) {
      const timeoutError = new Error(stage + ' timed out after ' + timeoutMs + 'ms');
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}


function httpError(status, message) {
  const err = new Error(message || ('HTTP ' + status));
  err.status = Number(status);
  return err;
}


function isRetryableError(err) {
  const status = Number(err && err.status);
  return !!(err && err.code === 'ETIMEDOUT') || status === 429 || status >= 500;
}


function normalizeErrorMessage(err, fallbackStage) {
  if (!err) return (fallbackStage || 'operation') + ' failed';
  const message = String(err.message || err);
  if (/this operation was aborted|aborterror|\baborted\b/i.test(message)) {
    return (fallbackStage || 'external request') + ' timed out or was cancelled';
  }
  return message;
}


function remainingBudget(deadline) {
  if (!deadline) return Infinity;
  return Math.max(0, Number(deadline) - Date.now());
}


function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}


function parseBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true' || String(value) === '1';
}


function normalizeSymbolKey(input) {
  let raw = String(input || '').trim().toUpperCase().replace(/\s+/g, '');
  raw = raw.replace(/^SET:/, '').replace(/\.BK$/, '');
  return raw === '^SET' ? 'SET' : raw;
}


function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }


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