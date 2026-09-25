import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
import {mkdtemp,writeFile} from 'node:fs/promises';
import {Store} from '../app/store.mjs';
const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-agent-test-'));
await writeFile(data+'/cv.txt','Synthetic candidate for a local integration test. No job applications authorized.');
const store=new Store(data+'/jobloop.sqlite');const p=store.saveProfile({name:'Integration test',preferences:'This is an integration test. Do not browse or apply. Read profile, ask_candidate with JOBLOOP_ENGINE_CONNECTED, then wait for a user answer. When the answer is ACK_TEST, ask_candidate with JOBLOOP_REPLY_RECEIVED and finish.',facts:'No job search authorized. Only a local MCP question test.',authorization:'research'});store.setCv(p.id,data+'/cv.txt');store.close();
const app=await electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{const page=await app.firstWindow();page.on('pageerror',e=>console.log('PAGE_ERROR',e.message));await page.getByRole('button',{name:'Agent’ı başlat'}).click();console.log('CLICKED',data);await page.waitForTimeout(12000);await page.screenshot({path:path.join(data,'agent.png'),fullPage:true});console.log('STATE',await page.locator('#agent-state').innerText());await page.locator('#terminal').click();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#questions').textContent.includes('JOBLOOP_ENGINE_CONNECTED'),{},{timeout:45000});console.log('FULL_AGENT_MCP_PASS');await page.locator('#questions input').first().fill('ACK_TEST');await page.locator('#questions button').first().click();await page.waitForFunction(()=>document.querySelector('#questions').textContent.includes('JOBLOOP_REPLY_RECEIVED'),{},{timeout:60000});console.log('USER_REPLY_AGENT_PASS');}finally{await app.close();}
