'use strict';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const date = value => value ? new Date(value).toLocaleString('th-TH', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Bangkok'}) : 'ยังไม่มีข้อมูล';
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('th-TH', {maximumFractionDigits:2, minimumFractionDigits:2}) : '—';
const signed = value => typeof value === 'number' && Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${number(value)}%` : '—';
const stanceRank = {interesting:0, caution:1, wait:2, insufficient:3};
const stanceClass = {interesting:'positive', caution:'risk', wait:'wait', insufficient:'muted'};
const signals = {risk:'พบคำเกี่ยวกับความเสี่ยง', mixed:'พบทั้งประเด็นบวกและความเสี่ยง', catalyst:'พบคำเกี่ยวกับเหตุการณ์ใหม่', research:'อ่านบริบทเพิ่มเติม'};
const views = {
  desk:['ภาพรวมวันนี้','เห็นสิ่งที่ควรตรวจต่อ พร้อมหลักฐานและข้อมูลที่ยังขาด'],
  discover:['ค้นและวิเคราะห์','ค้นหุ้นสามัญใน SET/mai แล้วสร้างแฟ้มวิเคราะห์จากข้อมูลที่หาได้'],
  compare:['เปรียบเทียบ','เทียบหลักฐานของหุ้นที่วิเคราะห์แล้วได้สูงสุด 3 ตัว'],
  watch:['รายการติดตาม','กลับมาดูมุมมองล่าสุดและสิ่งที่เปลี่ยนของหุ้นที่เลือกไว้'],
  news:['ข่าวและธีม','อ่านข่าวที่ระบบได้รับและเปิดต้นทางก่อนใช้ประกอบการตัดสินใจ'],
  sources:['สถานะข้อมูล','ตรวจแหล่ง เวลา ขอบเขต และข้อมูลสำคัญที่ระบบยังไม่มี']
};
const errors = {
  NEWS_COOLDOWN:'อัปเดตข่าวได้ทุก 15 นาที ใช้ชุดที่บันทึกไว้ก่อนได้ครับ',
  MARKET_COOLDOWN:'อัปเดตราคารวมได้ทุก 5 นาที ใช้ภาพข้อมูลที่บันทึกไว้ก่อนได้',
  UNIVERSE_COOLDOWN:'รายชื่อหุ้นเพิ่งดึงไม่สำเร็จ กรุณารอสักครู่แล้วลองใหม่',
  ANALYSIS_DAILY_LIMIT:'ถึงขีดจำกัดทดลอง 60 การวิเคราะห์ต่อวันแล้ว',
  REFRESH_BUSY:'ระบบกำลังดึงข้อมูลอีกงาน กรุณารอให้จบก่อน',
  PRICE_COOLDOWN:'ดึง EODHD ได้ทุก 1 ชั่วโมง',
  EODHD_KEY_REQUIRED:'ยังไม่ได้เชื่อม EODHD Free',
  FREE_ACCOUNT_CONFIRMATION_REQUIRED:'ต้องยืนยันบัญชี EODHD Free ในตัวเปิดโปรแกรมก่อน',
  FREE_ACCOUNT_NOT_VERIFIED:'ระบบยืนยันสิทธิ์แผนฟรีไม่ได้ จึงหยุดก่อนดึงข้อมูล',
  LOCAL_DAILY_LIMIT:'ถึงขีดจำกัด EODHD ฝั่งเครื่องแล้ว',
  TOKEN_REQUIRED:'เซสชันเปลี่ยนแล้ว กรุณาโหลดหน้าใหม่',
  NETWORK_UNAVAILABLE:'เชื่อมต่อแหล่งข้อมูลไม่ได้ ชุดเดิมยังอยู่ ลองใหม่ภายหลัง',
  NO_CHART_DATA:'แหล่งข้อมูลยังไม่ส่งกราฟที่ใช้วิเคราะห์หุ้นนี้',
  MARKET_QUOTE_MISSING:'แหล่งข้อมูลยังไม่ส่งราคาของหุ้นนี้',
  INVALID_SEARCH:'พิมพ์ชื่อย่อหุ้นหรือชื่อบริษัท 1–50 ตัวอักษร',
  LOCAL_OPERATION_FAILED:'บันทึกหรืออ่านข้อมูลบนเครื่องไม่สำเร็จ กรุณาตรวจสิทธิ์โฟลเดอร์'
};

let state;
let view = 'desk';
let busy = false;
let searchResults = [];
const compareSet = new Set();

function notice(message, error = false) {
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
}

async function api(path, payload) {
  const options = payload === undefined ? {cache:'no-store'} : {method:'POST', headers:{'Content-Type':'application/json', 'X-Radar-Token':state.csrf}, body:JSON.stringify(payload)};
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(errors[result.error] || `ทำรายการไม่สำเร็จ (${result.error || response.status})`);
  return result;
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll('button').forEach(button => {
    if (button.id !== 'close-analysis') button.disabled = value || (button.id === 'eod-refresh' && !state?.priceConfiguration.enabled);
  });
  $('#refresh').textContent = value ? 'กำลังทำรายการ…' : '↻ อัปเดตข่าว';
}

function currentAnalysis(symbol) {
  return state.analyses?.[symbol]?.current || null;
}

function watchButton(symbol) {
  const decision = state.decisions[symbol]?.choice;
  return `<button data-choice="${decision === 'watch' ? 'clear' : 'watch'}" data-symbol="${esc(symbol)}">${decision === 'watch' ? '✓ ติดตามอยู่' : '☆ ติดตาม'}</button>`;
}

function compareButton(symbol) {
  const selected = compareSet.has(symbol);
  return `<button data-compare="${esc(symbol)}" aria-pressed="${selected}">${selected ? '✓ อยู่ในตารางเทียบ' : '⇄ เพิ่มเพื่อเทียบ'}</button>`;
}

function fillThemes() {
  const previous = $('#theme').value;
  const themes = new Map(state.news.flatMap(story => story.themes.map(theme => [theme.id, theme.label])));
  $('#theme').innerHTML = '<option value="all">ทุกธีม</option>' + [...themes].map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
  if (themes.has(previous)) $('#theme').value = previous;
}

function matchesNews(story) {
  const query = $('#news-search').value.trim().toLowerCase();
  return ($('#source').value === 'all' || story.source === $('#source').value)
    && ($('#theme').value === 'all' || story.themes.some(theme => theme.id === $('#theme').value))
    && (!query || `${story.title} ${story.excerpt} ${story.symbols.join(' ')}`.toLowerCase().includes(query));
}

function newsCard(story) {
  return `<article class="news-item"><div class="card-top"><span class="meta">${esc(story.sourceName)} · ${esc(date(story.publishedAt))} น.</span><span class="pill ${story.kind === 'press_release' ? 'pr' : ''}">${story.kind === 'press_release' ? 'ประชาสัมพันธ์' : 'ข่าว'}</span></div>
    <h3><a href="${esc(story.url)}" target="_blank" rel="noopener noreferrer">${esc(story.title)}</a></h3><p>${esc(story.excerpt)}</p>
    <div class="tags">${story.themes.map(theme => `<span>${esc(theme.label)}</span>`).join('')}${story.symbols.map(symbol => `<span>พบชื่อ ${esc(symbol)}</span>`).join('')}${story.stale ? '<span>เกิน 72 ชม.</span>' : ''}</div>
    <div class="meta">${esc(signals[story.signal])} · จัดกลุ่มจากคำในข้อความย่อ</div></article>`;
}

function analysisCard(analysis) {
  return `<article class="analysis-card ${stanceClass[analysis.stance] || ''}">
    <div class="card-top"><div><span class="symbol">${esc(analysis.symbol)}</span><span class="market">${esc(analysis.company?.market || '')}</span></div><span class="pill ${stanceClass[analysis.stance] || ''}">${esc(analysis.stanceLabel)}</span></div>
    <p class="company">${esc(analysis.company?.name || analysis.symbol)}</p>
    <div class="signal-row"><div><small>ราคาล่าสุด</small><strong>${number(analysis.last)}</strong><span>บาท</span></div><div><small>ช่วงข้อมูล</small><strong>${signed(analysis.shortChangePercent)}</strong><span>${analysis.daily?.length || 0} วัน</span></div><div><small>ข่าวที่พบ</small><strong>${analysis.newsCount}</strong><span>รายการ</span></div></div>
    <p class="reason">${esc(analysis.reason)}</p>
    <p class="change">${esc(analysis.changes?.[0] || '')}</p>
    <div class="actions"><button class="primary-soft" data-analysis="${esc(analysis.symbol)}">เปิดแฟ้มวิเคราะห์</button>${compareButton(analysis.symbol)}${watchButton(analysis.symbol)}</div>
  </article>`;
}

function searchResultCard(row) {
  const analysis = currentAnalysis(row.symbol);
  return `<article class="search-result"><div><div class="card-top"><span class="symbol">${esc(row.symbol)}</span><span class="pill">${esc(row.market)}</span></div><h3>${esc(row.name)}</h3><p>หุ้นสามัญ · ${esc(row.currency)}${row.lotSize ? ` · หน่วยซื้อขาย ${esc(row.lotSize)}` : ''}</p></div>
    <div class="actions"><button class="primary" data-analyze="${esc(row.symbol)}">${analysis ? 'อัปเดตการวิเคราะห์' : 'วิเคราะห์หุ้นนี้'}</button>${analysis ? `<button data-analysis="${esc(row.symbol)}">ดูผลล่าสุด</button>${compareButton(row.symbol)}` : ''}${watchButton(row.symbol)}</div></article>`;
}

function empty(title, message, action = '') {
  return `<div class="empty"><h2>${esc(title)}</h2><p>${esc(message)}</p>${action}</div>`;
}

function renderDesk() {
  const analyses = Object.values(state.analyses || {}).map(record => record.current).filter(Boolean).sort((a, b) => (stanceRank[a.stance] ?? 9) - (stanceRank[b.stance] ?? 9) || b.createdAt.localeCompare(a.createdAt));
  const watched = Object.values(state.decisions).filter(decision => decision.choice === 'watch').length;
  const lead = analyses.length ? `<div class="section-label"><div><p class="eyebrow">LATEST RESEARCH</p><h2>หุ้นที่ระบบช่วยสรุปแล้ว</h2></div><small>${analyses.length} แฟ้ม · เรียงจากมุมมองที่ควรตรวจต่อก่อน</small></div><div class="grid">${analyses.slice(0, 6).map(analysisCard).join('')}</div>` :
    empty('เริ่มจากหุ้นที่คุณอยากรู้จัก', 'ค้นชื่อย่อหรือชื่อบริษัท ระบบจะดึงราคาและประวัติระยะสั้น สรุปข่าว หลักฐานค้าน และเงื่อนไขที่ควรตรวจก่อนซื้อ', '<button data-go="discover" class="primary">ค้นหุ้นตัวแรก</button>');
  const candidates = state.candidates.filter(row => !currentAnalysis(row.symbol)).slice(0, 6);
  return `<section class="brief"><div><span>RESEARCH QUEUE</span><strong>${analyses.length}</strong><p>แฟ้มที่วิเคราะห์แล้ว</p></div><div><span>WATCHLIST</span><strong>${watched}</strong><p>หุ้นที่คุณติดตาม</p></div><div><span>NEWS RADAR</span><strong>${state.candidates.length}</strong><p>หุ้นที่พบในข่าว 72 ชม.</p></div></section>${lead}` +
    (candidates.length ? `<div class="section-label secondary-heading"><div><p class="eyebrow">FROM NEWS RADAR</p><h2>มีข่าวใหม่ แต่ยังไม่ได้วิเคราะห์</h2></div><small>กดวิเคราะห์เพื่อดูราคา หลักฐานค้าน และข้อมูลที่ขาด</small></div><div class="compact-grid">${candidates.map(row => `<article class="idea"><div><span class="symbol">${esc(row.symbol)}</span><span class="pill ${row.status === 'ทบทวนความเสี่ยง' ? 'risk' : ''}">${esc(row.status)}</span></div><h3>${esc(row.news[0].title)}</h3><p>${esc(row.question)}</p><button data-analyze="${esc(row.symbol)}">วิเคราะห์ ${esc(row.symbol)}</button></article>`).join('')}</div>` : '');
}

function renderDiscover() {
  const analyses = Object.values(state.analyses || {}).map(record => record.current).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const result = searchResults.length ? `<div class="section-label"><h2>ผลค้นหา</h2><small>${searchResults.length} รายการจากหุ้นสามัญ SET/mai</small></div><div class="search-results">${searchResults.map(searchResultCard).join('')}</div>` :
    `<div class="search-guide"><div><span class="guide-number">01</span><h3>ค้นหุ้น</h3><p>พิมพ์ชื่อย่อ เช่น AOT หรือชื่อบริษัทภาษาอังกฤษ</p></div><div><span class="guide-number">02</span><h3>ดึงหลักฐาน</h3><p>ราคาล่าสุด กราฟระยะสั้น และข่าว RSS ที่พบชื่อหุ้น</p></div><div><span class="guide-number">03</span><h3>ตัดสินใจเอง</h3><p>อ่านหลักฐานค้าน ช่องว่างข้อมูล และตรวจงบก่อนกดยืนยันกับโบรกเกอร์</p></div></div>`;
  return `<form id="symbol-search-form" class="symbol-search"><label for="symbol-query">ค้นในรายชื่อหุ้นสามัญ SET/mai</label><div><input id="symbol-query" name="query" maxlength="50" autocomplete="off" placeholder="เช่น PTT, AOT, Advanced Info Service" required><button class="primary" type="submit">ค้นหา</button></div><small>โหลดรายชื่อจาก TopTrader Public ครั้งแรกและเก็บแคชบนเครื่อง 24 ชั่วโมง</small></form>${result}` +
    (analyses.length ? `<div class="section-label secondary-heading"><h2>วิเคราะห์ล่าสุด</h2><small>${analyses.length} แฟ้ม</small></div><div class="grid">${analyses.map(analysisCard).join('')}</div>` : '');
}

function renderCompare() {
  const selected = [...compareSet].map(currentAnalysis).filter(Boolean);
  const available = Object.values(state.analyses || {}).map(record => record.current).filter(Boolean).filter(analysis => !compareSet.has(analysis.symbol));
  const picker = `<div class="compare-picker"><span>เลือกแล้ว ${selected.length}/3</span>${available.map(analysis => `<button data-compare="${esc(analysis.symbol)}">+ ${esc(analysis.symbol)}</button>`).join('')}</div>`;
  if (!selected.length) return picker + empty('ยังไม่มีหุ้นในตารางเปรียบเทียบ', 'วิเคราะห์หุ้นก่อน แล้วกด “เพิ่มเพื่อเทียบ” ได้สูงสุด 3 ตัว');
  const rows = [
    ['มุมมอง', analysis => analysis.stanceLabel], ['ราคาล่าสุด', analysis => `${number(analysis.last)} บาท`],
    ['การเปลี่ยนแปลงในชุด', analysis => signed(analysis.shortChangePercent)], ['ช่วงข้อมูล', analysis => `${analysis.daily?.length || 0} วัน`],
    ['ข่าวที่พบ', analysis => `${analysis.newsCount} รายการ`], ['ความครอบคลุม', analysis => analysis.coverage === 'medium' ? 'ปานกลาง' : 'ต่ำ'],
    ['เหตุผลหลัก', analysis => analysis.reason], ['หลักฐานค้านแรก', analysis => analysis.opposingEvidence?.[0] || '—'],
    ['ข้อมูลที่ต้องหาเพิ่ม', analysis => analysis.dataGaps?.[0] || '—']
  ];
  return picker + `<div class="compare-wrap"><table><thead><tr><th>หัวข้อ</th>${selected.map(analysis => `<th><span class="symbol">${esc(analysis.symbol)}</span><button class="remove" data-compare="${esc(analysis.symbol)}" aria-label="นำ ${esc(analysis.symbol)} ออกจากตาราง">×</button></th>`).join('')}</tr></thead><tbody>${rows.map(([label, getter]) => `<tr><th>${esc(label)}</th>${selected.map(analysis => `<td>${esc(getter(analysis))}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="table-note">ตารางนี้เทียบเฉพาะข้อมูลที่ระบบมี ไม่จัดอันดับความน่าซื้อและไม่ชดเชยข้อมูลพื้นฐานที่ขาด</p>`;
}

function renderWatch() {
  const watched = Object.entries(state.decisions).filter(([, decision]) => decision.choice === 'watch').sort((a, b) => b[1].at.localeCompare(a[1].at));
  if (!watched.length) return empty('ยังไม่มีหุ้นที่ติดตาม', 'กด “ติดตาม” จากผลค้นหาหรือแฟ้มวิเคราะห์ เพื่อสร้างรายการกลับมาตรวจภายหลัง');
  return `<div class="watch-list">${watched.map(([symbol, decision]) => { const analysis = currentAnalysis(symbol); return analysis ? analysisCard(analysis) : `<article class="search-result"><div><span class="symbol">${esc(symbol)}</span><p>ติดตามเมื่อ ${esc(date(decision.at))} น. · ยังไม่มีแฟ้มวิเคราะห์</p></div><div class="actions"><button class="primary" data-analyze="${esc(symbol)}">วิเคราะห์ตอนนี้</button>${watchButton(symbol)}</div></article>`; }).join('')}</div>`;
}

function renderNews() {
  const rows = state.news.filter(matchesNews);
  return `<div class="section-label"><h2>ข่าวที่ได้รับ</h2><small>${rows.length} รายการ · เก็บสูงสุด 7 วัน</small></div><div class="news-list">${rows.length ? rows.map(newsCard).join('') : empty('ยังไม่มีข่าวตรงกับเงื่อนไข', 'กดอัปเดตข่าวหรือล้างตัวกรอง แล้วตรวจสถานะแหล่งข้อมูล')}</div>`;
}

function renderSources() {
  const newsSources = [
    {id:'infoquest', name:'InfoQuest · หมวดหุ้น', url:'https://www.infoquest.co.th/stock/feed', note:'หัวข้อและข้อความย่อรวมไม่เกิน 200 ตัวอักษรต่อข่าว พร้อมลิงก์ต้นทาง'},
    {id:'thaipr', name:'ThaiPR.NET · การเงิน', url:'https://www.thaipr.net/finance/feed', note:'ข่าวประชาสัมพันธ์ ต้องตรวจประกาศบริษัทและหลักฐานอิสระประกอบ'}
  ];
  const newsRows = newsSources.map(source => { const live = state.sources[source.id]; return `<article class="source-card"><div class="card-top"><h3>${esc(source.name)}</h3><span class="pill ${live?.status === 'error' ? 'risk' : ''}">${live?.status === 'ok' ? 'รอบล่าสุดสำเร็จ' : live ? 'รอบล่าสุดไม่สำเร็จ' : 'ยังไม่ได้ดึง'}</span></div><p>${esc(source.note)}<br>สำเร็จล่าสุด: ${esc(date(live?.lastSuccessAt))} · รับ ${live?.received ?? 0} รายการ${live?.error ? `<br>รหัส: ${esc(live.error)}` : ''}</p><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">เปิด RSS ต้นทาง ↗</a></article>`; }).join('');
  return `<div class="source-grid">${newsRows}
    <article class="source-card feature"><div class="card-top"><h3>รายชื่อหุ้น ราคา และกราฟ · TopTrader Public</h3><span class="pill positive">ไม่ต้องสมัคร</span></div><p>หุ้นสามัญในแคช ${state.universeCount} ตัว · รายชื่อสถานะ ${esc(state.universeSource?.status || 'ยังไม่โหลด')} · ตรวจ ${esc(date(state.universeSource?.checkedAt))} น.</p><p>ราคาเป็นภาพข้อมูลตามเวลาที่ผู้ให้บริการระบุ กราฟรายนาทีครอบคลุมเท่าที่ API ส่งมา ไม่รับรอง real-time หรือประวัติปรับสิทธิ์ครบชุด</p><p>ราคาชุดรวมล่าสุด: ${state.marketSource?.received ?? 0}/${state.marketSource?.requested ?? 0} ตัว · ${esc(state.marketSource?.status || 'ยังไม่ได้ดึง')}</p><button id="price-refresh">อัปเดตราคาชุดติดตาม</button> <a href="https://developers.toptrader.co.th/docs/" target="_blank" rel="noopener noreferrer">เอกสารผู้ให้บริการ ↗</a></article>
    <article class="source-card"><div class="card-top"><h3>EODHD Free · ตัวเลือกเสริม</h3><span class="pill">${state.priceConfiguration.enabled ? 'ตั้งค่าแล้ว' : 'ยังไม่เชื่อม'}</span></div><p>ใช้เฉพาะเมื่อคุณมีบัญชีฟรีและเปิด <code>Start-Radar-With-Prices.cmd</code> ระบบไม่บันทึก key และหยุดหากยืนยันแผนฟรีไม่ได้</p><button id="eod-refresh" ${state.priceConfiguration.enabled ? '' : 'disabled'}>ดึงย้อนหลัง EODHD</button></article>
    <article class="source-card"><h3>ข้อมูลที่ยังไม่มีอัตโนมัติ</h3><ul>${state.limitations.map(item => `<li>${esc(item)}</li>`).join('')}</ul><p><a href="https://www.set.or.th/th/market/news-and-alert/news?newsType=company" target="_blank" rel="noopener noreferrer">ประกาศบริษัท · SET ↗</a> · <a href="https://secopendata.sec.or.th/datasets" target="_blank" rel="noopener noreferrer">SEC Open Data ↗</a></p></article></div>`;
}

function render() {
  if (!state) return;
  $('#page-title').textContent = views[view][0];
  $('#page-subtitle').textContent = views[view][1];
  document.querySelectorAll('nav button').forEach(button => button.dataset.view === view ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current'));
  $('#news-filters').hidden = view !== 'news';
  const recent = state.news.filter(story => !story.stale).length;
  const watched = Object.values(state.decisions).filter(decision => decision.choice === 'watch').length;
  $('#metrics').innerHTML = [[state.universeCount, 'หุ้นที่ค้นได้', 'หุ้นสามัญ SET/mai ในแคช'], [Object.keys(state.analyses || {}).length, 'แฟ้มวิเคราะห์', 'บันทึกผลล่าสุดบนเครื่อง'], [watched, 'หุ้นติดตาม', 'กลับมาตรวจซ้ำได้'], [recent, 'ข่าวใน 72 ชม.', 'จาก RSS ที่ได้รับ']].map(([value, label, note]) => `<div class="metric"><span>${esc(label)}</span><strong>${value}</strong><small>${esc(note)}</small></div>`).join('');
  const renderers = {desk:renderDesk, discover:renderDiscover, compare:renderCompare, watch:renderWatch, news:renderNews, sources:renderSources};
  $('#content').innerHTML = renderers[view]();
  setBusy(busy);
}

function analysisDialog(analysis) {
  const coverage = analysis.coverage === 'medium' ? 'ปานกลาง' : 'ต่ำ';
  const dailyRows = analysis.daily?.map(day => `<tr><td>${esc(day.date)}</td><td>${number(day.open)}</td><td>${number(day.high)}</td><td>${number(day.low)}</td><td>${number(day.close)}</td><td>${day.bars}</td></tr>`).join('') || '';
  $('#analysis-body').innerHTML = `<p class="eyebrow">RESEARCH FILE · ${esc(analysis.ruleVersion)}</p><div class="analysis-heading"><div><h2 id="analysis-title">${esc(analysis.symbol)}</h2><p>${esc(analysis.company?.name || '')} · ${esc(analysis.company?.market || '')}</p></div><span class="pill ${stanceClass[analysis.stance] || ''}">${esc(analysis.stanceLabel)}</span></div>
    <section class="verdict"><div><span>มุมมองจากข้อมูลที่มี</span><strong>${esc(analysis.stanceLabel)}</strong><p>${esc(analysis.reason)}</p></div><dl><div><dt>ราคา</dt><dd>${number(analysis.last)} บาท</dd></div><div><dt>ช่วงข้อมูล</dt><dd>${signed(analysis.shortChangePercent)}</dd></div><div><dt>กรอบติดตาม</dt><dd>${esc(analysis.horizon)}</dd></div><div><dt>ความครอบคลุม</dt><dd>${coverage}</dd></div></dl></section>
    <section class="analysis-section"><h3>สิ่งที่เปลี่ยนจากครั้งก่อน</h3><ul class="change-list">${analysis.changes.map(item => `<li>${esc(item)}</li>`).join('')}</ul></section>
    <div class="evidence-grid"><section class="analysis-section"><h3>หลักฐานที่ใช้</h3>${analysis.evidence.length ? analysis.evidence.map(item => `<div class="evidence"><strong>${esc(item.value)}</strong><span>${esc(item.label)}</span><small>${esc(item.source)} · ${esc(date(item.observedAt))}</small></div>`).join('') : '<p>ยังไม่มีหลักฐานเพียงพอ</p>'}</section><section class="analysis-section opposing"><h3>หลักฐานค้าน / เหตุให้ระวัง</h3><ul>${analysis.opposingEvidence.map(item => `<li>${esc(item)}</li>`).join('')}</ul></section></div>
    <div class="evidence-grid"><section class="analysis-section"><h3>ก่อนพิจารณาซื้อ</h3><ol>${analysis.beforeBuy.map(item => `<li>${esc(item)}</li>`).join('')}</ol></section><section class="analysis-section"><h3>ถ้าถืออยู่ ควรทบทวนเมื่อ</h3><ul>${analysis.holdingReview.map(item => `<li>${esc(item)}</li>`).join('')}</ul></section></div>
    ${dailyRows ? `<section class="analysis-section"><h3>สรุปกราฟรายนาทีเป็นรายวัน</h3><div class="mini-table"><table><thead><tr><th>วันที่</th><th>เปิด</th><th>สูง</th><th>ต่ำ</th><th>ปิด</th><th>แท่ง</th></tr></thead><tbody>${dailyRows}</tbody></table></div><p class="table-note">ช่วงที่แสดงขึ้นกับจำนวนแท่งที่ API ส่งมา ไม่ใช่ EOD ปรับสิทธิ์</p></section>` : ''}
    <section class="analysis-section"><h3>ข่าวที่พบชื่อหุ้น</h3><div class="news-list">${analysis.news.length ? analysis.news.map(newsCard).join('') : '<p>ยังไม่พบใน RSS ที่เก็บไว้</p>'}</div></section>
    <section class="analysis-section gaps"><h3>ข้อมูลที่ยังขาด</h3><ul>${analysis.dataGaps.map(item => `<li>${esc(item)}</li>`).join('')}</ul><p><a href="${esc(analysis.sourceLinks.set)}" target="_blank" rel="noopener noreferrer">เทียบหน้า SET ↗</a> · <a href="${esc(analysis.sourceLinks.sec)}" target="_blank" rel="noopener noreferrer">ค้น SEC Open Data ↗</a></p></section>
    <div class="actions sticky-actions"><button data-analyze="${esc(analysis.symbol)}">อัปเดตผล</button>${compareButton(analysis.symbol)}${watchButton(analysis.symbol)}</div>`;
  setBusy(busy);
  if (!$('#analysis-dialog').open) $('#analysis-dialog').showModal();
}

async function searchSymbols(query) {
  if (busy || !state) return;
  setBusy(true); notice('กำลังโหลดรายชื่อหุ้นและค้นหา…');
  try {
    const result = await api('/api/search', {query});
    state = result; searchResults = result.searchResults || []; render();
    notice(searchResults.length ? `พบ ${searchResults.length} รายการ เลือกหุ้นเพื่อวิเคราะห์ได้เลย` : 'ไม่พบหุ้นสามัญที่ตรงกับคำค้น ลองใช้ชื่อย่อหรือชื่อบริษัทภาษาอังกฤษ', !searchResults.length);
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}

async function analyzeSymbol(symbol) {
  if (busy || !state) return;
  setBusy(true); notice(`กำลังดึงราคา กราฟระยะสั้น และสรุปข่าวของ ${symbol}…`);
  try {
    const result = await api('/api/analyze', {symbol});
    state = result; fillThemes(); render(); analysisDialog(result.analysis);
    notice(`วิเคราะห์ ${symbol} แล้ว · ${result.analysis.stanceLabel} · ตรวจข้อมูลที่ยังขาดก่อนตัดสินใจ`);
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}

async function refreshNews() {
  if (busy || !state) return;
  setBusy(true); notice('กำลังดึงข่าวจาก InfoQuest และ ThaiPR…');
  try {
    state = await api('/api/refresh-news', {}); fillThemes(); render();
    const ok = Object.values(state.sources).filter(source => source.status === 'ok').length;
    notice(`อัปเดตข่าวสำเร็จ ${ok}/2 แหล่ง · บันทึก ${state.news.length} รายการ${ok < 2 ? ' · บางแหล่งไม่สำเร็จ ชุดเดิมยังอยู่' : ''}`, ok < 2);
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}

function selectedSymbols(limit = 20) {
  const watched = Object.entries(state.decisions).filter(([, decision]) => decision.choice === 'watch').map(([symbol]) => symbol);
  return [...new Set([...watched, ...Object.keys(state.analyses || {}), ...state.candidates.map(row => row.symbol), 'PTT', 'AOT', 'KBANK', 'ADVANC', 'CPALL'])].slice(0, limit);
}

async function refreshMarket() {
  if (busy || !state) return;
  const symbols = selectedSymbols();
  setBusy(true); notice(`กำลังอัปเดตราคา ${symbols.length} หุ้น…`);
  try {
    state = await api('/api/refresh-market', {symbols}); render();
    notice(`รับราคา ${state.marketSource.received}/${state.marketSource.requested} หุ้น${state.marketSource.status !== 'ok' ? ' · บางรายการไม่สำเร็จ ชุดเดิมยังอยู่' : ''}`, state.marketSource.status !== 'ok');
  } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}

async function refreshEod() {
  if (busy || !state) return;
  const symbols = selectedSymbols(10);
  setBusy(true); notice(`กำลังตรวจสิทธิ์ EODHD Free และดึง ${symbols.length} หุ้น…`);
  try { state = await api('/api/refresh-prices', {symbols}); render(); notice('อัปเดตข้อมูล EODHD แล้ว ตรวจสถานะรายตัวก่อนใช้'); }
  catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}

function toggleCompare(symbol) {
  if (compareSet.has(symbol)) compareSet.delete(symbol);
  else if (compareSet.size >= 3) return notice('เปรียบเทียบได้สูงสุด 3 หุ้น นำหุ้นหนึ่งตัวออกก่อนครับ', true);
  else if (!currentAnalysis(symbol)) return notice('ต้องวิเคราะห์หุ้นนี้ก่อนเพิ่มเข้าตารางเปรียบเทียบ', true);
  else compareSet.add(symbol);
  render();
  if ($('#analysis-dialog').open && currentAnalysis(symbol)) analysisDialog(currentAnalysis(symbol));
}

document.addEventListener('submit', event => {
  if (event.target.id !== 'symbol-search-form') return;
  event.preventDefault();
  searchSymbols(new FormData(event.target).get('query').trim());
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) { view = button.dataset.view; render(); }
  if (button.dataset.go) { view = button.dataset.go; render(); }
  if (button.dataset.analyze) await analyzeSymbol(button.dataset.analyze);
  if (button.dataset.analysis) { const analysis = currentAnalysis(button.dataset.analysis); if (analysis) analysisDialog(analysis); }
  if (button.dataset.compare) toggleCompare(button.dataset.compare);
  if ((button.id === 'price-refresh' || button.id === 'market-refresh') && !busy) await refreshMarket();
  if (button.id === 'eod-refresh' && !busy) await refreshEod();
  if (button.dataset.choice && !busy) {
    setBusy(true);
    try {
      state = await api('/api/decision', {symbol:button.dataset.symbol, choice:button.dataset.choice});
      render();
      if ($('#analysis-dialog').open && currentAnalysis(button.dataset.symbol)) analysisDialog(currentAnalysis(button.dataset.symbol));
      notice(`บันทึก ${button.dataset.symbol} แล้ว`);
    } catch (error) { notice(error.message, true); }
    finally { setBusy(false); }
  }
});

$('#refresh').addEventListener('click', refreshNews);
$('#close-analysis').addEventListener('click', () => $('#analysis-dialog').close());
['#news-search', '#theme', '#source'].forEach(selector => $(selector).addEventListener(selector === '#news-search' ? 'input' : 'change', render));

$('#export').addEventListener('click', async () => {
  try {
    const data = await api('/api/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'alphaweek-research-feedback.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice('ดาวน์โหลดผลทดลองแล้ว โปรดตรวจไฟล์ก่อนส่งต่อ');
  } catch (error) { notice(error.message, true); }
});

$('#stop').addEventListener('click', async () => {
  if (busy || !state) return;
  try {
    await api('/api/stop', {}); clearInterval(stateTimer); setBusy(true); $('#stop').disabled = true;
    notice('ปิดโปรแกรมแล้ว เปิด Start-Radar.cmd เพื่อใช้งานอีกครั้ง');
  } catch (error) { notice(error.message, true); }
});

async function load() {
  try {
    state = await api('/api/state'); fillThemes(); render();
    $('#today').textContent = `THAI MARKET / ${date(state.serverTime)} น.`;
    notice(`ข้อมูลบนเครื่อง · ${Object.keys(state.analyses || {}).length} แฟ้มวิเคราะห์ · ข่าวล่าสุด ${date(state.lastAttempt)}`);
  } catch (error) {
    notice('เชื่อมต่อโปรแกรมบนเครื่องไม่ได้ เปิด Start-Radar.cmd แล้วโหลดหน้านี้ใหม่', true);
  }
}

load();
const stateTimer = setInterval(async () => {
  if (!busy && !$('#analysis-dialog').open) {
    try { state = await api('/api/state'); fillThemes(); render(); }
    catch (error) { notice('โปรแกรมบนเครื่องอาจปิดแล้ว ข้อมูลบนหน้าจอยังไม่ได้อัปเดต', true); }
  }
}, 60000);
