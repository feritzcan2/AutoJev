import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';

const require=createRequire(import.meta.url);
const {_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-duplicate-ui-'));
const store=new Store(path.join(data,'jobloop.sqlite'));
const profile=store.saveProfile({name:'Duplicate fixture',preferences:'Berlin',authorization:'research'});
for(const source of store.sources(profile.id))store.saveSource(profile.id,{...source,enabled:false});
const listing={company:'Fixture Employer',role:'Backend Engineer',location:'Berlin',fit:'Fixture vacancy',url:'https://www.linkedin.com/jobs/view/1234567890'};
const primary=store.addJob(profile.id,listing).job;
primary.status='submitted';primary.proof={kind:'success_page',text:'Fixture confirmation preserved',url:listing.url};store.saveJob(primary,'fixture');
const duplicate=store.addJob(profile.id,{...listing,role:'Backend Engineer (old title)',url:'https://fixture.jobs.personio.de/job/123',location:'Berlin, Germany'}).job;
store.linkJobUrl(profile.id,duplicate.id,{url:listing.url,evidence:'Fixture observed vacancy link'},'fixture');store.close();
let application;
try{
  application=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
  const page=await application.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('.jobs-table tbody tr').waitFor();
  assert.equal(await page.locator('.jobs-table tbody tr').count(),1);
  await page.getByText('Bağlı kayıtlar (1)',{exact:true}).click();
  await page.getByText('Fixture Employer — Backend Engineer (old title)',{exact:true}).waitFor();
  await page.getByText('Neden uygun',{exact:true}).click();
  await page.getByText('Fixture confirmation preserved',{exact:false}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS: one vacancy row, linked original record, saved proof, no renderer errors.');
}finally{await application?.close();await rm(data,{recursive:true,force:true});}
