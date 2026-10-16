'use strict';

const assert = require('node:assert/strict');
const radar = require('./api/radar')._test;

assert.equal(radar.clean('<b>AOT</b>&amp;PTT'), 'AOT &PTT');

const pubDate = new Date().toUTCString();
const feed = `<rss><channel><item><title>AOT ลงทุนเพิ่ม</title><link>https://www.infoquest.co.th/2026/100</link><pubDate>${pubDate}</pubDate><description><![CDATA[<p>รายได้เพิ่มและขยายโครงการ</p>]]></description></item></channel></rss>`;
const news = radar.parseFeed(feed, {id:'infoquest',name:'InfoQuest',host:'www.infoquest.co.th',kind:'news'});
assert.equal(news.length, 1);
assert.deepEqual(news[0].symbols, ['AOT']);
assert.equal(news[0].signal, 'catalyst');

const universe = radar.validateUniverse({status:'ok',answer:[
  {symbol:'AOT',path:'SET\\Transportation',category:'COMMON_STOCK',currencyBase:'THB',description:'AOT_Airports of Thailand',volumeStep:'100'},
  {symbol:'BAD',path:'SET\\ETF',category:'ETF',currencyBase:'THB',description:'BAD',volumeStep:'1'}
]});
assert.equal(Object.keys(universe).length, 1);
assert.equal(radar.searchUniverse(universe, 'aot')[0].symbol, 'AOT');

const now = Math.floor(Date.now() / 1000);
const quote = radar.validateQuotes({status:'ok',answer:[{symbol:'AOT',last:60,bid:59.75,ask:60.25,datetime:now}]}, ['AOT']).accepted.AOT;
assert.equal(quote.last, 60);

const chart = radar.validateChart({status:'ok',answer:[
  {datetime:now-86400,open:56,high:57,low:55,close:56},
  {datetime:now-120,open:59,high:61,low:58,close:60}
]});
const analysis = radar.buildAnalysis('AOT', universe.AOT, quote, chart, news, null);
assert.equal(analysis.actionable, false);
assert.equal(analysis.symbol, 'AOT');
assert.equal(analysis.daily.length, 2);
assert(analysis.evidence.length >= 3);
assert(analysis.dataGaps.length >= 3);

const candidates = radar.candidateRows(news);
assert.equal(candidates[0].symbol, 'AOT');
assert.equal(candidates[0].actionable, false);

console.log('radar-web tests: PASS');
