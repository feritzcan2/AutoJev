import {createRequire} from 'node:module';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-multi-')),store=new Store(path.join(data,'jobloop.sqlite'));
const cv=path.join(data,'cv.txt');await writeFile(cv,'Synthetic test candidate');
const a=store.saveProfile({name:'Candidate A',preferences:'Berlin',authorization:'research'}),b=store.saveProfile({name:'Candidate B',preferences:'Remote',authorization:'research'});
for(const p of [a,b])store.setCv(p.id,cv);store.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow();await page.locator('#candidates').waitFor();
 // Exercise real main-process routing and separate engines without starting external job searches.
 await app.evaluate(async(_,url)=>{const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});const {Engine}=await load(url),original=Engine.prototype.request;globalThis.routedCalls=[];Engine.prototype.request=function(op,args={}){const owner=this.child.spawnargs[1];globalThis.routedCalls.push({op,owner,args});if(['start','input','resize','message'].includes(op))return Promise.resolve({});return original.call(this,op,args);};},pathToFileURL(path.join(process.cwd(),'app/engine.mjs')).href);
 await page.evaluate(async({a,b})=>{await window.jobloop.start(a,{});await window.jobloop.start(b,{});}, {a:a.id,b:b.id});
 const snapshots=await page.evaluate(async({a,b})=>[await window.jobloop.snapshot(a),await window.jobloop.snapshot(b)],{a:a.id,b:b.id});
 assert.equal(snapshots[0].active.candidateId,a.id);assert.equal(snapshots[1].active.candidateId,b.id);assert.notEqual(snapshots[0].active.sessionId,snapshots[1].active.sessionId);
 await page.locator('#candidates').selectOption(b.id);await page.locator('#candidates').selectOption(a.id);
 await page.evaluate(async({a,b})=>{await window.jobloop.input(a,'only A');await window.jobloop.input(b,'only B');await window.jobloop.pause(a);},{a:a.id,b:b.id});
 const after=await page.evaluate(async({a,b})=>[await window.jobloop.snapshot(a),await window.jobloop.snapshot(b)],{a:a.id,b:b.id});
 assert.equal(after[0].active,null);assert.equal(after[1].active.candidateId,b.id);assert.equal(after[1].campaign.status,'running');
 const calls=await app.evaluate(()=>globalThis.routedCalls);assert.equal(calls.filter(c=>c.op==='start').length,2);
 assert.ok(calls.find(c=>c.op==='input'&&c.args.text==='only A').owner.endsWith(a.id));assert.ok(calls.find(c=>c.op==='input'&&c.args.text==='only B').owner.endsWith(b.id));
 console.log('MULTI_AGENT_ROUTING_PASS',data);
}finally{await app.close();}
