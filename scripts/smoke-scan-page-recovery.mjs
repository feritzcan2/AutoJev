import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'loop-render-recovery-')),core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);
let freshRequests=0,submits=0;
const server=createServer((req,res)=>{
 const route=new URL(req.url,'http://localhost').pathname;
 if(route==='/send')submits++;
 res.setHeader('Content-Type','text/html');
 const shell='<h1>Search results</h1><input name="draft" value="KEEP_MY_DRAFT"><div hidden>HIDDEN_MUST_NOT_LEAK</div>';
 if(route==='/delayed')return res.end(shell+'<div hidden id="S:1"><article><a href="/detail">DELAYED_LISTING</a></article></div><script>setTimeout(()=>document.getElementById("S:1").removeAttribute("hidden"),500)</script>');
 if(route==='/recover'){
  freshRequests++;
  return res.end(shell+`<div ${freshRequests===1?'hidden id="S:2"':''}><article><a href="/detail">RECOVERED_LISTING</a></article></div>`);
 }
 if(route==='/stuck')return res.end(shell+'<div hidden id="S:3"><article><a href="/detail">NOT_VISIBLE_LISTING</a></article></div>');
 res.end(shell+'<a href="/delayed">Delayed</a><a href="/recover">Recover</a><a href="/stuck">Stuck</a><article>ACTUAL_DETAIL</article>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const source=`http://127.0.0.1:${server.address().port}/`;
const a=db.create('custom',{goal:'Read listings',criteria:{outcome:'Listings',rules:'Read only',completion:'All'},sources:[source]});db.review(a.id);db.skipTrial(a.id);db.enable(a.id);
const task=core.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:source,sources:[source],lockKey:'source:'+source}),run=db.begin(a.id,{kind:'run',taskId:task.id}),controller=new AbortController();
const browsers=new BrowserTools(directory,()=>({connection:'separate',headless:true,choose:()=>{throw Error('No model needed');}}));
const adapter=automationBrowser(browsers,{sourceUrl:source,readTabKey:'read:main'}),flow=automationWorkflow({db,run,signal:controller.signal,browser:adapter,report:(id,runId,status,summary)=>db.finish(id,runId,status,summary)});
const call=(name,args={})=>flow.call(a.id,run.id,name,args);
async function document(result){let text='';for(;;){text+=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');if(result.snapshot.nextOffset===null)break;result=await call('browser_read_part',{snapshotId:result.snapshot.id,offset:result.snapshot.nextOffset});}return JSON.parse(text.replace(/^Page URL: [^\n]+\n/,''));}
try{
 const delayed=await call('browser_open',{url:source+'delayed'}),loaded=await document(delayed);
 assert.equal(delayed.readiness.loading,false);assert.match(loaded.text,/DELAYED_LISTING/);assert.doesNotMatch(loaded.text,/HIDDEN_MUST_NOT_LEAK|KEEP_MY_DRAFT/);
 const before=await call('browser_jev_tabs'),oldId=before.currentTabId;
 const recovered=await call('browser_open',{url:source+'recover'}),page=await document(recovered);
 assert.equal(recovered.readiness.loading,false);assert.match(page.text,/RECOVERED_LISTING/);assert.equal(freshRequests,2);
 const after=await call('browser_jev_tabs');assert.equal(after.tabs.length,before.tabs.length+1);assert.notEqual(after.currentTabId,oldId);
 const client=(await browsers.connect(a.id)).client;
 assert.equal(await client.tab(oldId).page.locator('input[name="draft"]').inputValue(),'KEEP_MY_DRAFT');
 assert.equal(await client.tab(oldId).page.locator('[id="S:2"]').getAttribute('hidden'),'');
 const stuck=await call('browser_open',{url:source+'stuck'}),incomplete=await document(stuck);
 assert.equal(stuck.readiness.loading,true);assert.equal(stuck.technicalIssue.verified,true);assert.doesNotMatch(incomplete.text,/NOT_VISIBLE_LISTING/);
 db.saveScanProgress(a.id,run.id,{pendingUrls:[source+'stuck'],reason:'Retry rendering'},{url:source+'stuck',text:''});
 await call('finish_automation_run',{status:'blocked',summary:'Rendering still pending'});
 assert.equal(db.run(run.id).status,'interrupted');assert.equal(db.run(run.id).recovery.reason,'technical_page');assert.equal(submits,0);
 console.log('SCAN_PAGE_RECOVERY_BROWSER_PASS',JSON.stringify({directory,freshRequests,originalDraftPreserved:true,hiddenContentExcluded:true,automaticRetry:true,submits}));
}finally{controller.abort();await browsers.close();core.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
