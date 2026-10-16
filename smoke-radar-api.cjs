'use strict';

const assert = require('node:assert/strict');
const handler = require('./api/radar');

function invoke(method, action, body) {
  return new Promise((resolve, reject) => {
    const response = {
      code:200,
      headers:{},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.code = code; return this; },
      json(payload) { resolve({status:this.code, payload, headers:this.headers}); return this; },
      end() { resolve({status:this.code, payload:null, headers:this.headers}); return this; }
    };
    Promise.resolve(handler({method,query:{action},body}, response)).catch(reject);
  });
}

(async () => {
  const health = await invoke('GET', 'health');
  assert.equal(health.status, 200);
  assert.equal(health.payload.version, 'radar-web-0.3');

  const state = await invoke('GET', 'state');
  assert.equal(state.status, 200);
  assert(state.payload.universeCount > 500, 'Thai common-stock universe loaded');
  assert(Array.isArray(state.payload.news), 'news array returned');

  const search = await invoke('POST', 'search', {query:'AOT'});
  assert.equal(search.status, 200);
  assert.equal(search.payload.searchResults[0].symbol, 'AOT');

  const analyzed = await invoke('POST', 'analyze', {symbol:'AOT'});
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.payload.analysis.symbol, 'AOT');
  assert.equal(analyzed.payload.analysis.actionable, false);
  assert(analyzed.payload.analysis.daily.length >= 2, 'chart covers at least two days');

  console.log(JSON.stringify({result:'PASS',version:health.payload.version,universeCount:state.payload.universeCount,newsCount:state.payload.news.length,symbol:analyzed.payload.analysis.symbol,last:analyzed.payload.analysis.last,days:analyzed.payload.analysis.daily.length,stance:analyzed.payload.analysis.stance,actionable:analyzed.payload.analysis.actionable}));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
