import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(tmpdir(),'jobloop-onboarding-'));
const app=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[process.cwd()],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('button',{name:'Başlayalım'}).click();
 await page.locator('#setup-cv').waitFor({state:'visible'});
 await page.screenshot({path:path.join(data,'intake.png')});
 const p=await page.evaluate(()=>window.jobloop.createSetup({provider:'codex',model:'default',permission:'default',reasoning:'default',network:null}));
 const store=new Store(path.join(data,'jobloop.sqlite'));store.saveSetup(p.id,{status:'running',stage:'preferences',needsTurn:false,message:'CV okundu. Çalışma tercihini netleştiriyoruz.'});store.updateSetupProfile(p.id,{stage:'preferences',message:'Deneyimlerin profil taslağına eklendi.',name:'Deniz Yılmaz',facts:'CV: 5 yıl backend deneyimi. Python, PostgreSQL. İngilizce C1.'});const q=store.ask(p.id,{question:'Hangi şehirde ve nasıl çalışmak istersin?'});
 await page.reload();await page.locator('#setup-questions textarea').waitFor({state:'visible'});
 await page.locator('#setup-questions textarea').fill('Berlin hibrit');
 await page.screenshot({path:path.join(data,'working.png')});
 // Simulate the agent's MCP profile write without launching an actual provider in this UI test.
 store.answer(p.id,q.id,'Berlin hibrit');store.updateSetupProfile(p.id,{stage:'review',message:'Profilin hazır.',preferences:'Berlin hibrit; backend; maaş esnek'});
 await page.reload();await page.locator('#setup-review input[name=name]').fill('Deniz');
 await page.locator('#setup-review select[name=authorization]').selectOption('prepare');
 await page.getByRole('button',{name:'Profilimi onayla'}).click();
 await page.locator('#setup-enter').waitFor({state:'visible'});await page.screenshot({path:path.join(data,'ready.png')});
 await page.locator('#setup-enter').click();await page.locator('#onboarding').waitFor({state:'hidden'});
 if(store.profile(p.id).name!=='Deniz'||store.profile(p.id).authorization!=='prepare'||store.setup(p.id).status!=='complete')throw Error('Approval was not saved');
 await page.reload();await page.locator('#onboarding').waitFor({state:'hidden'});
 store.close();if(errors.length)throw Error(errors.join('\n'));console.log('ONBOARDING_UI_PASS',data);
}finally{await app.close();}
