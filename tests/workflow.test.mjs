import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';
import {startMcp} from '../app/mcp.mjs';
const listing={url:'https://employer.example/jobs/42?utm_source=linkedin',company:'Company',role:'Legal Operations',location:'Berlin hybrid',fit:'Relevant contract review experience'};
const profile=(s,name='Candidate')=>s.saveProfile({name,preferences:'Berlin hybrid',facts:'',authorization:'prepare'});
const proof={kind:'success_page',text:'Thank you. We received your application.',url:'https://employer.example/confirmation',documents:'Original CV.pdf'};
test('dedupe, scope enforcement, proof requirement and recovery survive restart',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'jobloop-test-'));let s=new Store(path.join(dir,'db'));
 try{const p=profile(s),j=s.addJob(p.id,listing).job;
 assert.equal(s.addJob(p.id,{...listing,url:'https://employer.example/jobs/42?utm_source=other'}).duplicate,true);
 assert.equal(s.addJob(p.id,{...listing,url:'https://linkedin.example/jobs/99'}).duplicate,true);
 s.updateJob(p.id,j.id,'working','Opening form','session');s.updateJob(p.id,j.id,'prepared','CV ready','session');
 assert.throws(()=>s.updateJob(p.id,j.id,'submitting','Sending','session'),/yetkisi/);
 s.saveProfile({...p,authorization:'submit'});s.updateJob(p.id,j.id,'submitting','Sending','session');
 assert.throws(()=>s.recordSubmission(p.id,j.id,{...proof,text:''},'session'));
 s.recoverSession(p.id,'session');assert.equal(s.job(p.id,j.id).status,'uncertain');
 assert.throws(()=>s.updateJob(p.id,j.id,'working','Retry','other'));
 s.close();s=new Store(path.join(dir,'db'));assert.equal(s.job(p.id,j.id).status,'uncertain');
 s.reclaim(p.id,j.id,'new-session');s.recordSubmission(p.id,j.id,proof,'new-session');assert.equal(s.job(p.id,j.id).status,'submitted');
 assert.throws(()=>s.updateJob(p.id,j.id,'working','Retry','new-session'));
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('candidate isolation and answers are durable',()=>{const s=new Store(':memory:');try{const a=profile(s,'A'),b=profile(s,'B'),j=s.addJob(a.id,listing).job;assert.throws(()=>s.job(b.id,j.id));assert.equal(s.jobs(b.id).length,0);const q=s.ask(a.id,{question:'Start date?',jobId:j.id});assert.throws(()=>s.answer(b.id,q.id,'Now'));s.answer(a.id,q.id,'Next month');assert.equal(s.questions(a.id)[0].answer,'Next month');assert.throws(()=>s.answer(a.id,q.id,'Again'));}finally{s.close();}});
test('source settings persist, cap submission mode and protect referenced sources',()=>{const s=new Store(':memory:');try{
 const p=s.saveProfile({name:'Source test',preferences:'Berlin',facts:'Known facts',authorization:'submit'}),source=s.sources(p.id)[0];
 assert.equal(s.sources(p.id).length,14);s.saveSource(p.id,{...source,applyMode:'prepare',intervalMinutes:12});assert.equal(s.source(p.id,source.id).intervalMinutes,12);
 const j=s.addJob(p.id,{...listing,sourceId:source.id}).job;s.updateJob(p.id,j.id,'working','Form','session');s.updateJob(p.id,j.id,'prepared','Ready','session');assert.throws(()=>s.updateJob(p.id,j.id,'submitting','Send','session'),/otomatik gönderime/);assert.throws(()=>s.deleteSource(p.id,source.id),/silmek yerine kapat/);
 const policy=s.saveApplicationPolicy(p.id,{autoFillKnown:true,acceptPrivacy:true,demographic:'prefer_not_to_say',marketing:'decline',unknownImportant:'skip',legalAgreements:'ask'});assert.equal(policy.unknownImportant,'skip');assert.equal(s.profile(p.id).applicationPolicy.acceptPrivacy,true);
 }finally{s.close();}});
test('real MCP HTTP transport is authenticated, scoped and validates inputs',async()=>{
 const s=new Store(':memory:'),a=profile(s,'A'),b=profile(s,'B');const server=await startMcp(s);const token=server.grant(a.id,'session');
 const call=async(method,params={},bearer=token)=>{const r=await fetch(server.endpoint,{method:'POST',headers:{authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return{status:r.status,body:await r.json()};};
 try{assert.equal((await call('initialize',{},'wrong')).status,401);assert.equal((await call('initialize')).body.result.serverInfo.name,'jobloop');const added=await call('tools/call',{name:'add_job',arguments:listing});assert.equal(added.body.result.isError,undefined);assert.equal(s.jobs(a.id).length,1);assert.equal(s.jobs(b.id).length,0);const bad=await call('tools/call',{name:'add_job',arguments:{...listing,candidateId:b.id}});assert.equal(bad.body.result.isError,true);server.revoke(token);assert.equal((await call('tools/list')).status,401);}finally{await server.close();s.close();}
});
