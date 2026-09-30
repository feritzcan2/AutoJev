import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../app/store.mjs';
import {addRankedJob} from '../tests/rank-fixture.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-worker-splits-')),store=new Store(path.join(data,'jobloop.sqlite'));
const cv=path.join(data,'cv.txt');await writeFile(cv,'Synthetic candidate for local UI validation.');
const a=store.saveProfile({name:'Demo Candidate',preferences:'Remote backend',authorization:'submit'}),b=store.saveProfile({name:'Other Candidate',preferences:'Remote',authorization:'research'});
for(const p of [a,b])store.setCv(p.id,cv);
for(const s of store.sources(a.id))store.saveSource(a.id,{...s,enabled:false});
for(const [i,company] of ['Atlas Labs','Northstar','Orbit',...Array.from({length:12},(_,i)=>'Employer '+i)].entries())addRankedJob(store,a.id,{url:`https://example.test/jobs/${i}`,company,role:'Senior Backend Engineer',location:'Remote',fit:'Synthetic test listing'});
store.close();
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
  console.log('TEST_DATA',data);const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#candidates').waitFor();
  // Use real IPC, Store, MCP, scheduler and terminal rendering. No provider or
  // external website is launched; synthetic PTY output exercises event routing.
  await app.evaluate(async(_,url)=>{
    const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
    const {Engine}=await load(url),original=Engine.prototype.request;globalThis.workerCalls=[];globalThis.workerEngines=new Map();
    Engine.prototype.request=function(op,args={}){
      const owner=this.child.spawnargs[1];globalThis.workerCalls.push({op,owner,args});
      if(op==='start'){
        this.testSession=args.sessionId;globalThis.workerEngines.set(owner,this);
        setImmediate(()=>{for(const event of [{event:'output',bytes:[...Buffer.from('\x1b[32mWorker bağlı\x1b[0m\r\nAtanan başvuru inceleniyor…\r\n')]},{event:'state',state:'Working'}])this.child.stdout.emit('data',Buffer.from(JSON.stringify({...event,sessionId:this.testSession})+'\n'));});
      }
      if(op==='message')setImmediate(()=>this.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'state',state:'Working',sessionId:this.testSession})+'\n')));
      if(op==='input')this.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'output',sessionId:this.testSession,bytes:[...Buffer.from('INPUT: '+args.text+'\r\n')]})+'\n'));
      if(['start','message','resize','input'].includes(op))return Promise.resolve({});
      return original.call(this,op,args);
    };
  },pathToFileURL(path.join(process.cwd(),'app/engine.mjs')).href);
  await page.locator('#candidates').selectOption(a.id);
  await page.locator('#start').click();
  await page.locator('#worker-add').waitFor({state:'visible'});
  assert.equal(await page.locator('#worker-role').count(),0);
  await page.locator('#worker-add').click();
  await page.waitForFunction(()=>document.querySelectorAll('.worker-pane').length===2);
  await page.waitForFunction(()=>[...document.querySelectorAll('.worker-status')].every(el=>el.textContent==='Çalışıyor'));
  const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id),extra=snapshot.workers.find(w=>w.id!=='main');
  assert.equal(new Set(snapshot.workers.map(w=>w.campaign.task.jobId)).size,2);
  await page.locator('.worker-activity > .now-panel').nth(1).waitFor({state:'visible'});
  assert.equal(await page.locator('#now-panel').isVisible(),false);
  const mainActivity=page.locator('[data-activity-worker-id="main"]'),extraActivity=page.locator(`[data-activity-worker-id="${extra.id}"]`);
  for(const worker of snapshot.workers){
    const job=snapshot.jobs.find(j=>j.id===worker.campaign.task.jobId),card=page.locator(`[data-activity-worker-id="${worker.id}"]`);
    assert.equal(await card.locator('[data-activity-part=title]').textContent(),`${job.company} · ${job.role}`);
    assert.equal(await card.locator('.now-worker').textContent(),worker.name);
  }
  // Each worker's current row stays above the paginated backlog. The row's
  // status must come from that worker, including mixed rank/application work.
  await app.evaluate(async(_,args)=>{
    const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}),{Store}=await load(args.url),db=new Store(args.file);
    const scoped=db.forWorker(args.worker),c=scoped.campaign(args.id);c.task.kind='rank';scoped.saveCampaign(args.id,c);db.close();
    const engine=[...globalThis.workerEngines.entries()].find(([key])=>key.endsWith(args.worker))[1];engine.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'state',state:'Working',sessionId:engine.testSession})+'\n'));
  },{url:pathToFileURL(path.join(process.cwd(),'app/store.mjs')).href,file:path.join(data,'jobloop.sqlite'),id:a.id,worker:extra.id});
  await page.getByRole('button',{name:'Başvurular',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.jobs-table tbody tr.agent-current-row').length===2);
  const activeRows=page.locator('.jobs-table tbody tr.agent-current-row');
  assert.match(await activeRows.nth(0).locator('.application-agent-badge').textContent(),/Worker 1/);
  assert.match(await activeRows.nth(1).locator('.application-agent-badge').textContent(),/Worker 2/);
  assert.equal(await activeRows.nth(0).locator('.badge').textContent(),'İşleniyor');
  assert.equal(await activeRows.nth(1).locator('.badge').textContent(),'Puanlanıyor');
  const checkPinned=async()=>assert.deepEqual(await page.locator('.jobs-table tbody tr').evaluateAll(rows=>rows.slice(0,2).map(row=>row.classList.contains('agent-current-row')&&!row.hidden)),[true,true]);
  await checkPinned();await page.getByRole('button',{name:'2. sayfa',exact:true}).click();await checkPinned();
  await page.getByRole('button',{name:'Şirket',exact:true}).click();await checkPinned();
  await page.getByText('2 aktif iş üstte sabit',{exact:false}).waitFor();
  await page.screenshot({path:path.join(data,'active-worker-rows.png'),fullPage:true});
  await page.locator('button[data-view="agent"]').click();
  const activityLayout=await page.locator('.worker-activity > .now-panel').evaluateAll(cards=>cards.map(card=>card.getBoundingClientRect().toJSON()));
  assert.equal(activityLayout[0].y,activityLayout[1].y);assert.ok(activityLayout[1].x>=activityLayout[0].right);
  await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('open-link');ipcMain.handle('open-link',(_,url)=>{globalThis.lastOpenedWorkerUrl=url;});});
  await extraActivity.locator('[data-activity-part=link]').click();
  assert.equal(await app.evaluate(()=>globalThis.lastOpenedWorkerUrl),snapshot.jobs.find(j=>j.id===extra.campaign.task.jobId).url);
  const layout=await page.locator('.worker-splits').evaluate(el=>[...el.querySelectorAll('.worker-pane')].map(p=>p.getBoundingClientRect().toJSON()));
  assert.equal(layout[0].y,layout[1].y);assert.ok(layout[1].x>layout[0].x+layout[0].width);
  const primary=page.locator('[data-worker-id="main"]'),secondary=page.locator(`[data-worker-id="${extra.id}"]`);
  await primary.locator('.xterm-helper-textarea').focus();await page.keyboard.type('PRIMARY_ONLY');
  await secondary.locator('.xterm-helper-textarea').focus();await page.keyboard.type('SECOND_ONLY');
  const calls=await app.evaluate(()=>globalThis.workerCalls.filter(c=>c.op==='input'));
  assert.equal(calls.filter(c=>c.owner.endsWith(a.id)).map(c=>c.args.text).join(''),'PRIMARY_ONLY');
  assert.equal(calls.filter(c=>c.owner.endsWith(extra.id)).map(c=>c.args.text).join(''),'SECOND_ONLY');
  const output=await page.evaluate(async({id,worker})=>[await window.jobloop.terminalOutput(id,'main'),await window.jobloop.terminalOutput(id,worker)],{id:a.id,worker:extra.id});
  assert.ok(!Buffer.from(output[0].bytes).toString().includes('SECOND'));assert.ok(!Buffer.from(output[1].bytes).toString().includes('PRIMARY'));
  // A provider can still report Working while its terminal waits for a folder
  // trust decision. The prompt must stand out and focus the correct terminal.
  await app.evaluate((_,id)=>{
    const engine=[...globalThis.workerEngines.entries()].find(([key])=>key.endsWith(id))[1];
    const prompt='\x1b[2J\x1b[HAccessing workspace:\r\n/Users/example/workspace\r\nQuick safety check: Is this a project you trust?\r\nClaude Code can read, edit, and execute files here.\r\nNo, exit\r\nYes, I trust this folder\r\nEnter to confirm · Esc to cancel';
    engine.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'output',sessionId:engine.testSession,bytes:[...Buffer.from(prompt)]})+'\n'));
  },a.id);
  await primary.locator('.worker-attention').waitFor({state:'visible'});
  assert.match(await primary.locator('.worker-attention-title').textContent(),/güven onayı/);
  assert.equal(await primary.locator('.worker-status').textContent(),'Yanıt bekliyor');
  assert.equal(await secondary.locator('.worker-attention').isVisible(),false);
  await primary.screenshot({path:path.join(data,'worker-attention.png')});
  await primary.locator('[data-view="chat"]').click();
  await primary.locator('.worker-attention-button').click();
  assert.equal(await primary.getAttribute('data-view'),'terminal');
  assert.equal(await primary.locator('.xterm-helper-textarea').evaluate(el=>document.activeElement===el),true);
  await page.keyboard.press('ArrowDown');assert.equal(await primary.locator('.worker-attention').isVisible(),true);
  await page.keyboard.press('Enter');await primary.locator('.worker-attention').waitFor({state:'hidden'});
  assert.equal(await primary.locator('.worker-status').textContent(),'Çalışıyor');
  const divider=page.getByRole('separator',{name:'Terminal genişliğini ayarla'});await divider.focus();await page.keyboard.press('ArrowRight');
  const resized=await primary.boundingBox();assert.ok(resized.width>layout[0].width);
  await page.locator('.worker-activity').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(data,'worker-splits.png')});
  // Native Compacting -> Idle must settle the saved result and free only its
  // own worker. Inject provider events, with no external provider or browser work.
  await app.evaluate(async(_,args)=>{
    const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
    const {Store}=await load(args.storeUrl),{ContextCompaction}=await load(args.compactUrl),db=new Store(args.file),c=db.campaign(args.id);
    db.updateJob(args.id,c.task.jobId,'skipped','Synthetic closed listing',null);c.task.report={outcome:'done',note:'Fixture complete'};db.saveCampaign(args.id,c);db.close();
    const original=ContextCompaction.prototype.signal;
    ContextCompaction.prototype.signal=function(session,state){if(state==='Compacting'&&session.workerId==='main')session.compaction={state:'submitted',latched:true};return original.call(this,session,state);};
    const engine=[...globalThis.workerEngines.entries()].find(([key])=>key.endsWith(args.id))[1];
    for(const state of ['Compacting','Idle'])engine.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'state',state,sessionId:engine.testSession})+'\n'));
  },{storeUrl:pathToFileURL(path.join(process.cwd(),'app/store.mjs')).href,compactUrl:pathToFileURL(path.join(process.cwd(),'app/context-compaction.mjs')).href,file:path.join(data,'jobloop.sqlite'),id:a.id});
  await page.waitForFunction(({id,previous})=>window.jobloop.workspaceSnapshot(id).then(s=>s.workers[0].campaign.task?.seenWorking&&s.workers[0].active?.state==='Working'&&s.workers[0].campaign.task.id!==previous),{id:a.id,previous:snapshot.workers[0].campaign.task.id});
  const compacted=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id);
  assert.equal(compacted.workers[1].campaign.task.id,extra.campaign.task.id);
  assert.equal(compacted.workers[0].active.sessionId,snapshot.workers[0].active.sessionId);
  await page.getByRole('button',{name:'Worker 2 durdur',exact:true}).click();
  await secondary.locator('.worker-status[data-active=false]').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('[data-activity-part=title]')[2]?.textContent==='Durduruldu');
  await mainActivity.locator('[data-activity-part=state]').getByText('Çalışıyor',{exact:true}).waitFor();
  let after=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id);assert.ok(after.workers[0].active);assert.equal(after.workers[0].active.sessionId,snapshot.workers[0].active.sessionId);
  await page.getByRole('button',{name:'Worker 2 başlat',exact:true}).click();
  await secondary.locator('.worker-status[data-active=true]').waitFor();
  after=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id);assert.notEqual(after.workers[1].active?.sessionId,extra.active.sessionId);
  assert.ok(after.workers[1].active,'Restarted worker stays alive');
  await page.locator('#candidates').selectOption(b.id);await page.waitForFunction(()=>document.querySelectorAll('.worker-pane').length===1);
  await page.locator('#candidates').selectOption(a.id);await page.waitForFunction(()=>document.querySelectorAll('.worker-pane').length===2);
  await page.reload();await page.locator('button[data-view="agent"]').click();await page.waitForFunction(()=>document.querySelectorAll('.worker-pane').length===2);
  await page.getByRole('button',{name:'Worker 2 kaldır',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.worker-pane').length===1);
  await page.locator('#now-panel').waitFor({state:'visible'});assert.equal(await page.locator('.worker-activity').isVisible(),false);
  after=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),a.id);assert.equal(after.workers.length,1);assert.ok(after.workers[0].active);
  assert.deepEqual(errors,[]);await page.evaluate(id=>window.jobloop.workspaceStop(id),a.id);
  console.log('WORKER_SPLITS_PASS',data);
}finally{await app.close();}
