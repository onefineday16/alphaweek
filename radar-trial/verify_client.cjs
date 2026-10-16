// Exercises client code against the running local HTTP service in a minimal DOM stub.
// Does not render HTML or establish real browser/layout acceptance.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const http = require('node:http');

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {method:options.method || 'GET', headers:options.headers}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({status:response.statusCode, ok:response.statusCode >= 200 && response.statusCode < 300, json:async () => JSON.parse(body)});
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('HTTP_TIMEOUT')));
    request.end(options.body);
  });
}

const root = __dirname;

async function main() {
  const base = process.env.ALPHAWEEK_BASE || 'http://127.0.0.1:8787';
  const snapshot = await (await fetch(base + '/api/state')).json();
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value:selector === '#source' || selector === '#theme' ? 'all' : '', textContent:'', innerHTML:'', dataset:{}, open:false, disabled:false,
      classList:{toggle(){}}, addEventListener(){}, showModal(){this.open = true;}, close(){this.open = false;}
    });
    return nodes.get(selector);
  };
  const document = {querySelector:node, querySelectorAll:() => [], addEventListener(){}, createElement:() => node('#created')};
  const context = vm.createContext({document, fetch:(url, options) => fetch(base + url, options), setInterval:() => 1, clearInterval(){}, setTimeout, URL, Blob, FormData, console});
  vm.runInContext(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), context);
  for (let index = 0; index < 100 && !vm.runInContext('Boolean(state)', context); index++) await new Promise(resolve => setTimeout(resolve, 25));
  assert(vm.runInContext('Boolean(state)', context), 'state loaded through HTTP');

  const checks = [];
  for (const view of ['desk', 'discover', 'compare', 'watch', 'news', 'sources']) {
    vm.runInContext(`view=${JSON.stringify(view)};render();`, context);
    assert(node('#content').innerHTML.length > 100, view + ' generated content');
    checks.push(view + ' client content');
  }
  assert(node('#content').innerHTML.includes('id="eod-refresh" disabled'), 'no key disables optional EODHD');
  assert(node('#content').innerHTML.includes('id="price-refresh">'), 'public prices remain available without key');
  checks.push('no-account-price-enabled-and-optional-eod-disabled');
  assert.equal(vm.runInContext(`esc('<img src=x onerror="alert(1)">')`, context), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  checks.push('untrusted-text-escaped');

  const analyzed = Object.keys(snapshot.analyses || {});
  if (analyzed.length) {
    vm.runInContext(`analysisDialog(currentAnalysis(${JSON.stringify(analyzed[0])}));`, context);
    assert(node('#analysis-dialog').open, 'analysis dialog opened');
    assert(node('#analysis-body').innerHTML.includes(analyzed[0]), 'analysis content contains symbol');
    assert(node('#analysis-body').innerHTML.includes('ข้อมูลที่ยังขาด'), 'analysis exposes data gaps');
    checks.push('saved-analysis-detail');
  }

  const responses = {};
  for (const route of ['/', '/app.js', '/styles.css', '/api/health']) {
    const response = await fetch(base + route);
    responses[route] = response.status;
    assert.equal(response.status, 200);
  }
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.version, 'radar-trial-0.2');
  assert.equal(health.assistant, 'rule-based');
  const exported = await (await fetch(base + '/api/export')).json();
  assert(!('csrf' in exported) && !('news' in exported) && !('quotes' in exported) && !('candidates' in exported));
  checks.push('feedback-content-boundary');

  const report = {checkedAt:new Date().toISOString(), result:'PASS', kind:'HTTP and client VM; no rendered browser', checks, responses,
    version:snapshot.version, universeCount:snapshot.universeCount, newsCount:snapshot.news.length, analysisSymbols:analyzed,
    publicSnapshots:Object.keys(snapshot.marketQuotes || {}).length, marketSource:snapshot.marketSource, sources:snapshot.sources,
    eodhdEntitlement:'NOT_TESTED_NO_KEY', browserAcceptance:'NOT_TESTED_PROJECT_RULE'};
  const target = process.env.ALPHAWEEK_REPORT_PATH;
  if (target) fs.writeFileSync(path.resolve(root, target), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
