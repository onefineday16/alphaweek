'use strict';

const crypto = require('node:crypto');

const VERSION = 'radar-web-0.3';
const TOPTRADER = 'https://api.toptrader.co.th';
const TOPTRADER_DOCS = 'https://developers.toptrader.co.th/docs/';
const FEEDS = [
  {id:'infoquest', name:'InfoQuest', url:'https://www.infoquest.co.th/stock/feed', host:'www.infoquest.co.th', kind:'news'},
  {id:'thaipr', name:'ThaiPR.NET', url:'https://www.thaipr.net/finance/feed', host:'www.thaipr.net', kind:'press_release'}
];
const SYMBOLS = 'ADVANC AOT AP BBL BCH BDMS BEM BGRIM BH BJC BTS CBG CCET CENTEL CHG CK CKP COM7 CPALL CPAXT CPF CPN CRC DELTA DOHOME EA EGCO GPSC GULF HANA HMPRO IRPC IVL JAS JMART JMT KBANK KCE KKP KLINIQ KTB KTC LH MINT MTC OSP PLANB PR9 PTT PTTEP PTTGC QH RATCH SAWAD SCB SCC SCGP SISB SPALI SPRC STA STECON STGT TASCO TCAP TIDLOR TISCO TLI TOP TRUE TTB TU VGI WHA WHAUP'.split(' ');
const ALIASES = {'แอดวานซ์':'ADVANC','ปตท.':'PTT','ปตท.สผ.':'PTTEP','กสิกรไทย':'KBANK','บางกอกดุสิต':'BDMS','ซีพี ออลล์':'CPALL','เดลต้า':'DELTA','ศรีตรังโกลฟส์':'STGT','ธนาคารกรุงไทย':'KTB','ทีทีบี':'TTB'};
const THEMES = [
  ['digital','ดิจิทัลและเทคโนโลยี',['ดาต้าเซ็นเตอร์','ดาต้า เซ็นเตอร์','data center','เซมิคอนดักเตอร์','อิเล็กทรอนิกส์','ปัญญาประดิษฐ์']],
  ['energy','พลังงาน',['น้ำมัน','พลังงาน','ไฟฟ้า','ก๊าซ','โซลาร์']],
  ['consumer','บริโภคและท่องเที่ยว',['ค้าปลีก','ท่องเที่ยว','โรงแรม','นักท่องเที่ยว','กำลังซื้อ']],
  ['finance','การเงิน',['ดอกเบี้ย','ธนาคาร','สินเชื่อ','หนี้เสีย','เงินเฟ้อ']],
  ['health','สุขภาพ',['โรงพยาบาล','การแพทย์','สุขภาพ']],
  ['industry','อุตสาหกรรมและโครงสร้างพื้นฐาน',['นิคม','โรงงาน','ก่อสร้าง','รถไฟ','ส่งออก','โครงสร้างพื้นฐาน']]
];
const QUESTIONS = {
  digital:'ตรวจว่ารายได้จากธีมนี้มีสัดส่วนเท่าใด และมีสัญญาหรือรายได้จริงแล้วหรือยัง',
  energy:'ตรวจผลต่อรายได้ ต้นทุน และหนี้ แยกการเคลื่อนไหวของราคาสินค้าออกจากกำไรบริษัท',
  consumer:'ตรวจยอดขายและอัตรากำไร ว่าการฟื้นตัวเกิดขึ้นต่อเนื่องหรือเป็นช่วงสั้น',
  finance:'ตรวจคุณภาพสินทรัพย์ ต้นทุนเงินทุน และความเสี่ยงการตั้งสำรอง',
  health:'ตรวจรายได้ต่อผู้รับบริการ ต้นทุนบุคลากร และเงินลงทุนใหม่',
  industry:'ตรวจมูลค่างานที่ยืนยันแล้ว ระยะรับรู้รายได้ และกระแสเงินสด',
  general:'ตรวจประกาศบริษัท งบล่าสุด มูลค่าหุ้น และสิ่งที่ราคาสะท้อนไปแล้ว'
};
const LIMITATIONS = [
  'บทวิเคราะห์เป็นกฎอัตโนมัติจากราคาและ RSS ไม่ใช่ AI ที่เข้าใจงบหรือคำแนะนำเฉพาะบุคคล',
  'กราฟรายนาทีครอบคลุมเท่าที่ API ส่งมา ไม่ใช่ประวัติปรับสิทธิ์ครบชุด',
  'ข่าว RSS ไม่รับรองความครบถ้วนและข่าวประชาสัมพันธ์ไม่ใช่หลักฐานอิสระ',
  'ไม่มีการส่งคำสั่งซื้อขาย คุณต้องตรวจงบ มูลค่า ประกาศบริษัท และกดยืนยันกับโบรกเกอร์เอง'
];

class SafeError extends Error {}
const nowIso = () => new Date().toISOString();
const validSymbol = value => typeof value === 'string' && /^[A-Z0-9-]{1,16}$/.test(value);
const finite = value => { const number = Number(value); if (!Number.isFinite(number)) throw new SafeError('INVALID_PRICE_DATA'); return number; };
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);

function clean(value) {
  return decodeEntities(String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeEntities(value) {
  const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    if (entity[0] === '#') return String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10));
    return named[entity.toLowerCase()] || '';
  });
}

function tag(xml, name) {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? match[1].trim() : '';
}

function safeNewsUrl(value, host) {
  try { const url = new URL(clean(value)); return url.protocol === 'https:' && url.hostname === host && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function matchSymbols(text) {
  const found = new Set(SYMBOLS.filter(symbol => new RegExp(`(^|[^A-Za-z0-9])${symbol}([^A-Za-z0-9]|$)`, 'i').test(text)));
  for (const [alias, symbol] of Object.entries(ALIASES)) if (text.includes(alias)) found.add(symbol);
  return [...found].sort();
}

function classify(text) {
  const lowered = text.toLowerCase();
  const themes = THEMES.filter(([, , words]) => words.some(word => lowered.includes(word))).map(([id, label]) => ({id, label}));
  const risk = ['ขาดทุน','ผิดนัด','ลดลง','หนี้เสีย','ฟ้อง','เตือน','ยกเลิก','ระงับ'].some(word => lowered.includes(word));
  const positive = ['เติบโต','กำไรเพิ่ม','งานใหม่','ลงทุน','ขยาย','ฟื้น','รายได้เพิ่ม','ปันผล'].some(word => lowered.includes(word));
  return {themes:themes.length ? themes : [{id:'general',label:'ข่าวบริษัทและตลาด'}], signal:risk && positive ? 'mixed' : risk ? 'risk' : positive ? 'catalyst' : 'research'};
}

async function fetchText(url, accept, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {headers:{Accept:accept,'User-Agent':'AlphaWeek-Research-Web/0.3'}, redirect:'follow', signal:controller.signal});
    if (!response.ok) throw new SafeError(`UPSTREAM_HTTP_${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new SafeError('RESPONSE_TOO_LARGE');
    return text;
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('NETWORK_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}

async function fetchJson(path, query) {
  const allowed = new Set(['/v1/market/symbols','/v1/market/tick','/v1/market/chart']);
  if (!allowed.has(path)) throw new SafeError('INVALID_PROVIDER_PATH');
  const url = new URL(path, TOPTRADER);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
  const text = await fetchText(url.href, 'application/json', path === '/v1/market/symbols' ? 8000000 : 2000000);
  try { return JSON.parse(text); } catch { throw new SafeError('INVALID_PROVIDER_RESPONSE'); }
}

function parseFeed(xml, source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new SafeError('UNSAFE_XML');
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  const current = Date.now();
  const rows = [];
  for (const item of items.slice(0, 100)) {
    const url = safeNewsUrl(tag(item, 'link'), source.host);
    const title = clean(tag(item, 'title')).slice(0, 180);
    const publishedMs = Date.parse(clean(tag(item, 'pubDate')));
    if (!url || !title || !Number.isFinite(publishedMs) || publishedMs > current + 300000 || publishedMs < current - 7 * 86400000) continue;
    let excerpt = clean(tag(item, 'description'));
    excerpt = source.id === 'infoquest' ? excerpt.slice(0, Math.max(0, 200 - title.length)) : excerpt.slice(0, 1000);
    const classified = classify(`${title} ${excerpt}`);
    rows.push({id:hash(url),source:source.id,sourceName:source.name,kind:source.kind,url,title,excerpt,publishedAt:new Date(publishedMs).toISOString(),collectedAt:nowIso(),symbols:matchSymbols(`${title} ${excerpt}`),themes:classified.themes,signal:classified.signal,eventKey:hash(title.replace(/\W+/g,'')),stale:current-publishedMs>72*3600000});
  }
  if (!rows.length) throw new SafeError('NO_RECENT_ITEMS');
  return rows;
}

async function loadNews() {
  const outcomes = await Promise.all(FEEDS.map(async source => {
    try { const rows = parseFeed(await fetchText(source.url, 'application/rss+xml, text/xml', 2000000), source); return {source,rows}; }
    catch (error) { return {source,rows:[],error:error instanceof SafeError ? error.message : 'SOURCE_FAILED'}; }
  }));
  const sources = {}, unique = new Map();
  for (const outcome of outcomes) {
    const checkedAt = nowIso();
    sources[outcome.source.id] = {name:outcome.source.name,url:outcome.source.url,status:outcome.error?'error':'ok',error:outcome.error||null,checkedAt,lastSuccessAt:outcome.error?null:checkedAt,received:outcome.rows.length};
    for (const story of outcome.rows) unique.set(story.id, story);
  }
  return {news:[...unique.values()].sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)).slice(0,400),sources,lastAttempt:nowIso()};
}

function validateUniverse(payload) {
  if (!payload || payload.status !== 'ok' || !Array.isArray(payload.answer)) throw new SafeError('INVALID_UNIVERSE_RESPONSE');
  const result = {};
  for (const row of payload.answer) {
    if (!row || typeof row !== 'object') continue;
    const symbol = String(row.symbol || '').toUpperCase();
    const market = String(row.path || '').replace(/\//g,'\\').split('\\')[0].toUpperCase();
    const category = String(row.category || '').toUpperCase();
    const currency = String(row.currencyBase || row.currency || '').toUpperCase();
    if (!validSymbol(symbol) || category !== 'COMMON_STOCK' || currency !== 'THB' || !['SET','MAI'].includes(market)) continue;
    const description = clean(row.description).slice(0,160);
    const name = description.includes('_') ? description.split('_').slice(1).join(' ').trim() : description;
    const lot = row.volumeStep === null || row.volumeStep === '' ? null : Number.parseInt(row.volumeStep,10);
    result[symbol] = {symbol,name:name||symbol,market,category:'Common Stock',currency:'THB',lotSize:Number.isFinite(lot)?lot:null};
  }
  if (!Object.keys(result).length) throw new SafeError('NO_COMMON_STOCKS');
  return result;
}

async function loadUniverse() { return validateUniverse(await fetchJson('/v1/market/symbols')); }

function searchUniverse(universe, rawQuery) {
  const query = clean(rawQuery).toLowerCase();
  if (!query || query.length > 50) throw new SafeError('INVALID_SEARCH');
  return Object.values(universe).map(row => {
    const symbol = row.symbol.toLowerCase(), name = row.name.toLowerCase();
    const rank = symbol === query ? 0 : symbol.startsWith(query) ? 1 : name.startsWith(query) ? 2 : symbol.includes(query) ? 3 : name.includes(query) ? 4 : 99;
    return {row,rank};
  }).filter(item => item.rank < 99).sort((a,b)=>a.rank-b.rank||a.row.symbol.localeCompare(b.row.symbol)).slice(0,20).map(item=>item.row);
}

function validateQuotes(payload, requested) {
  if (!payload || payload.status !== 'ok' || !Array.isArray(payload.answer)) throw new SafeError('INVALID_MARKET_RESPONSE');
  const accepted = {}, errors = {};
  for (const row of payload.answer) {
    const symbol = row && row.symbol;
    if (!requested.includes(symbol) || accepted[symbol]) continue;
    try {
      const last = finite(row.last), timestamp = finite(row.datetime);
      if (last <= 0 || timestamp <= 0 || timestamp * 1000 > Date.now() + 300000) throw new SafeError('INVALID_MARKET_QUOTE');
      const side = field => row[field] === null || row[field] === '' || row[field] === undefined ? null : finite(row[field]) || null;
      const bid = side('bid'), ask = side('ask');
      if (bid !== null && ask !== null && bid > ask) throw new SafeError('CROSSED_MARKET_QUOTE');
      const observed = new Date(timestamp * 1000);
      accepted[symbol] = {kind:'snapshot',last,bid,ask,observedAt:observed.toISOString(),date:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(observed),collectedAt:nowIso(),provider:'TopTrader Public',providerSymbol:symbol,currency:'THB',identityVerified:false,referenceVerified:false,corporateActionsVerified:false};
    } catch (error) { errors[symbol] = error instanceof SafeError ? error.message : 'INVALID_MARKET_QUOTE'; }
  }
  for (const symbol of requested) if (!accepted[symbol] && !errors[symbol]) errors[symbol] = 'MARKET_QUOTE_MISSING';
  return {accepted,errors};
}

function validateChart(payload) {
  if (!payload || payload.status !== 'ok' || !Array.isArray(payload.answer)) throw new SafeError('INVALID_CHART_RESPONSE');
  const rows = [], seen = new Set();
  const field = (row,names) => { for (const name of names) if (Object.hasOwn(row,name)) return row[name]; throw new SafeError('INVALID_CHART_DATA'); };
  for (const raw of payload.answer) {
    try {
      const timestamp = finite(Array.isArray(raw)?raw[0]:field(raw,['datetime','timestamp','time','dt','d']));
      const values = Array.isArray(raw) ? raw.slice(1,5).map(finite) : [['open','o','do'],['high','h','dh'],['low','l','dl'],['close','c','dc']].map(names=>finite(field(raw,names)));
      const [open,high,low,close] = values;
      if (seen.has(timestamp) || timestamp*1000>Date.now()+300000 || timestamp*1000<Date.now()-10*86400000 || values.some(value=>value<=0) || !(low<=Math.min(open,close)&&Math.max(open,close)<=high)) continue;
      seen.add(timestamp); rows.push({at:new Date(timestamp*1000).toISOString(),timestamp,open,high,low,close});
    } catch {}
  }
  rows.sort((a,b)=>a.timestamp-b.timestamp);
  if (!rows.length) throw new SafeError('NO_CHART_DATA');
  return rows.slice(-1000);
}

function bangkokDay(value) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
}

function dailySummary(rows) {
  const grouped = new Map();
  for (const row of rows) { const day=bangkokDay(row.at); if(!grouped.has(day)) grouped.set(day,[]); grouped.get(day).push(row); }
  return [...grouped.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,bars])=>{bars.sort((a,b)=>a.timestamp-b.timestamp);return {date,open:bars[0].open,high:Math.max(...bars.map(x=>x.high)),low:Math.min(...bars.map(x=>x.low)),close:bars.at(-1).close,bars:bars.length};}).slice(-8);
}

function newsForSymbol(symbol, news) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9])${symbol}([^A-Za-z0-9]|$)`,'i');
  return news.filter(story=>story.symbols.includes(symbol)||pattern.test(`${story.title} ${story.excerpt}`)).sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)).slice(0,8);
}

function candidateRows(news) {
  const grouped = new Map();
  for (const story of news) if (!story.stale) for (const symbol of story.symbols) { if(!grouped.has(symbol)) grouped.set(symbol,[]); grouped.get(symbol).push(story); }
  return [...grouped].map(([symbol,stories])=>{
    const unique=[...new Map(stories.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)).map(story=>[story.eventKey,story])).values()];
    const risk=unique.some(story=>['risk','mixed'].includes(story.signal)), theme=unique[0].themes[0];
    return {symbol,news:unique.slice(0,5),eventCount:unique.length,sourceCount:new Set(unique.map(x=>x.source)).size,status:risk?'ทบทวนความเสี่ยง':'ศึกษาต่อ',priceStatus:'missing',quote:null,question:QUESTIONS[theme.id]||QUESTIONS.general,theme,latestAt:unique[0].publishedAt,actionable:false,reason:'พบชื่อหุ้นในข่าวที่ได้รับ ยังไม่ได้ยืนยันมูลค่าและความครบของข้อมูล',caution:'ข่าวซ้ำหรือข่าวประชาสัมพันธ์ไม่ใช่หลักฐานอิสระ รายการนี้ไม่ใช่อันดับหุ้นน่าซื้อ'};
  }).sort((a,b)=>b.latestAt.localeCompare(a.latestAt)||b.eventCount-a.eventCount);
}

function buildAnalysis(symbol, company, quote, bars, news, previous) {
  const daily = dailySummary(bars), change = daily.length>=2 ? (daily.at(-1).close/daily[0].close-1)*100 : null;
  const range = daily.length ? (Math.max(...daily.map(x=>x.high))/Math.min(...daily.map(x=>x.low))-1)*100 : null;
  const riskCount = news.filter(x=>['risk','mixed'].includes(x.signal)).length, catalystCount = news.filter(x=>['catalyst','mixed'].includes(x.signal)).length;
  let stance='wait', stanceLabel='รอข้อมูลยืนยัน', reason='ภาพราคาระยะสั้นยังไม่ชัดพอ และระบบยังไม่มีงบหรือมูลค่าหุ้นอัตโนมัติ';
  if (!quote || daily.length<2) {stance='insufficient';stanceLabel='ข้อมูลยังไม่พอ';reason='ยังไม่มีราคาและช่วงข้อมูลอย่างน้อย 2 วันสำหรับอ่านแนวโน้มสั้น';}
  else if (riskCount && change<=0) {stance='caution';stanceLabel='ระวังและตรวจความเสี่ยง';reason='มีคำเกี่ยวกับความเสี่ยงในข่าว พร้อมแนวโน้มราคาที่ยังไม่ยืนยันด้านบวก';}
  else if (change>=2 && catalystCount>riskCount) {stance='interesting';stanceLabel='น่าสนใจสำหรับศึกษาต่อ';reason='ราคาเคลื่อนไหวเชิงบวกในช่วงข้อมูลที่รับมา และข่าวมีเหตุการณ์ให้ตรวจสอบต่อ';}
  else if (change<=-3) {stance='wait';stanceLabel='รอให้แนวโน้มหยุดอ่อนตัว';reason='ราคาอ่อนตัวในช่วงข้อมูลที่รับมา จึงควรรอหลักฐานกลับทิศก่อน';}
  const changes=[];
  if (previous && previous.symbol===symbol) {
    if(previous.stance!==stance) changes.push(`มุมมองเปลี่ยนจาก ${previous.stanceLabel||'ผลก่อนหน้า'} เป็น ${stanceLabel}`);
    if(Number(previous.last)>0){const delta=(quote.last/Number(previous.last)-1)*100;if(Math.abs(delta)>=0.1)changes.push(`ราคาล่าสุดเปลี่ยน ${delta>=0?'+':''}${delta.toFixed(2)}% จากผลก่อนหน้า`);}
    if(previous.newsCount!==news.length)changes.push(`จำนวนข่าวที่เชื่อมโยงเปลี่ยนจาก ${previous.newsCount||0} เป็น ${news.length}`);
  } else changes.push('นี่คือผลวิเคราะห์ครั้งแรกของหุ้นนี้');
  if(!changes.length)changes.push('ยังไม่พบการเปลี่ยนแปลงสำคัญจากผลก่อนหน้า');
  const evidence=[{label:'ราคาล่าสุดที่ผู้ให้บริการส่งมา',value:`${quote.last.toFixed(2)} บาท`,source:'TopTrader Public',observedAt:quote.observedAt},{label:'ช่วงข้อมูลราคารายวันจากกราฟรายนาที',value:`${daily.length} วัน / ${daily.reduce((sum,x)=>sum+x.bars,0)} แท่ง`,source:'TopTrader Public',observedAt:daily.at(-1).date}];
  if(change!==null)evidence.push({label:'การเปลี่ยนแปลงจากราคาปิดวันแรกถึงวันล่าสุดในชุด',value:`${change>=0?'+':''}${change.toFixed(2)}%`,source:'คำนวณบน Vercel Function',observedAt:daily.at(-1).date});
  if(news.length)evidence.push({label:'ข่าวที่พบชื่อหุ้น',value:`${news.length} รายการ / ${new Set(news.map(x=>x.source)).size} แหล่ง`,source:'RSS ที่เชื่อมไว้',observedAt:news[0].publishedAt});
  const opposing=[];
  if(!news.length)opposing.push('ยังไม่พบข่าวที่เชื่อมชื่อหุ้นใน RSS ที่รับมา จึงอธิบายเหตุการณ์ล่าสุดไม่ได้');
  if(riskCount)opposing.push(`พบข่าว ${riskCount} รายการที่มีกลุ่มคำเกี่ยวกับความเสี่ยง ต้องอ่านต้นทางก่อนตัดสินใจ`);
  if(change<0)opposing.push(`ราคาปิดในชุดข้อมูลลดลง ${Math.abs(change).toFixed(2)}% จากวันแรก`);
  if(!opposing.length)opposing.push('ยังไม่มีหลักฐานด้านงบ มูลค่า และสถานะผู้ถือหุ้นมาหักล้างภาพระยะสั้น');
  return {symbol,company,createdAt:nowIso(),ruleVersion:'rules-web-0.3',actionable:false,stance,stanceLabel,reason,coverage:quote&&daily.length>=3?'medium':'low',horizon:'ติดตาม 1–2 สัปดาห์',last:quote.last,quote,daily,shortChangePercent:change,rangePercent:range,newsCount:news.length,riskNewsCount:riskCount,catalystNewsCount:catalystCount,news:news.slice(0,5),evidence,opposingEvidence:opposing,changes,beforeBuy:['อ่านข่าวต้นทางและประกาศบริษัทที่เกี่ยวข้อง','ตรวจงบล่าสุด กระแสเงินสด หนี้ และการเติบโตจริง','ประเมินมูลค่าและกำหนดราคาสูงสุดที่ยอมรับได้','กำหนดขนาดเงินและจุดยอมรับว่าคิดผิดก่อนส่งคำสั่งเอง'],holdingReview:['ทบทวนเมื่อมุมมองของระบบเปลี่ยนหรือมีข่าวความเสี่ยงใหม่','ทบทวนเมื่อราคาอ่อนตัวต่อโดยไม่มีข้อมูลพื้นฐานรองรับ','ขายหรือถือต่อจากแผนส่วนตัวหลังตรวจงบและประกาศบริษัท ไม่ใช้ผลนี้เป็นคำสั่ง'],dataGaps:['ยังไม่มีงบการเงิน อัตราส่วนมูลค่า และประมาณการกำไรอัตโนมัติ','กราฟรายนาทีครอบคลุมเท่าที่ API ส่งมาและยังไม่ปรับ corporate actions','ข่าวมาจาก RSS ปัจจุบันสองแหล่ง ไม่รับรองว่าครบทุกข่าว','ไม่ได้ยืนยันสถานะ real-time หรือเทียบราคาอิสระทุกครั้ง'],sourceLinks:{market:TOPTRADER_DOCS,set:`https://www.set.or.th/th/market/product/stock/quote/${encodeURIComponent(symbol)}/price`,sec:'https://secopendata.sec.or.th/datasets'}};
}

function baseState(newsData, universeCount) {
  return {version:VERSION,serverTime:nowIso(),lastAttempt:newsData.lastAttempt||null,news:newsData.news||[],sources:newsData.sources||{},candidates:candidateRows(newsData.news||[]),universeCount:universeCount||0,universeSource:{name:'TopTrader Public',url:TOPTRADER_DOCS,status:universeCount?'ok':'error',checkedAt:nowIso(),received:universeCount||0},marketQuotes:{},marketSource:{name:'TopTrader Public',url:TOPTRADER_DOCS,status:'idle',received:0,requested:0},analyses:{},decisions:{},quotes:{},priceConfiguration:{configured:false,enabled:false,publicProvider:'TopTrader',publicEnabled:true},limitations:LIMITATIONS,dictionarySize:SYMBOLS.length};
}

async function handle(action, body) {
  if (action === 'health') return {ok:true,version:VERSION,scope:'vercel-preview',assistant:'rule-based',sources:['TopTrader Public','InfoQuest RSS','ThaiPR RSS']};
  if (action === 'state') {
    const [newsData, universeResult] = await Promise.all([loadNews(), loadUniverse().catch(()=>({}))]);
    return baseState(newsData,Object.keys(universeResult).length);
  }
  if (action === 'refresh-news') {
    const newsData=await loadNews();
    return {...newsData,candidates:candidateRows(newsData.news),serverTime:nowIso()};
  }
  if (action === 'search') {
    const universe=await loadUniverse();
    return {serverTime:nowIso(),universeCount:Object.keys(universe).length,universeSource:{name:'TopTrader Public',url:TOPTRADER_DOCS,status:'ok',checkedAt:nowIso(),received:Object.keys(universe).length},searchResults:searchUniverse(universe,body.query)};
  }
  if (action === 'refresh-market') {
    if(!Array.isArray(body.symbols)||!body.symbols.length||body.symbols.length>20)throw new SafeError('INVALID_SYMBOLS');
    const symbols=[...new Set(body.symbols.map(value=>String(value).trim().toUpperCase()))];
    if(symbols.some(symbol=>!validSymbol(symbol)))throw new SafeError('INVALID_SYMBOLS');
    const {accepted,errors}=validateQuotes(await fetchJson('/v1/market/tick',{symbol:symbols.join(',')}),symbols);
    return {serverTime:nowIso(),marketQuotes:accepted,marketSource:{name:'TopTrader Public',url:TOPTRADER_DOCS,status:Object.keys(accepted).length&&Object.keys(errors).length?'partial':Object.keys(accepted).length?'ok':'error',checkedAt:nowIso(),lastSuccessAt:Object.keys(accepted).length?nowIso():null,received:Object.keys(accepted).length,requested:symbols.length,errors}};
  }
  if (action === 'analyze') {
    const symbol=String(body.symbol||'').trim().toUpperCase(); if(!validSymbol(symbol))throw new SafeError('INVALID_SYMBOL');
    const end=Math.floor(Date.now()/1000);
    const [universe,newsData,tickPayload,chartPayload]=await Promise.all([loadUniverse(),loadNews(),fetchJson('/v1/market/tick',{symbol}),fetchJson('/v1/market/chart',{symbol,from:end-7*86400+1,to:end,data:'dohlc'})]);
    const {accepted,errors}=validateQuotes(tickPayload,[symbol]); if(!accepted[symbol])throw new SafeError(errors[symbol]||'MARKET_QUOTE_MISSING');
    const analysis=buildAnalysis(symbol,universe[symbol]||{symbol,name:symbol,market:'SET/mai',category:'Common Stock',currency:'THB',lotSize:null},accepted[symbol],validateChart(chartPayload),newsForSymbol(symbol,newsData.news),body.previous);
    return {...baseState(newsData,Object.keys(universe).length),marketQuotes:{[symbol]:accepted[symbol]},marketSource:{name:'TopTrader Public',url:TOPTRADER_DOCS,status:'ok',checkedAt:nowIso(),lastSuccessAt:nowIso(),received:1,requested:1,errors:{}},analysis};
  }
  throw new SafeError('NOT_FOUND');
}

module.exports = async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  if(req.method==='OPTIONS')return res.status(204).end();
  const action=String(req.query.action||'state');
  const getActions=new Set(['state','health']);
  if((req.method==='GET'&&!getActions.has(action))||(req.method==='POST'&&getActions.has(action))||!['GET','POST'].includes(req.method))return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
  try { return res.status(200).json(await handle(action,req.body&&typeof req.body==='object'?req.body:{})); }
  catch(error){const code=error instanceof SafeError?error.message:'SERVICE_UNAVAILABLE';const status=code==='NOT_FOUND'?404:code.startsWith('INVALID_')?400:502;return res.status(status).json({error:code});}
};

module.exports._test = {clean,parseFeed,validateUniverse,searchUniverse,validateQuotes,validateChart,dailySummary,buildAnalysis,candidateRows};
