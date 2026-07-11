/**
 * AlphaWeek — api/health.js
 * Version: v01 (Phase 1.2)
 *
 * รายงานสถานะข้อมูล: สัปดาห์ล่าสุดที่มีข้อมูล, จำนวน symbol, แหล่งข้อมูลที่ใช้, จำนวนข่าว
 * เปิดดูได้เลยไม่ต้องมี token (อ่านอย่างเดียว ไม่มีข้อมูลลับ)
 *
 * Env vars: APPS_SCRIPT_URL
 */

'use strict';

var FETCH_TIMEOUT_MS = 15000;

module.exports = async function handler(req, res) {
  if (!process.env.APPS_SCRIPT_URL) {
    return res.status(500).json({ ok: false, error: 'missing env: APPS_SCRIPT_URL' });
  }
  try {
    var json = await fetchJSON(process.env.APPS_SCRIPT_URL + '?action=dashboard');
    if (!json || !json.ok) {
      return res.status(502).json({ ok: false, error: 'apps script error', detail: json });
    }
    var d = json.data || {};
    var rows = d.rows || [];
    var sources = {};
    rows.forEach(function (r) {
      var s = r.source || 'unknown';
      sources[s] = (sources[s] || 0) + 1;
    });
    return res.status(200).json({
      ok: true,
      latest_week: d.week_ending || null,
      symbols: rows.length,
      sources: sources,
      news_count: (d.news || []).length,
      weeks_available: d.weeks_available || [],
      checked_at: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};

async function fetchJSON(url) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    var resp = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}
