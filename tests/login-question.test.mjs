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
 // A public application form: an Email field plus "designing" is not a login form.
 const form=page('Job Application\nFirst Name*\nLast Name*\nEmail*\nProven experience designing scalable, resilient distributed systems\nSubmit application');
 assert.throws(()=>validateLoginQuestion(form,{...proof,evidence:'Job Application'}),/giriş formu/);
});

for(const url of ['https://example.test/careers/42','https://example.org/view?id=42#application','https://example.net/login'])test(`navigation login and unrelated email fields are not a barrier: ${url}`,()=>{
 for(const text of ['Login\nCareers\nApply\nSubscribe to updates\nEmail','Sign in\nJob Application\nFirst name\nEmail\nSubmit application','Login\nSubscribe\nEmail\nOur password security guidelines']){
  const observed={...page(text,{passwordFields:[],controls:[{label:'Login',role:'button',visible:true},{label:'Email',role:'textbox',visible:true},{label:'Password',role:'textbox',visible:false}]}),url};
  assert.throws(()=>validateLoginQuestion(observed,proof),/giriş formu/);
 }
 assert.throws(()=>validateLoginQuestion({id:'current',url,text:'- button "Login"\n- heading "Newsletter"\n- textbox "Email"'},proof),/giriş formu/);
});

test('login needs visible authentication evidence and never uses a truncated structured observation',()=>{
 assert.equal(validateLoginQuestion(page('Sign in\nEmail\nPassword',{passwordFields:[{label:'Password',fieldId:'password'}]}),proof).kind,'login');
 assert.equal(validateLoginQuestion(page('Sign in\nVerification code',{passwordFields:[],controls:[{label:'Verification code',role:'textbox',visible:true}]}),proof).kind,'login');
 assert.throws(()=>validateLoginQuestion(page('Sign in\nVerification code',{passwordFields:[],controls:[{label:'Verification code',role:'textbox',visible:false}]}),proof),/giriş formu/);
 assert.equal(validateLoginQuestion(page('Please sign in to continue\nEmail',{passwordFields:[]}),proof).kind,'login');
 const truncated={...page(''),text:'Page URL: https://example.test/\n{"text":"Public page","hiddenLabel":"Login Password"'};
 assert.throws(()=>validateLoginQuestion(truncated,proof),/giriş formu/);
});

test('login proof must come from a current fully rendered page',()=>{
 assert.equal(validateLoginQuestion(page(login),proof).kind,'login');
 assert.throws(()=>validateLoginQuestion({...page(login),readiness:{loading:true}},proof),/yükleniyor/);
 assert.throws(()=>validateLoginQuestion(page(login),{...proof,snapshotId:'old'}),/son snapshot/);
 assert.equal(validateLoginQuestion(page(login),{...proof,evidence:'Login is required here'}).kind,'login');
 assert.equal(validateLoginQuestion(page(login),{kind:'login',snapshotId:'current'}).kind,'login');
 assert.equal(validateLoginQuestion(page('Please sign in to continue'),{...proof,evidence:'Please sign in to continue'}).kind,'login');
 assert.equal(asksForLogin({text:'Bu tarayıcıda hesabınıza giriş yaptınız mı?'}),true);
 assert.equal(asksForLogin({text:'Devam etmek için giriş yapın.'}),true);
 assert.equal(asksForLogin({text:'Maaş beklentiniz nedir?'}),false);
 for(const text of ['Kullanıcı LinkedIn\'e giriş yapmış durumda; Easy Apply tıklaması gerçekleşmedi.','Oturum açık, giriş engeli yok; ilan kaldırılmış.','Giriş yapılmış, form yüklenmedi.'])assert.equal(asksForLogin({text}),false,text);
});

function fixture(t){
 const store=new WorkspaceDatabase(':memory:');t.after(()=>store.close());const db=new AutomationStore(store),a=db.create('job-search',{goal:'Prepare a form',criteria:{preferences:'Remote',ranking:'Remote fit, 0–100'},sources:['https://portal.test/jobs']});db.review(a.id);db.skipTrial(a.id);
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

test('finishing blocked on a login page makes the app ask the login question itself',async t=>{
 const f=fixture(t);await f.call('browser_open',{url:'https://portal.test/login'});
 await f.call('finish_automation_run',{status:'blocked',summary:'Başvuru formu giriş istiyor.'});
 const questions=f.db.get(f.id).questions;assert.equal(questions.length,1);
 const [question]=questions;assert.equal(question.text,'Başvuru formu giriş istiyor.');assert.equal(question.accessCheck.kind,'login');assert.equal(question.accessCheck.url,'https://portal.test/login');
 assert.equal(question.fields[0].id,'loggedIn');assert.equal(question.fields[0].type,'boolean');
});

test('finishing blocked on an ordinary page never adds a login question, whatever the summary says',async t=>{
 const f=fixture(t);f.setContent('Complete your profile\nNotifications\nSaved jobs\nEasy Apply');
 await f.call('browser_open',{url:'https://portal.test/login'});
 await f.call('finish_automation_run',{status:'blocked',summary:'Kullanıcı giriş yapmış durumda; Easy Apply tıklaması gerçekleşmedi.'});
 assert.equal((f.db.get(f.id).questions??[]).length,0);
});

test('a blocked public page with a navigation login and newsletter does not ask the user to log in',async t=>{
 const f=fixture(t);f.setContent('Login\nCareers\nApply now\nSubscribe to updates\nEmail');
 await f.call('browser_open',{url:'https://portal.test/jobs?id=42'});
 await f.call('finish_automation_run',{status:'blocked',summary:'Sonuç doğrulanamadı.'});
 assert.equal((f.db.get(f.id).questions??[]).length,0);
});

test('an existing open login question is reused when the run closes blocked',async t=>{
 const f=fixture(t),read=await f.call('browser_open',{url:'https://portal.test/login'});
 const asked=await f.call('ask_workspace_question',{text:'Hesabınıza giriş yapın.',accessCheck:{...proof,snapshotId:read.snapshot.id}});
 await f.call('finish_automation_run',{status:'blocked',summary:'Giriş gerekli.'});
 const questions=f.db.get(f.id).questions;assert.equal(questions.length,1);assert.equal(questions[0].id,asked.id);
});
