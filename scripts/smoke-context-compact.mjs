// Opt-in provider integration test: temporary workspace, no browser or jobs.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {appendFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ContextUsage} from '../app/context-usage.mjs';
import {Engine} from '../app/engine.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationTools} from '../app/automation-worker.mjs';
import {startToolServer} from '../app/tool-server.mjs';
const require=createRequire(import.meta.url),{chromium}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const xterm=createRequire(require.resolve('@termloop/terminal-surface/xterm')).resolve('@xterm/xterm');
const root=await mkdtemp(path.join(tmpdir(),'jobloop-compact-live-'));
console.log('TEST_DATA',root);
async function run(provider){
 const cwd=path.join(root,provider);await mkdir(path.join(cwd,'runtime'),{recursive:true});
 await writeFile(path.join(cwd,'AGENTS.md'),'This is a local transport integration test. Only execute the explicit synthetic test prompt. Do not browse, read personal files, or submit applications.');
 const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),p=db.create('custom',{title:'Synthetic test'}),sessionId=randomUUID();
 let engine,output='',nativeId,reader,writing=Promise.resolve();const events=[];
 const terminalBrowser=await chromium.launch({channel:'chrome',headless:true}),page=await terminalBrowser.newPage();
 await page.setContent('<div id=terminal></div>');await page.addScriptTag({path:xterm});
 await page.exposeFunction('terminalInput',text=>engine?.request('input',{text}).catch(()=>{}));
 await page.evaluate(()=>{window.term=new window.Terminal({cols:120,rows:32,allowProposedApi:true});term.open(document.querySelector('#terminal'));term.onData(text=>window.terminalInput(text));term.focus();});
 const screen=()=>page.evaluate(()=>Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString(true)??'').join('\n'));
 const mcp=await startToolServer({assertOwner:id=>store.workspaces.get(id),resolve:grant=>grant.workflow,defaultWorkflow:{tools:[automationTools.find(t=>t.name==='ask_workspace_question')],call:(id,session,name,args)=>db.askQuestion(id,args)},onHook:hook=>engine.request('hook',{token:hook.token,observation:hook.observation})});
 engine=new Engine(path.resolve('engine/target/debug/jobloop-engine'),path.join(cwd,'processes'),event=>{
  if(event.event==='output'){const chunk=Buffer.from(event.bytes).toString();output=(output+chunk).slice(-100000);appendFileSync(path.join(cwd,'terminal.txt'),chunk);writing=writing.then(()=>page.evaluate(bytes=>new Promise(resolve=>term.write(Uint8Array.from(bytes),resolve)),event.bytes));}
  else {events.push({...event,at:Date.now()});if(event.event==='identity'){nativeId=event.nativeId;reader=new ContextUsage({provider,nativeId,cwd,statusFile:path.join(cwd,'runtime',`context-${sessionId}.jsonl`)});}if(['state','compaction'].includes(event.event))console.log(provider,event.event,event.state,event.error??'');}
 });
 const wait=async(check,timeout=90000)=>{const end=Date.now()+timeout;while(!await check()){if(Date.now()>end)throw Error(provider+' timed out');await new Promise(r=>setTimeout(r,100));}};
 try{
  await engine.request('start',{...(provider==='codex'?{taskType:'automation'}:{}),sessionId,cwd,runtimeDirectory:path.join(cwd,'runtime'),endpoint:mcp.endpoint,token:mcp.grant(p.id,sessionId),provider,model:'default',permission:'bypassPermissions',reasoning:'default',network:null,rows:32,cols:120,prompt:'Local compaction integration test. Use your shell tool to run sleep 18, then reply exactly TEST_DONE. Do not read other files, browse, or call JobLoop tools. There are no candidate tasks.'});
  if(provider==='claude'){
   await wait(async()=>(await screen()).includes('Yes, I trust this folder'));
   // Approve only this test directory. Wait for the selected-row redraw so
   // Enter cannot race the provider's menu state update.
   for(let attempt=0;attempt<3&&!events.some(e=>e.state==='Some(Idle)'||e.state==='Some(Working)');attempt++){
    assert.match(await screen(),/❯\s+No, exit/);
    await page.keyboard.press('ArrowDown');
    await wait(async()=>/❯\s+Yes, I trust this folder/.test(await screen()),5000);
    await page.keyboard.press('Enter');
    await new Promise(r=>setTimeout(r,2000));
   }
  }
  await wait(()=>events.some(e=>e.event==='state'&&e.state==='Some(Working)'));
  // Delivery of the original prompt must settle before the independent command.
  let result;const deadline=Date.now()+30000;
  do{await new Promise(r=>setTimeout(r,500));result=await engine.request('compact',{sessionId});}while(result.deferred&&Date.now()<deadline);
  assert.equal(result.accepted,true);console.log(provider,'COMPACT_ACCEPTED');
  await wait(()=>events.some(e=>e.event==='compaction'));
  assert.equal(events.find(e=>e.event==='compaction').state,'submitted');
  await wait(async()=>provider==='codex'?(await reader?.read())?.compactionId:events.some(e=>e.event==='state'&&e.state==='Some(Compacting)'),120000);
  console.log(provider,'NATIVE_COMPACTION_OBSERVED',nativeId);
  await wait(()=>events.some((e,i)=>e.event==='state'&&e.state==='Some(Idle)'&&events.slice(0,i).some(p=>p.state===(provider==='codex'?'submitted':'Some(Compacting)'))),120000);
  await page.keyboard.type('LOCAL_DRAFT_KEEP');
  await wait(async()=>(await screen()).includes('LOCAL_DRAFT_KEEP'),5000);
  assert.equal((await engine.request('compact',{sessionId})).deferred,true);
  assert.ok((await screen()).includes('LOCAL_DRAFT_KEEP'),'automatic command must preserve the draft');
  await assert.rejects(engine.request('compact',{sessionId:'stale-session'}),/Wrong session/);
  console.log(provider,'COMPACT_LIVE_PASS');
 }finally{
  await writeFile(path.join(cwd,'terminal.txt'),output);
  await writeFile(path.join(cwd,'events.json'),JSON.stringify(events,null,2));
  await engine.close();await mcp.close();await writing;await terminalBrowser.close();store.close();
 }
}
for(const provider of process.argv.slice(2).length?process.argv.slice(2):['codex','claude'])await run(provider);
