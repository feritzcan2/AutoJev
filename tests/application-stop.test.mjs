import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {Campaigns} from '../app/campaign.mjs';
import {startMcp} from '../app/mcp.mjs';
import {isStopReply} from '../app/application-stop.mjs';
import {addRankedJob} from './rank-fixture.mjs';
function fixture(){
 const store=new Store(':memory:'),p=store.saveProfile({name:'Test',preferences:'Remote',authorization:'submit'});
 for(const source of store.sources(p.id))store.saveSource(p.id,{...source,enabled:false});
 const job=addRankedJob(store,p.id,{company:'Midas',role:'Engineer',url:'https://example.test/midas',location:'Remote',fit:'Test'}).job;
 for(const status of ['working','prepared','submitting'])store.updateJob(p.id,job.id,status,'Form','session');
 store.saveCampaign(p.id,{status:'running',target:100,task:{id:'task',kind:'application',jobId:job.id},attempts:{}});
 const c=new Campaigns(store,{active:()=>({sessionId:'session',state:'Working'}),changed:()=>{}});
 return {store,p,job,c};
}
const blocker={kind:'access',evidence:'Visible challenge iframe requests verification',reasonUnknown:'Jev cannot interact with this iframe',recovery:{kind:'captcha',userActionReason:'Complete visible challenge',captchaCheck:{state:'required',capability:'not_exposed',evidence:'Visible challenge',limitation:'iframe controls unavailable'}}};
test('only clear application stop replies count, not negative form answers or challenge bypass requests',()=>{
 for(const answer of ['atla midas','Midas’ı atla','skip Midas','atla','devam etme','yok başvurma'])assert.equal(isStopReply(answer,{company:'Midas'}),true,answer);
 for(const answer of ['hayır','atlama','atla demedim','CAPTCHA’yı atla','skip CAPTCHA','skip another employer','atla ama sonra devam et','Midas’ı atlamak istemiyorum'])assert.equal(isStopReply(answer,{company:'Midas'}),false,answer);
 assert.equal(isStopReply('evet',{company:'Midas'},{question:'Başvuruyu tamamen durdurmamı onaylıyor musun? Evet ya da hayır diye yanıtla.'}),true);
 assert.equal(isStopReply('evet',{company:'Midas'},{question:'Bu belgeyi paylaşır mısın?'}),false);
});
test('one MCP question saves uncertain + report; one stop tool preserves uncertainty and removes future work',async()=>{
 const {store,p,job,c}=fixture();let server;
 try{
 server=await startMcp(store,()=>{},undefined,null,{get:id=>store.campaign(id),askCaptcha:(...a)=>c.askCaptcha(...a),stopApplicationFollowup:(...a)=>c.stopApplicationFollowup(...a)});
 const token=server.grant(p.id,'session');
 const call=async(name,args)=>{const response=await fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const {result}=await response.json();assert.ok(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);};
 const q=await call('ask_candidate',{jobId:job.id,question:'Doğrulamayı tamamlar mısın?',applicationBlocker:blocker});
 assert.equal(q.completion.taskReported,true);assert.equal(store.job(p.id,job.id).status,'uncertain');assert.equal(store.campaign(p.id).task.report.outcome,'blocked');
 store.answer(p.id,q.id,'atla midas');
 c.browserReady=()=>{throw Error('Stopping must not wait for Chrome');};assert.equal(c.browserGate(p.id,store.campaign(p.id),store.campaign(p.id).task),true);
 const campaign=store.campaign(p.id);campaign.task={id:'verify',kind:'verify',jobId:job.id};campaign.pendingResumes={[job.id]:q.id};store.saveCampaign(p.id,campaign);
 const stopped=await call('stop_application_followup',{jobId:job.id,questionId:q.id});
 assert.equal(stopped.status,'uncertain');assert.equal(stopped.proof,null);assert.equal(stopped.completion.taskReported,true);assert.equal(store.campaign(p.id).task.report.outcome,'done');
 c.signal(p.id,'Idle');assert.equal(store.campaign(p.id).task,null);
 const queued={...store.campaign(p.id),pendingResumes:{[job.id]:q.id},pendingRetries:{[job.id]:{requestId:'old'}}};assert.equal(c.choose(p.id,queued),null);
 assert.throws(()=>store.updateJob(p.id,job.id,'working','Retry','session'),/takibi/);
 // A later real receipt may still establish the truth; stopping is not submission proof.
 store.recordSubmission(p.id,job.id,{kind:'confirmation_email',text:'Application received',url:job.url,documents:'CV'},'session');assert.equal(store.job(p.id,job.id).status,'submitted');
 }finally{await server?.close();store.close();}
});
test('CAPTCHA status failure rolls back question creation and report',()=>{
 const {store,p,job,c}=fixture();try{
 const original=store.updateJob;store.updateJob=()=>{throw Error('Storage failure');};
 assert.throws(()=>c.askCaptcha(p.id,'session',{jobId:job.id,question:'Challenge?',applicationBlocker:blocker}),/Storage failure/);
 assert.equal(store.questions(p.id).length,0);assert.equal(store.campaign(p.id).task.report,undefined);assert.equal(store.job(p.id,job.id).status,'submitting');store.updateJob=original;
 }finally{store.close();}
});
test('stopping cannot use another application answer or another session',()=>{
 const {store,p,job,c}=fixture();try{
 const q=store.ask(p.id,{question:'Global question'});store.answer(p.id,q.id,'atla');
 assert.throws(()=>c.stopApplicationFollowup(p.id,'session',{jobId:job.id,questionId:q.id}),/bağlı/);
 const own=store.ask(p.id,{jobId:job.id,question:'Challenge?'});store.answer(p.id,own.id,'atla');
 assert.throws(()=>c.stopApplicationFollowup(p.id,'other',{jobId:job.id,questionId:own.id}),/etkin/);
 assert.equal(store.job(p.id,job.id).status,'submitting');
 }finally{store.close();}
});
