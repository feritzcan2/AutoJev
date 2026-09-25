import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-setup-agent-'));
const store=new Store(path.join(data,'jobloop.sqlite'));
const candidate=store.createSetup({provider:process.env.JOBLOOP_TEST_PROVIDER||'codex',model:process.env.JOBLOOP_TEST_PROVIDER==='claude'?'sonnet':'gpt-5.6-sol',permission:'bypassPermissions',reasoning:'low',network:null});
const dir=path.join(data,'candidates',candidate.id);await mkdir(dir,{recursive:true});const cv=path.join(dir,'CV.txt');await writeFile(cv,'Synthetic integration test candidate: Deniz Test. Backend Engineer, Example Company, 2021–2026. Python, PostgreSQL, REST APIs. Lives in Berlin. Wants backend roles, Berlin hybrid or Germany remote. Salary expectation EUR 80,000 gross annually. Permanent German residence; no sponsorship needed. Can start immediately. English C1, German B1. Turkish communication preferred. Use the same CV; cover letters in plain B1 German. No real applications are authorized. These are all candidate-supplied facts.');store.setCv(candidate.id,cv);store.close();
let app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{const page=await app.firstWindow();await page.evaluate(id=>window.jobloop.beginSetup(id),candidate.id);await page.locator('#setup-console summary').click();await page.waitForTimeout(2500);await page.evaluate(()=>window.jobloop.input('\r'));
 await page.locator('#setup-review').waitFor({state:'visible',timeout:120000});
 const profile=await page.evaluate(id=>window.jobloop.snapshot(id),candidate.id);
 if(profile.profile.name==='Yeni aday'||profile.profile.authorization!=='research'||profile.campaign)throw Error('Invalid setup isolation');
 await app.close();app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});const resumed=await app.firstWindow();await resumed.locator('#setup-review').waitFor({state:'visible'});
 console.log('LIVE_SETUP_AGENT_AND_RESTART_PASS',data,profile.profile.name);
}finally{await app.close();}
