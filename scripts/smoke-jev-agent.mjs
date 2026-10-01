// Uses the actual Jobloop app, shared workspace scheduler, configured Codex agent and Jev MCP.
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {startJevFixture,seedJevDemo} from './jev-demo.mjs';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {listChromeProfiles} from '../app/chrome-profiles.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const linkedin=process.argv.includes('--linkedin');
const root=fileURLToPath(new URL('../',import.meta.url)),fixture=linkedin?{url:'https://www.linkedin.com/jobs/',close:async()=>{}}:await startJevFixture(),data=await mkdtemp(path.join(os.tmpdir(),'jobloop-jev-agent-'));
const selected=process.argv.find(arg=>arg.startsWith('--profile='))?.slice(10);
const chromeProfile=selected?(await listChromeProfiles()).find(profile=>profile.directory===selected):undefined;
if(selected&&!chromeProfile)throw Error('Chrome profile not found');
const settingsFrom=process.argv.find(arg=>arg.startsWith('--settings-from='))?.slice(16);
let agentSettings;
if(settingsFrom){const previous=new WorkspaceDatabase(path.join(settingsFrom,'jobloop.sqlite'));try{agentSettings=previous.workspaces.get(previous.workspaces.list()[0].id).agentSettings;}finally{previous.close();}}
const {candidateId,sourceId}=await seedJevDemo(data,fixture.url,{linkedin,chromeProfile,agentSettings});
let app;
try{
  app=await electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
  const page=await app.firstWindow();
  await page.evaluate(()=>{window.jevTestEvents=[];window.jobloop.onAgentEvent(event=>window.jevTestEvents.push(event));});
  await page.evaluate(id=>window.jobloop.workspaceStart(id),candidateId);
  console.log('JEV_AGENT_STARTED',data);
  const store=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(store);
  try{
    const deadline=Date.now()+(linkedin?360000:180000);
    while(true){
      const current=db.sources(candidateId).find(source=>source.url===sourceId);
      if(current.lastRunAt&&(linkedin||/Atlas/i.test(current.lastResult)&&/Northstar/i.test(current.lastResult)))break;
      if(Date.now()>deadline)throw Error('Agent demo timed out');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    const source=db.sources(candidateId).find(source=>source.url===sourceId);
    if(source.resumeContext?.browser!=='Jev Chrome'||!source.resumeContext.tabId)throw Error('Agent did not save its real Jev tab');
    console.log(linkedin?'JEV_LINKEDIN_RUN_REPORTED':'JEV_EXISTING_JOBLOOP_AGENT_PASS',source.lastResult);
    if(linkedin)console.log('OBSERVED_JOBS',JSON.stringify(db.results(candidateId).map(({role,company,location,url})=>({role,company,location,url}))));
  }finally{store.close();}
  await page.screenshot({path:path.join(data,'jev-agent.png'),fullPage:true});
  if(process.argv.includes('--keep-open')){console.log('Demo açık bırakıldı:',data);await new Promise(resolve=>app.once('close',resolve));}
}catch(error){
  if(app){const page=await app.firstWindow();console.log('AGENT_DIAGNOSTIC',await page.evaluate(()=>window.jevTestEvents?.filter(e=>['error','diagnostic','state','delivery','engine_exit'].includes(e.event)).slice(-15)));
    console.log('TERMINAL',await page.locator('#terminal').innerText());
    const store=new WorkspaceDatabase(path.join(data,'jobloop.sqlite')),db=new AutomationStore(store);try{console.log('CAMPAIGN',JSON.stringify(db.get(candidateId)));}finally{store.close();}}
  throw error;
}finally{if(app)await app.close().catch(()=>{});await fixture.close();}
