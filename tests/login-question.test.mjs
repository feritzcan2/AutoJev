import test from 'node:test';
import assert from 'node:assert/strict';
import {asksForLogin,validateLoginQuestion} from '../app/login-question.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';

const login='Create a new account\nSign up with Google\nFirst name\nLast name\nEmail\nPassword\nAlready have an account? Log in';
const page=(text,extra={})=>({id:'current',url:'https://portal.test/login',text:'Page URL: https://portal.test/login\n'+JSON.stringify({text,...extra})});
const proof={kind:'login',snapshotId:'current',evidence:'Create a new account'};

test('a signup link and hidden login controls cannot establish an authentication barrier',()=>{
 const listing=page('Backend role\nLink: Apply now — https://portal.test/signup?redirect=role\nApply now',{controls:[{label:'Email',visible:false},{label:'Password',visible:false}]});
 assert.throws(()=>validateLoginQuestion(listing,{...proof,evidence:'Backend role'}),/giriş formu/);
 const signedIn=page('Complete your profile\nSaved jobs\nNotifications\nSign up',{passwordFields:[]});
 assert.throws(()=>validateLoginQuestion(signedIn,{...proof,evidence:'Complete your profile'}),/giriş formu/);
});

test('login proof must come from a current fully rendered page',()=>{
 assert.equal(validateLoginQuestion(page(login),proof).kind,'login');
 assert.throws(()=>validateLoginQuestion({...page(login),readiness:{loading:true}},proof),/yükleniyor/);
 assert.throws(()=>validateLoginQuestion(page(login),{...proof,snapshotId:'old'}),/son snapshot/);
 assert.throws(()=>validateLoginQuestion(page(login),{...proof,evidence:'Please log in to continue'}),/bulunamadı/);
 assert.equal(validateLoginQuestion(page('Please sign in to continue'),{...proof,evidence:'Please sign in to continue'}).kind,'login');
 assert.equal(asksForLogin({text:'Bu tarayıcıda hesabınıza giriş yaptınız mı?'}),true);
 assert.equal(asksForLogin({text:'Maaş beklentiniz nedir?'}),false);
});

function fixture(t){
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),a=db.create('job-search',{goal:'Prepare a form',criteria:{preferences:'Remote'},sources:['https://portal.test/jobs']});db.review(a.id);db.skipTrial(a.id);
 const run=db.begin(a.id,'run');let content=login,reads=0;
 const browser={call:async()=>{reads++;return {content:[{type:'text',text:'Page URL: https://portal.test/login\n'+JSON.stringify({text:content})}]};}};
 const flow=automationWorkflow({db,run,signal:{aborted:false},browser,report:()=>{}});
 return {db,id:a.id,call:(name,args={})=>flow.call(a.id,run.id,name,args),setContent:text=>{content=text;},reads:()=>reads};
}

test('login questions recheck the live page and reject a barrier that disappeared after the cached read',async t=>{
 const f=fixture(t),read=await f.call('browser_open',{url:'https://portal.test/login'});
 f.setContent('Complete your profile\nNotifications\nSaved jobs');
 await assert.rejects(f.call('ask_workspace_question',{text:'Hesabınıza giriş yapın.',accessCheck:{...proof,snapshotId:read.snapshot.id}}),/bulunamadı|giriş formu/);
 assert.equal((f.db.get(f.id).questions??[]).length,0);assert.ok(f.reads()>=3);
});

test('a real live login barrier is saved with its evidence and ordinary questions remain available',async t=>{
 const f=fixture(t);await assert.rejects(f.call('ask_workspace_question',{text:'Hesabınıza giriş yapın.'}),/accessCheck/);
 const read=await f.call('browser_open',{url:'https://portal.test/login'});
 const q=await f.call('ask_workspace_question',{text:'Hesabınıza giriş yapın.',accessCheck:{...proof,snapshotId:read.snapshot.id}});
 assert.equal(q.accessCheck.url,'https://portal.test/login');assert.equal(q.accessCheck.evidence,'Create a new account');assert.ok(q.accessCheck.checkedAt);
 const fact=await f.call('ask_workspace_question',{text:'Ne zaman başlayabilirsiniz?'});assert.equal(fact.accessCheck,undefined);
});
