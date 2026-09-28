import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readZipArchive} from './zip-fixture.mjs';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {WorkerCampaigns} from '../app/worker-campaigns.mjs';
import {savePreparation,editPreparation,preparationProfileKey} from '../app/preparation.mjs';
import {exportPreparation} from '../app/preparation-export.mjs';
import {startMcp} from '../app/mcp.mjs';
import {rankInput} from './rank-fixture.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';

async function fixture(t,authorization='submit'){
 const directory=await mkdtemp(join(tmpdir(),'jobloop-preparation-')),store=new Store(join(directory,'db'));
 const p=store.saveProfile({name:'Test Candidate',preferences:'Remote',facts:'Software engineer',authorization}),sessions=new Map();
 for(const source of store.sources(p.id))store.saveSource(p.id,{...source,enabled:false,applyMode:'auto'});
 const options={active:(id,worker='main')=>sessions.get(worker),changed:()=>{},launch:async(id,prompt,job,worker='main')=>sessions.set(worker,{candidateId:id,sessionId:worker,state:'Idle'}),send:async()=>{},stop:async(id,worker='main')=>sessions.delete(worker)};
 const c=new Campaigns(store,options),pool=new WorkerCampaigns(store,options);
 let n=0;const add=()=>store.addJob(p.id,{company:'Employer '+(++n),role:'Engineer',location:'Remote',fit:'Test',url:'https://example.test/jobs/'+n}).job;
 const job=add(),root=store.candidateDirectory(p.id);await mkdir(join(root,'documents',job.id),{recursive:true});await writeFile(join(root,'documents',job.id,'letter.md'),'Original cover letter');
 const input=(patch={})=>({jobId:job.id,revision:store.job(p.id,job.id).preparation.revision,profileKey:preparationProfileKey(store.profile(p.id)),status:'ready',coverage:'complete',formUrl:'https://example.test/apply',coverageNote:'Documents and questions inspected',note:'Documents and answers ready',requirements:[{id:'letter',label:'Cover letter',kind:'document',required:'required',status:'ready',evidence:'Cover letter required',format:'Markdown',acceptedExtensions:['.md'],documentPath:`documents/${job.id}/letter.md`},{id:'motivation',label:'Why this company?',kind:'answer',required:'required',status:'ready',evidence:'Motivation *',answer:'Verified candidate experience',maxLength:500}],...patch});
 const finish=()=>{c.signal(p.id,'Working');c.report(p.id,'main',{taskId:store.campaign(p.id).task.id,outcome:'done',note:'Package ready'});c.signal(p.id,'Idle');};
 const start=async()=>{c.queuePreparation(p.id,job.id);await c.start(p.id);store.updateJob(p.id,job.id,'working','Inspecting','main');};
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 return {directory,store,p,job,root,c,pool,add,input,finish,start};
}

for(const authorization of ['research','prepare','submit'])test(`explicit prepare under ${authorization} stops durably until separate submit action`,async t=>{
 const f=await fixture(t,authorization),{store,p,job,c}=f;await f.start();
 assert.equal(store.campaign(p.id).task.kind,'preparation');assert.equal(store.taskContext(p.id).applicationAuthorization.mode,'prepare');
 assert.throws(()=>store.updateJob(p.id,job.id,'submitting','Send','main'),/Hazırlık/);
 assert.throws(()=>store.assertSubmissionAllowed(p.id,job.id,job.url,'main'),/Gönderim bekletiliyor/);
 assert.throws(()=>c.report(p.id,'main',{taskId:store.campaign(p.id).task.id,outcome:'done',note:'No package'}),/paketi tamamlanmadı/);
 await savePreparation(store,p.id,f.input(),'main');f.finish();assert.equal(c.choose(p.id,store.campaign(p.id)),null);
 await c.pause(p.id);await c.start(p.id);assert.equal(store.campaign(p.id).task,null);
 assert.equal(store.job(p.id,job.id).preparation.hold,true);
 c.queueApplication(p.id,job.id);await c.tick();assert.equal(store.campaign(p.id).task.kind,'application');
 assert.equal(store.taskContext(p.id).applicationAuthorization.mode,'submit');assert.equal(store.job(p.id,job.id).preparation.hold,false);
 for(const status of ['working','prepared','submitting'])store.updateJob(p.id,job.id,status,'Continue','main');
});

test('preparation persists across app restart and bypasses scoring, source mode and completed target',async t=>{
 const f=await fixture(t,'research'),{store,p,c,job}=f,submitted=f.add();store.saveJob({...submitted,status:'submitted'},'test');
 const source=store.sources(p.id)[0];store.saveSource(p.id,{...source,applyMode:'find_only'});store.saveJob({...job,sourceId:source.id},'test');
 store.saveCampaign(p.id,{status:'complete',target:1,intervalMinutes:30,attempts:{}});await f.start();
 await savePreparation(store,p.id,f.input(),'main');f.finish();await c.tick();
 const reopened=new Store(join(f.directory,'db'));
 try{assert.equal(reopened.job(p.id,job.id).preparation.hold,true);assert.equal(reopened.job(p.id,job.id).preparation.status,'ready');assert.equal(reopened.profile(p.id).authorization,'research');}finally{reopened.close();}
});

test('source prepare mode creates the same package task even when global automatic sending is enabled',async t=>{
 const f=await fixture(t),{store,p,job,c}=f,source=store.sources(p.id)[0];store.saveSource(p.id,{...source,applyMode:'prepare'});store.saveJob({...job,sourceId:source.id},'test');store.rankJob(p.id,job.id,rankInput(store,p.id,90));
 await c.start(p.id);assert.equal(store.campaign(p.id).task.kind,'preparation');assert.equal(store.taskContext(p.id).applicationAuthorization.mode,'prepare');
 store.saveSource(p.id,{...source,applyMode:'auto'});assert.throws(()=>store.updateJob(p.id,job.id,'submitting','Send','main'),/Hazırlık/);
});

test('partial coverage and missing required documents cannot claim ready; valid partial package can finish',async t=>{
 const f=await fixture(t);await f.start();
 await assert.rejects(()=>savePreparation(f.store,f.p.id,f.input({coverage:'partial'}),'main'),/tamamen incelenmeli/);
 const missing={id:'diploma',label:'Diploma',kind:'document',required:'required',status:'missing',evidence:'Diploma required'};
 await assert.rejects(()=>savePreparation(f.store,f.p.id,f.input({requirements:[missing]}),'main'),/tamamlanmalı/);
 await savePreparation(f.store,f.p.id,f.input({status:'partial',coverage:'partial',requirements:[missing],coverageNote:'Next step requires diploma'}),'main');f.finish();
 assert.equal(f.c.choose(f.p.id,f.store.campaign(f.p.id)),null);
});

test('question answers and technical retries resume preparation without submission consent',async t=>{
 const f=await fixture(t),{store,p,job,c}=f;await f.start();await savePreparation(store,p.id,f.input({status:'waiting'}),'main');
 const q=c.askApplicationQuestion(p.id,'main',{jobId:job.id,question:'Başlama tarihi?',resumeContext:{browser:'Chrome',tabId:'tab',url:job.url,step:'Availability',nextAction:'Prepare answer'},applicationBlocker:{kind:'required_form_field',evidence:'Start date required',reasonUnknown:'Not recorded'}});
 c.signal(p.id,'Working');c.signal(p.id,'Idle');assert.equal(c.choose(p.id,store.campaign(p.id)),null);
 store.answer(p.id,q.id,'Two months');await c.continueAfterAnswer(p.id,q.id);
 assert.equal(store.campaign(p.id).task.kind,'preparation');assert.equal(store.taskContext(p.id).applicationAuthorization.mode,'prepare');assert.equal(store.job(p.id,job.id).resumeContext.tabId,'tab');
 assert.equal(store.job(p.id,job.id).manualApplication,null);
});

test('files are scoped and validated, user edits are versioned and retained, CV changes mark package stale',async t=>{
 const f=await fixture(t),{store,p,job}=f;await f.start();
 let input=f.input();input.requirements[0].documentPath='../other.txt';await writeFile(join(f.directory,'other.txt'),'Private');await assert.rejects(()=>savePreparation(store,p.id,input,'main'));
 const link=join(f.root,'documents',job.id,'external');await symlink(f.directory,link,process.platform==='win32'?'junction':'dir');input=f.input();input.requirements[0].documentPath=`documents/${job.id}/external/other.txt`;await assert.rejects(()=>savePreparation(store,p.id,input,'main'));
 input=f.input();input.requirements[0].acceptedExtensions=['.pdf'];await assert.rejects(()=>savePreparation(store,p.id,input,'main'),/formatı/);
 input=f.input();input.requirements[0].maxBytes=1;await assert.rejects(()=>savePreparation(store,p.id,input,'main'),/boyut/);
 await savePreparation(store,p.id,f.input(),'main');f.finish();
 await editPreparation(store,p.id,job.id,{revision:store.job(p.id,job.id).preparation.revision,requirementId:'letter',content:'My own letter'});
 await editPreparation(store,p.id,job.id,{revision:store.job(p.id,job.id).preparation.revision,requirementId:'motivation',content:'My own answer'});
 assert.equal(await readFile(join(f.root,'documents',job.id,'letter.md'),'utf8'),'Original cover letter');
 const letter=store.job(p.id,job.id).preparation.requirements[0].documentPath;
 {f.c.queuePreparation(p.id,job.id);await f.c.tick();await savePreparation(store,p.id,f.input(),'main');f.finish();}
 const updated=store.job(p.id,job.id).preparation;assert.equal(updated.requirements[0].documentPath,letter);assert.equal(updated.requirements[1].answer,'My own answer');
 store.setCv(p.id,'new-cv.pdf');assert.equal(store.snapshot(p.id).jobs.find(j=>j.id===job.id).preparation.stale,true);
 f.c.queuePreparation(p.id,job.id);await f.c.tick();input=f.input();store.saveProfile({...store.profile(p.id),facts:'Changed while working'});await assert.rejects(()=>savePreparation(store,p.id,input,'main'),/Profil veya CV değişti/);
});

test('package export contains only linked files and exact edited answers in a valid ZIP',async t=>{
 const f=await fixture(t);await f.start();await savePreparation(f.store,f.p.id,f.input(),'main');f.finish();
 await writeFile(join(f.root,'documents',f.job.id,'unlinked.txt'),'Do not export this');
 const result=await exportPreparation(f.store,f.p.id,f.job.id),archive=Buffer.from(result.base64,'base64'),entries=readZipArchive(archive);
 assert.deepEqual([...entries.keys()].sort(),['answers.txt','letter-letter.md','requirements.txt']);
 assert.equal(entries.get('letter-letter.md').toString(),'Original cover letter');
 assert.match(entries.get('answers.txt').toString(),/Verified candidate experience/);
 assert.match(entries.get('requirements.txt').toString(),/Employer 1 — Engineer/);
 const corrupted=Buffer.from(archive),start=30+corrupted.readUInt16LE(26)+corrupted.readUInt16LE(28);corrupted[start]^=1;assert.throws(()=>readZipArchive(corrupted),/content CRC/);
});

test('workers reserve different preparation jobs and cannot save another worker package',async t=>{
 const f=await fixture(t),{store,p,job,pool,c}=f,second=f.add(),worker=store.workerState.add(p.id);c.queuePreparation(p.id,job.id);c.queuePreparation(p.id,second.id);await pool.start(p.id);
 const a=store.campaign(p.id).task,b=store.forWorker(worker.id).campaign(p.id).task;assert.notEqual(a.jobId,b.jobId);assert.equal(a.kind,'preparation');assert.equal(b.kind,'preparation');
 await assert.rejects(()=>savePreparation(store.forWorker(worker.id),p.id,f.input(),'other'),/Etkin hazırlık/);
});

test('MCP saves a preparation package and rejects writes from research tasks',async t=>{
 const f=await fixture(t);await f.start();const mcp=await startMcp(f.store),token=mcp.grant(f.p.id,'main');t.after(()=>mcp.close());
 const call=async()=>{const res=await fetch(mcp.endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'save_preparation',arguments:f.input()}})});return (await res.json()).result;};
 assert.notEqual((await call()).isError,true);
 f.store.saveCampaign(f.p.id,{...f.store.campaign(f.p.id),task:{id:'search',kind:'search'}});assert.equal((await call()).isError,true);
});

test('Jev refuses a final send in preparation even if the job incorrectly says submitting',async()=>{
 const browser=new JevBrowser('/unused-preparation-test');browser.fresh=async()=>true;browser.observe=async()=>({status:'ready'});
 let dispatched=false;browser.beforeSubmit=()=>{dispatched=true;};
 const result=await browser.execute({id:'tab',owner:'owner',page:{url:()=> 'https://example.test/apply'}},{action:{kind:'click',role:'button',label:'Submit application'},observed:{},operation:'CLICK'},undefined,{taskKind:'preparation',activeJobId:'job',jobs:[{id:'job',status:'submitting'}]});
 assert.equal(result.executed,false);assert.equal(result.blockerOrigin,'jobloop_preparation_hold');assert.equal(dispatched,false);
});

test('a separate-browser draft resumes on its stopped owning worker',async t=>{
 const f=await fixture(t),{store,p,job,pool}=f,worker=store.workerState.add(p.id);
 store.saveProfile({...store.profile(p.id),browserMode:'separate'});store.saveJob({...job,status:'blocked',browserWorkerId:worker.id},'test');
 store.saveCampaign(p.id,{status:'running',target:100,intervalMinutes:30,task:null,attempts:{}});
 store.forWorker(worker.id).saveCampaign(p.id,{status:'stopped',target:100,intervalMinutes:30,task:null,attempts:{}});
 await pool.queueAndStartPreparation(p.id,job.id);
 assert.equal(store.forWorker(worker.id).campaign(p.id).task.kind,'preparation');assert.equal(store.forWorker(worker.id).campaign(p.id).task.jobId,job.id);
});

test('a later listing alias cannot hide the saved package or evade its submission hold',async t=>{
 const f=await fixture(t),{store,p,job}=f;await f.start();await savePreparation(store,p.id,f.input(),'main');f.finish();
 const alias=store.addJob(p.id,{company:job.company,role:job.role,location:job.location,fit:'Other source',url:'https://example.test/other-source'}).job;
 store.rankJob(p.id,alias.id,rankInput(store,p.id,99));
 store.jobRegistry.bind(p.id,alias.id,job.url,'Observed redirect',{allowUnknown:true});
 assert.equal(store.canonicalJobId(p.id,alias.id),job.id);assert.ok(store.job(p.id,alias.id).duplicateApplication);
 assert.throws(()=>store.assertSubmissionAllowed(p.id,alias.id,job.url,'main'));
 f.c.queueApplication(p.id,job.id);assert.equal(store.canonicalJobId(p.id,alias.id),job.id);
});

test('refresh requested after a done report but before Idle starts a new preparation task',async t=>{
 const f=await fixture(t),{store,p,job,c}=f;await f.start();await savePreparation(store,p.id,f.input(),'main');
 const oldTask=store.campaign(p.id).task.id;c.signal(p.id,'Working');c.report(p.id,'main',{taskId:oldTask,outcome:'done',note:'Ready'});
 c.queuePreparation(p.id,job.id);c.signal(p.id,'Idle');await c.tick();
 assert.equal(store.campaign(p.id).task.kind,'preparation');assert.notEqual(store.campaign(p.id).task.id,oldTask);assert.equal(store.campaign(p.id).task.report,null);
});
