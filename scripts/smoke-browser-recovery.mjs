import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BrowserTools} from '../app/browser.mjs';
import {Store} from '../app/store.mjs';
import {startMcp} from '../app/mcp.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jobloop-recovery-'));
const site=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>Recovery fixture</title><form><label>Name<input name="name"></label><label>Email<input name="email" type="email"></label><label>CV<input type="file" name="cv"></label></form>');});await new Promise(r=>site.listen(0,'127.0.0.1',r));
const store=new Store(':memory:');const p=store.saveProfile({name:'Synthetic recovery',preferences:'Remote',authorization:'prepare',browserMode:'jev'});
const job=store.addJob(p.id,{url:`http://127.0.0.1:${site.address().port}/exact-stored-id`,company:'Fixture',role:'Engineer',location:'Remote',fit:'Test'}).job;
store.saveCampaign(p.id,{status:'running',task:{id:'task',kind:'application',jobId:job.id},attempts:{}});
// Isolated Chrome profile; no access to the user's Chrome or applications.
const browsers=new BrowserTools(dir,()=> 'jev',()=>({connection:'separate',headless:true,lifecycle:{activeJobId:job.id,jobs:store.jobs(p.id)}}));
browsers.onProgress=(id,jobId,value,owner)=>store.saveBrowserProgress(id,jobId,value,owner);
const mcp=await startMcp(store,()=>{},undefined,browsers),token=mcp.grant(p.id,'s');
const call=async(name,args={})=>{const response=await fetch(mcp.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const {result}=await response.json();assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
const value=result=>JSON.parse(result.content[0].text);
try{
 assert.equal((await call('browser_jev_open',{url:'http://wrong.example/typo'})).status,'browser_wait');
 assert.equal((await call('ask_candidate',{question:'Reconnect Chrome?'})).status,'browser_wait');assert.equal(store.questions(p.id).length,0);
 await browsers.connections.pending.get(p.id);assert.equal(browsers.status(p.id).ready,true);
 const opened=value(await browsers.resumeApplication(p.id,job.id,'s'));assert.equal(opened.url,job.url);assert.equal(opened.resume.reopened,true);
 const name=opened.fillFields.find(f=>f.label==='Name');const filled=await call('browser_jev_fill_fields',{tabId:opened.tabId,fields:[{fieldId:name.fieldId,text:'Synthetic Candidate'}]});assert.equal(filled.verifiedCount,1);
 const workspace=path.join(dir,'candidates',p.id);await mkdir(workspace,{recursive:true});await writeFile(path.join(workspace,'CV.txt'),'Synthetic CV');
 await call('browser_jev_upload',{tabId:opened.tabId,uploadId:filled.uploads[0].uploadId,filePath:path.join(workspace,'CV.txt')});
 assert.equal(store.job(p.id,job.id).browserProgress.fields.find(f=>f.label==='Name').value,'Synthetic Candidate');assert.deepEqual(store.job(p.id,job.id).browserProgress.files[0].files,['CV.txt']);
 const reused=value(await browsers.resumeApplication(p.id,job.id,'s'));assert.equal(reused.tabId,opened.tabId);assert.equal(reused.resume.reopened,false);
 const {client}=await browsers.connect(p.id);await client.tab(opened.tabId).page.close();
 const reopened=value(await browsers.resumeApplication(p.id,job.id,'s'));assert.notEqual(reopened.tabId,opened.tabId);assert.equal(reopened.url,job.url);assert.equal(reopened.resume.previousProgress.fields.find(f=>f.label==='Name').value,'Synthetic Candidate');assert.equal(reopened.fillFields.find(f=>f.label==='Name').value,'');
 await client.tab(reopened.tabId).page.close();const uncertain=store.job(p.id,job.id);uncertain.status='uncertain';uncertain.sessionId='s';store.saveJob(uncertain,'test');const count=client.tabs.size;
 assert.equal(value(await browsers.resumeApplication(p.id,job.id,'s')).status,'verification_required');assert.equal(client.tabs.size,count);
 console.log('PASS: connection wait, no per-job question, canonical URL, live tab reuse, automatic field/CV checkpoint, missing tab recovery, uncertain submission protected');
}finally{await mcp.close();await browsers.close();store.close();await new Promise(r=>site.close(r));await rm(dir,{recursive:true,force:true});}
