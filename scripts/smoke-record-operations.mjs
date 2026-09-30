import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {workspaceDirectory} from '../app/workspace-paths.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),data=await mkdtemp(path.join(os.tmpdir(),'record-operations-ui-'));
let submissions=0;
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.method==='POST'){submissions++;res.end('<h1>Application received</h1><p>Confirmation LOCAL-123</p>');}else res.end('<h1>Local role</h1><form method="post"><input name="name" value="Test Candidate"><label>CV<input type="file" name="cv"></label><button type="submit">Send application</button></form>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/apply`;
const store=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(store),workspaces=[];
for(const template of ['job-search','housing','appointment']){
 const def=db.template(template),a=db.create(template,{title:template,goal:'Local action test',sources:[url],criteria:Object.fromEntries(def.fields.filter(f=>f.required).map(f=>[f.id,'Known']))});db.review(a.id);db.skipTrial(a.id);
 const documents=path.join(workspaceDirectory(data,store.workspaces.get(a.id)),'documents');await mkdir(documents,{recursive:true});await writeFile(path.join(documents,'test-cv.pdf'),'Local fixture document');
 const run=db.begin(a.id,'run'),item=db.record(a.id,run.id,{url,title:template+' result',summary:'Local fixture'});db.finish(a.id,run.id,'completed','Found');workspaces.push({id:a.id,item});
 db.store.workspaces.workers.setEnabled(a.id,'main',false);
}store.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const application=await electron.launch({executablePath:require('electron'),args:[root],env});
try{
 const page=await application.firstWindow({timeout:20000}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>document.querySelectorAll('#candidates option').length>=3);
 await application.evaluate(async(_,url)=>{const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}),{Engine}=await load(url),request=Engine.prototype.request;globalThis.recordStarts=[];Engine.prototype.request=function(op,args={}){if(op==='start'){globalThis.recordStarts.push(args);return Promise.resolve({});}if(op==='resize')return Promise.resolve({});return request.call(this,op,args);};},pathToFileURL(path.join(root,'app/engine.mjs')).href);
 let rpcId=0,startCount=0;
 const waitStart=async()=>{startCount++;await application.evaluate(async(_,count)=>{for(let i=0;i<150;i++){if(globalThis.recordStarts.length>=count)return;await new Promise(r=>setTimeout(r,50));}throw Error('Record task did not start');},startCount);};
 const tool=async(name,args={})=>{const run=await application.evaluate(()=>globalThis.recordStarts.at(-1)),response=await fetch(run.endpoint,{method:'POST',headers:{Authorization:'Bearer '+run.token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name,arguments:args}})}),body=await response.json();assert.ok(!body.error&&!body.result?.isError,JSON.stringify(body));const value=body.result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');try{return JSON.parse(value);}catch{return value;}};
 const finish=async()=>{await tool('finish_automation_run',{status:'completed',summary:'Local test completed'});await page.waitForFunction(()=>document.querySelector('#stop').hidden);};
 for(const [index,{id,item}]of workspaces.entries()){
  await page.selectOption('#candidates',id);await page.locator('[data-view=board]').click();const row=page.locator(`[data-result-id="${item.id}"]`);
  await row.locator('[data-record-operation=prepare]').click();await waitStart();
  await row.locator('[data-column=status]').getByText('Hazırlanıyor',{exact:true}).waitFor();
  assert.equal(await row.locator('[data-record-operation=prepare]').textContent(),'Hazırlanıyor');
  await page.getByRole('button',{name:'İşlemdeki kayıtları göster',exact:true}).click();assert.equal(await page.locator('#automation-result-filter').inputValue(),'active');
  await page.getByRole('button',{name:'Tüm kayıtları göster',exact:true}).click();
  const context=await tool('get_automation_context');assert.equal(context.assignedRecord.id,item.id);assert.equal(context.assignedOperation.kind,'prepare');
  const proposal=`Destination: ${url}\nName: Test Candidate\nDocument: documents/test-cv.pdf\nNo additional commitments.`;
  await tool('record_automation_result',{key:url,url,title:item.title,summary:item.summary,proposal});await finish();
  await row.locator('[data-record-operation=execute]').click();const dialog=page.locator('dialog.automation-record-review');await dialog.waitFor({state:'visible'});assert.equal(await dialog.locator('pre').textContent(),proposal);
  const label=['Onayla ve başvur','Onayla ve mesaj gönder','Onayla ve rezervasyon yap'][index];await dialog.getByRole('button',{name:label,exact:true}).waitFor();
  await page.screenshot({path:path.join(data,workspaces[index].item.title.split(' ')[0]+'-review.png')});
  if(index!==0){await dialog.getByRole('button',{name:'Vazgeç'}).click();continue;}
  await dialog.getByRole('button',{name:label,exact:true}).click();await waitStart();await dialog.waitFor({state:'hidden'});
  const execution=await tool('get_automation_context');assert.equal(execution.recordAuthorization.explicitUserRequest,true);assert.equal(execution.automation.mode,'observe');
  await tool('reserve_automation_action',{itemId:item.id});
  const observed=await tool('browser_open',{url});
  // The local fixture is the only external action target in this smoke test.
  const text=JSON.stringify(observed),match=text.match(/button[^\n]*?ref[=:]([\w-]+)/i)||text.match(/\[ref=([^\]]+)\][^\n]*Send application/);
  assert.ok(match,'Expected an observed submit button reference');
  const uploadRef=text.match(/button[^\n]*?CV[^\n]*?ref[=:]([\w-]+)/i)||text.match(/textbox[^\n]*?CV[^\n]*?ref[=:]([\w-]+)/i);
  assert.ok(uploadRef,'Expected observed CV input');await tool('browser_interact',{operation:'click',ref:uploadRef[1]});
  await tool('browser_upload_document',{ref:uploadRef[1],filePath:'documents/test-cv.pdf'});
  const refreshed=JSON.stringify(await tool('browser_read',{})),submit=refreshed.match(/button[^\n]*?Send application[^\n]*?ref[=:]([\w-]+)/i);assert.ok(submit);
  await tool('browser_interact',{operation:'click',ref:submit[1]});await tool('browser_read',{});
  await tool('record_automation_outcome',{itemId:item.id,status:'completed',evidence:'Application received, confirmation LOCAL-123',url});await finish();
  const snapshot=await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),id);assert.equal(snapshot.results.find(r=>r.id===item.id).status,'completed');assert.equal(submissions,1);assert.equal(await row.locator('[data-record-operation]').count(),0);
 }
 assert.deepEqual(errors,[]);console.log('RECORD_OPERATIONS_UI_PASS',data);
}finally{await application.close();await new Promise(r=>server.close(r));}
