'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const fixture = {
  version:'radar-web-0.3', serverTime:new Date().toISOString(), lastAttempt:new Date().toISOString(),
  news:[], candidates:[], universeCount:927, analyses:{}, decisions:{}, marketQuotes:{}, quotes:{},
  sources:{infoquest:{status:'ok',received:10,lastSuccessAt:new Date().toISOString()},thaipr:{status:'ok',received:20,lastSuccessAt:new Date().toISOString()}},
  universeSource:{status:'ok',received:927,checkedAt:new Date().toISOString()},
  marketSource:{status:'idle',received:0,requested:0}, priceConfiguration:{enabled:false,publicEnabled:true},
  limitations:['ยังไม่มีงบการเงินอัตโนมัติ']
};

const nodes = new Map();
const node = selector => {
  if (!nodes.has(selector)) nodes.set(selector, {value:['#source','#theme'].includes(selector)?'all':'',textContent:'',innerHTML:'',dataset:{},open:false,disabled:false,hidden:false,classList:{toggle(){}},addEventListener(){},setAttribute(){},removeAttribute(){},showModal(){this.open=true;},close(){this.open=false;},click(){}});
  return nodes.get(selector);
};
const document = {querySelector:node,querySelectorAll:()=>[],addEventListener(){},createElement:()=>node('#created')};
const memory = new Map();
const localStorage = {getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,String(value))};
const fetch = async url => ({ok:true,status:200,json:async()=>{
  assert.match(url,/^\/api\/radar\?action=state$/);
  return structuredClone(fixture);
}});
const context = vm.createContext({document,localStorage,fetch,setInterval:()=>1,clearInterval(){},setTimeout,URL,Blob,FormData,console,structuredClone});
vm.runInContext(fs.readFileSync(path.join(__dirname,'app.js'),'utf8'),context);

(async()=>{
  for(let index=0;index<100&&!vm.runInContext('Boolean(state)',context);index++)await new Promise(resolve=>setTimeout(resolve,10));
  assert(vm.runInContext('Boolean(state)',context),'state loaded through hosted API');
  for(const view of ['desk','discover','compare','watch','news','sources']){
    vm.runInContext(`view=${JSON.stringify(view)};render();`,context);
    assert(node('#content').innerHTML.length>80,`${view} generated content`);
  }
  assert(!fs.readFileSync(path.join(__dirname,'index.html'),'utf8').includes('id="stop"'));
  assert.equal(vm.runInContext(`esc('<img src=x onerror="alert(1)">')`,context),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  vm.runInContext(`state.decisions.AOT={choice:'watch',at:new Date().toISOString()};persist();`,context);
  assert(memory.get('alphaweek-research-web-v0.3').includes('AOT'));
  console.log('radar-web client VM: PASS');
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
