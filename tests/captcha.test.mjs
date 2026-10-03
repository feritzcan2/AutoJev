import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {CapsolverClient} from '../app/capsolver-client.mjs';
import {CaptchaSettings} from '../app/captcha-settings.mjs';
import {CaptchaCoordinator} from '../app/captcha-coordinator.mjs';
import {captchaProvider,classifyCaptcha,detectCaptcha} from '../app/captcha-detection.mjs';
import {BrowserTools} from '../app/browser.mjs';

const active={provider:'recaptcha',part:'challenge',visible:true,grid:true,instructions:'Select bicycles',loaded:true,identity:'document:widget',round:'image:one'};
const json=value=>new Response(JSON.stringify(value));
function settings(t,options={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 return new CaptchaSettings(db,{encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString(),...options});
}
test('only a visible provider challenge with actual instructions/grid is paid evidence',()=>{
 const idle={provider:'recaptcha',part:'anchor',visible:true,unchecked:true,loaded:true};
 assert.equal(classifyCaptcha({frames:[idle]}).state,'idle');
 assert.equal(classifyCaptcha({frames:[{...idle,invisible:true}]}).state,'none');
 assert.equal(classifyCaptcha({frames:[{...active,visible:false}]}).state,'none');
 assert.equal(classifyCaptcha({frames:[{...idle,checked:true},active]}).state,'active');
 assert.equal(classifyCaptcha({frames:[{...idle,checked:true}]}).state,'cleared');
 assert.equal(classifyCaptcha({frames:[idle],staleError:true}).state,'error');
 assert.equal(classifyCaptcha({frames:[{provider:'turnstile',part:'widget',visible:true,loaded:true,token:false}]}).state,'unknown');
 assert.equal(classifyCaptcha({frames:[{...idle,provider:'turnstile',instructions:'Verify'}]}).state,'active');
 assert.equal(classifyCaptcha({frames:[active,{...active,identity:'other'}]}).state,'unsupported');
});
test('unreadable or late frames never count as absent or solved',()=>{
 for(const input of [{pendingHosts:true},{frames:[{...active,grid:false,loaded:false}]},{frames:[{...active,grid:false,unavailable:true,loaded:false}]},{frames:[{provider:'recaptcha',part:'anchor',visible:true,loading:true}]}])assert.ok(['unknown','checking'].includes(classifyCaptcha(input).state));
 assert.equal(classifyCaptcha({frames:[{...active,grid:false,audio:true}]}).state,'unsupported');
 assert.equal(classifyCaptcha({frames:[{...active,blocked:true}]}).state,'unsupported');
 assert.equal(classifyCaptcha({frames:[{...active,audio:true}]}).state,'unsupported');
 for(const url of ['https://evil.test/recaptcha/api2/bframe','https://google.com.evil.test/recaptcha/api2/bframe','https://evil.test/?x=https://www.google.com/recaptcha/api2/bframe','http://www.google.com/recaptcha/api2/bframe'])assert.equal(captchaProvider(url),null);
 assert.equal(captchaProvider('https://www.recaptcha.net/recaptcha/enterprise/anchor?k=x&size=invisible').enterprise,true);
 assert.equal(captchaProvider('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/x').provider,'turnstile');
});
test('a never-answering page has a bounded unknown result and one outstanding read',async()=>{
 let calls=0;const page={evaluate:()=>{calls++;return new Promise(()=>{});}};
 const results=await Promise.all([detectCaptcha(page,{timeoutMs:5}),detectCaptcha(page,{timeoutMs:5})]);
 assert.ok(results.every(r=>r.state==='unknown'));assert.equal(calls,1);
 assert.equal((await detectCaptcha(page,{timeoutMs:5})).state,'unknown');assert.equal(calls,1);
});
test('REST supports synchronous images and async tasks without retrying createTask',async()=>{
 const calls=[],responses=[{errorId:0,taskId:'synthetic-task',status:'idle'},{errorId:0,status:'processing'},{errorId:0,status:'ready',solution:{token:'t'.repeat(30)}}];
 const client=new CapsolverClient({pollMs:1,fetchImpl:async(url,input)=>{calls.push({url,input});return json(responses.shift());}});
 assert.equal((await client.solve('synthetic-key',{type:'AntiTurnstileTaskProxyLess'})).token.length,30);
 assert.deepEqual(calls.map(c=>c.url.split('/').at(-1)),['createTask','getTaskResult','getTaskResult']);
 assert.ok(calls.every(c=>c.input.redirect==='error'&&c.input.signal instanceof AbortSignal));
 client.fetchImpl=async()=>json({errorId:0,status:'ready',solution:{text:'123'}});assert.equal((await client.solve('synthetic-key',{type:'ImageToTextTask'})).text,'123');
});
test('provider errors, malformed responses and network failures do not echo secrets',async()=>{
 const cases=[()=>json({errorId:1,errorCode:'ERROR_ZERO_BALANCE',errorDescription:'synthetic-secret'}),()=>new Response('synthetic-secret'),()=>new Response('synthetic-secret',{status:500}),()=>{throw Error('synthetic-secret');},()=>new Response('x'.repeat(262145))];
 for(const response of cases){const client=new CapsolverClient({fetchImpl:async()=>response()});await assert.rejects(()=>client.balance('synthetic-secret'),e=>!e.message.includes('synthetic-secret'));}
});
test('polling is cancelled and no additional request is made',async()=>{
 let calls=0;const abort=new AbortController(),client=new CapsolverClient({pollMs:1000,fetchImpl:async()=>{calls++;return json({errorId:0,status:'processing',taskId:'x'});}});
 const pending=client.solve('synthetic-key',{}, {signal:abort.signal});await delay(2);abort.abort();await assert.rejects(pending);assert.equal(calls,1);
});
test('encrypted settings retain key and daily usage across settings instances and stop at limit',t=>{
 const s=settings(t,{now:()=>Date.parse('2026-10-03T23:59:00Z')});s.save({apiKey:'synthetic-key',enabled:true,dailyLimit:2});
 assert.doesNotMatch(JSON.stringify(s.status()),/synthetic-key|ciphertext|apiKey/);assert.notEqual(s.row().ciphertext,'synthetic-key');
 s.reserve();s.save({apiKey:'',dailyLimit:2});s.reserve();assert.throws(()=>s.reserve(),/sınırına/);
 const restored=new CaptchaSettings(s.db,{encrypt:s.encrypt,decrypt:s.decrypt,now:s.now});assert.equal(restored.used(),2);assert.throws(()=>restored.reserve(),/sınırına/);
 s.now=()=>Date.parse('2026-10-04T00:00:00Z');s.reserve();assert.equal(s.used(),1);
 s.remove();assert.equal(s.used(),1);assert.equal(s.status().enabled,false);
});
test('settings validation/encryption failure preserve prior value and revision invalidates checks',async t=>{
 const s=settings(t);s.save({apiKey:'synthetic-key',enabled:true});const old=s.changes.signal;
 for(const input of [{apiKey:'bad'},{dailyLimit:0},{dailyLimit:1.5},{enabled:'true'},{endpoint:'https://evil.test'}])assert.throws(()=>s.save(input));
 s.encrypt=()=>{throw Error('Keychain unavailable');};assert.throws(()=>s.save({apiKey:'another-key'}));assert.equal(s.config().apiKey,'synthetic-key');
 s.save({enabled:false});assert.equal(old.aborted,true);
 s.decrypt=()=>{throw Error('secret failure');};assert.doesNotMatch(JSON.stringify(s.status()),/secret failure/);
});
function context(options={}){return {owner:'worker-a',observe:async()=>({state:'active',target:{...active}}),capture:async()=>({kind:'token',task:{type:'test'}}),apply:async()=>({state:'answer_applied'}),verify:async()=>{},...options};}
test('concurrent observations and repeated unchanged challenges create only one paid task',async t=>{
 let calls=0;const s=settings(t,{client:{solve:async()=>{calls++;await delay(5);return {token:'x'};}}});s.save({apiKey:'synthetic-key',enabled:true});
 const c=new CaptchaCoordinator(s,{settleMs:1}),slot={};
 const results=await Promise.all(Array.from({length:5},()=>c.run(slot,context())));assert.equal(calls,1);assert.equal(results[0].state,'answer_applied');
 await c.run(slot,context());assert.equal(calls,1);assert.equal(s.used(),1);
});
test('unknown, idle, changing and unauthorized challenges never reach the paid service',async t=>{
 const s=settings(t,{client:{solve:async()=>{throw Error('must not call');}}});s.save({apiKey:'synthetic-key',enabled:true});const c=new CaptchaCoordinator(s,{settleMs:1});
 for(const state of ['idle','none','unknown','unsupported'])await c.run({},context({observe:async()=>({state})}));
 let read=0;await c.run({},context({observe:async()=>({state:'active',target:{...active,round:String(read++)}})}));
 assert.equal((await c.run({},context({allowed:()=>false}))).state,'handoff');assert.equal(s.used(),0);
});
test('abort or settings changes while a solver runs prevent application',async t=>{
 for(const kind of ['stop','settings']){
  let started,release,applies=0;const begun=new Promise(r=>started=r),response=new Promise(r=>release=r);
  const s=settings(t,{client:{solve:async()=>{started();return response;}}});s.save({apiKey:'synthetic-key',enabled:true});
  const c=new CaptchaCoordinator(s,{settleMs:1}),abort=new AbortController();
  const pending=c.run({},context({signal:abort.signal,apply:async()=>{applies++;return {state:'cleared'};}}));await begun;
  if(kind==='stop')abort.abort();else s.save({enabled:false});release({token:'x'});
  assert.equal((await pending).state,'handoff');assert.equal(applies,0);
 }
});
test('API wait is outside the workspace queue: another worker can read',async t=>{
 let release,started;const begun=new Promise(r=>started=r),response=new Promise(r=>release=r);
 const s=settings(t,{client:{solve:async()=>{started();return response;}}});s.save({apiKey:'synthetic-key',enabled:true});
 const browser=new BrowserTools('/unused'),c=new CaptchaCoordinator(s,{settleMs:1}),ctx=context();
 for(const key of ['observe','capture','apply','verify']){const fn=ctx[key];ctx[key]=(...args)=>browser.enqueue('workspace',()=>fn(...args));}
 const pending=c.run({},ctx);await begun;let read=false;await browser.enqueue('workspace',async()=>{read=true;});assert.equal(read,true);
 release({token:'x'});await pending;
});
test('settings cancellation during browser application is checked before the mutation',async t=>{
 let mutations=0;const s=settings(t,{client:{solve:async()=>({token:'x'})}});s.save({apiKey:'synthetic-key',enabled:true});
 const c=new CaptchaCoordinator(s,{settleMs:1});
 const result=await c.run({},context({apply:async(_target,_capture,_solution,check)=>{await delay(1);s.save({enabled:false});check();mutations++;return {state:'cleared'};}}));
 assert.equal(result.state,'handoff');assert.equal(mutations,0);
});

test('an inconclusive detection without any provider frame never starts the solver loop',async()=>{
 const {resolveBrowserCaptcha}=await import('../app/captcha-automation.mjs');
 let runs=0;
 const slot={id:'tab1',owner:'session',captchaDetection:{state:'unknown',reason:'timed out',frames:[]},page:{url:()=>'https://board.test/job/1',isClosed:()=>false,on(){},off(){}}};
 const browser={captcha:{run(){runs++;return Promise.resolve(null);}},clients:new Map([['ws',{client:{tabs:new Map([['tab1',slot]]),abort:new AbortController(),tabJobs:new Map(),automationTabs:new Map()}}]])};
 const result={content:[{type:'text',text:JSON.stringify({tabId:'tab1',url:'https://board.test/job/1'})}]};
 assert.equal(await resolveBrowserCaptcha(browser,'ws',result,'session',{}),result);
 assert.equal(runs,0,'no challenge evidence, no bounded re-observation');
 slot.captchaDetection={state:'checking',frames:[{provider:'recaptcha',visible:true}]};
 await resolveBrowserCaptcha(browser,'ws',result,'session',{});
 assert.equal(runs,1,'a provider frame still loading is evidence worth a bounded check');
});
