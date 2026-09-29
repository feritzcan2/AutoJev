import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../app/store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-profile-improvement-'));
const store=new Store(path.join(data,'jobloop.sqlite'));store.db.exec('PRAGMA busy_timeout=5000');
const p=store.saveProfile({name:'Deniz Yılmaz',preferences:'Berlin hybrid',facts:'Backend engineer; English C1',authorization:'submit'});
const job=store.addJob(p.id,{company:'Example',role:'Engineer',location:'Berlin',fit:'Backend',url:'https://example.com/job'}).job;
const pending=store.ask(p.id,{jobId:job.id,question:'Başvuru için giriş yapabilir misin?'});
const sources=store.sources(p.id);
store.saveSetup(p.id,{status:'complete'});
store.saveCampaign(p.id,{status:'paused',target:100,intervalMinutes:30});
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error('PAGE_ERROR',error.message);});
 // Exercise the real IPC, scheduler and MCP. Only the provider process is simulated.
 await app.evaluate(async(_,engineUrl)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {Engine}=await load(engineUrl),request=Engine.prototype.request;
  globalThis.profileTestCalls=[];
  Engine.prototype.request=async function(op,args={}){
   if(op==='resize')return {};
   if(!['start','message'].includes(op))return request.call(this,op,args);
   if(op==='start')this.profileTestSession=args;
   const session=this.profileTestSession;
   const call=async(name,arguments_={})=>{
    const response=await fetch(session.endpoint,{method:'POST',headers:{authorization:`Bearer ${session.token}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arguments_}})});
    const result=(await response.json()).result;if(result.isError)throw Error(result.content[0].text);return JSON.parse(result.content[0].text);
   };
   const prompt=args.prompt??args.text;globalThis.profileTestCalls.push({op,prompt});
   this.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'state',sessionId:session.sessionId,state:'Working'})+'\n'));
   const context=await call('get_task_context');
   if(!prompt.includes('profile improvement'))throw Error('Wrong task prompt');
   if(op==='start'||prompt.includes('just opened'))await call('ask_candidate',{question:'Profilinde neleri geliştirmek istersin?'});
   else{
    const answer=context.questions.find(q=>q.answer!==null&&!context.setup.excludedQuestionIds.includes(q.id));
    await call('update_setup_profile',{stage:'review',message:'Tercihlerin güncellendi.',preferences:answer.answer});
   }
   this.child.stdout.emit('data',Buffer.from(JSON.stringify({event:'state',sessionId:session.sessionId,state:'Idle'})+'\n'));
   return {};
  };
 },pathToFileURL(path.resolve('app/engine.mjs')).href);
 await page.waitForFunction(id=>document.querySelector('#candidates').value===id,p.id);
 await page.locator('button[data-view=profile]').click();
 await page.locator('#profile-form input[name=name]').fill('Deniz');
 await page.screenshot({path:path.join(data,'profile.png'),fullPage:true});
 // Seed a running campaign immediately before the click; improvement must pause it.
 store.saveCampaign(p.id,{...store.campaign(p.id),status:'running',wakeAt:Date.now()+600000});
 await page.locator('#improve-profile').click();
 await page.locator('#setup-questions textarea').waitFor({state:'visible'});
 assert.equal(store.profile(p.id).name,'Deniz','unsaved profile edits must reach the agent');
 assert.equal(store.campaign(p.id).status,'paused');
 assert.equal(await page.locator('#setup-console').getAttribute('open'),'');
 assert.ok(!(await page.locator('#setup-questions').innerText()).includes(pending.question));
 await page.screenshot({path:path.join(data,'conversation.png'),fullPage:true});
 await page.reload();await page.locator('#setup-questions textarea').fill('Almanya uzaktan backend rolleri');
 await page.locator('#setup-questions button[type=submit]').click();
 await page.locator('#setup-review').waitFor({state:'visible'});
 assert.equal(await page.locator('#setup-review input[name=authorization]:checked').inputValue(),'submit');
 assert.equal(await page.locator('#setup-review textarea[name=preferences]').inputValue(),'Almanya uzaktan backend rolleri');
 await page.locator('#setup-review textarea[name=facts]').fill('Backend engineer; English C1; Python');
 await page.locator('#setup-improve-continue').click();
 await page.locator('#setup-questions textarea').waitFor({state:'visible'});
 assert.equal(store.profile(p.id).facts,'Backend engineer; English C1; Python');
 await page.locator('#setup-questions textarea').fill('Berlin veya Almanya uzaktan senior backend');
 await page.locator('#setup-questions button[type=submit]').click();
 await page.locator('#setup-review').waitFor({state:'visible'});
 await page.screenshot({path:path.join(data,'review.png'),fullPage:true});
 await page.getByRole('button',{name:'Değişiklikleri kaydet',exact:true}).click();
 await page.locator('#onboarding').waitFor({state:'hidden'});
 assert.equal(store.setup(p.id).status,'complete');assert.equal(store.profile(p.id).authorization,'submit');
 assert.equal(await page.locator('#profile-form textarea[name=preferences]').inputValue(),'Berlin veya Almanya uzaktan senior backend');
 assert.equal(store.campaign(p.id).status,'paused');assert.deepEqual(store.sources(p.id),sources);
 await page.locator('#improve-profile').click();await page.locator('#setup-questions textarea').waitFor({state:'visible'});
 await page.locator('#setup-back').click();await page.locator('#onboarding').waitFor({state:'hidden'});
 assert.equal(store.questions(p.id).filter(q=>q.answer===null).length,1);assert.equal(store.questions(p.id).find(q=>q.id===pending.id).answer,null);
 assert.equal((await page.evaluate(id=>window.jobloop.workspaceSnapshot(id),p.id)).active,null);
 await page.reload();await page.locator('#onboarding').waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);console.log('PROFILE_IMPROVEMENT_UI_PASS',data);
}catch(error){const page=await app.firstWindow();console.error(await page.locator('body').innerText());await page.screenshot({path:path.join(data,'failure.png'),fullPage:true});throw error;}finally{await app.close();store.close();}
