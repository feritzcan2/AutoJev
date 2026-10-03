import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NotificationFixture} from '../tests/helpers/notifications.mjs';
import {TelegramStore} from '../app/telegram-store.mjs';

const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const data=await mkdtemp(path.join(os.tmpdir(),'telegram-score-ui-')),file=path.join(data,'jobloop.sqlite'),store=new NotificationFixture(file);
const p=store.createWorkspace({name:'Ada · Telegram puan testi',preferences:'Synthetic test'}),other=store.createWorkspace({name:'Grace',preferences:'Synthetic test'});
const jobs=new Map();
for(const [name,score] of [['Silinen ilan',85],['Yeni ilan',71],['Tamamlanan başvuru',90],['Sınırdaki ilan',70],['Düşük puan',30],['Puanlanmamış',null]]){
 const job=store.addRecord(p.id,{url:'https://example.test/jobs/'+jobs.size,company:name,role:'Engineer',location:'Remote'}).job;jobs.set(name,job);
 if(score!==null)store.scoreRecord(p.id,job.id,score);
}
store.setRecordState(p.id,jobs.get('Tamamlanan başvuru').id,'completed');
const foreign=store.addRecord(other.id,{url:'https://example.test/foreign',company:'Foreign',role:'Engineer',location:'Remote'}).job;store.scoreRecord(other.id,foreign.id,99);
for(const candidate of [p,other])for(const job of store.jobs(candidate.id))store.saveRecord({...job,updatedAt:job.createdAt});
const originalRecords=store.jobs(p.id);store.close();
const env={...process.env,JOBLOOP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:require('electron'),args:[process.cwd()],env});
try{
 const page=await app.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000);
 const waitForStatus=async(predicate)=>{
  const deadline=Date.now()+30000;let status;
  do{status=(await page.evaluate(id=>window.jobloop.telegramStatus(id),p.id)).candidate;if(predicate(status))return;await page.waitForTimeout(200);}while(Date.now()<deadline);
  assert.fail('Telegram status did not settle: '+JSON.stringify(status));
 };
 // The real IPC/service/queue runs against synthetic data. No Telegram request
 // can leave this process, even if a test accidentally supplies another token.
 await app.evaluate(()=>{
  globalThis.telegramTestCalls=[];let messageId=100;
  globalThis.fetch=async(url,options={})=>{
   if(!String(url).startsWith('https://api.telegram.org/'))throw Error('Network disabled in Telegram UI test');
   const method=String(url).split('/').at(-1),body=JSON.parse(options.body||'{}');globalThis.telegramTestCalls.push({method,body});
   let result;
   if(method==='getUpdates')await new Promise(resolve=>options.signal.aborted?resolve():options.signal.addEventListener('abort',resolve,{once:true}));
   else if(method==='getMe')result={id:123456789,username:'synthetic_telegram_bot',is_bot:true};
   else if(method==='getWebhookInfo')result={url:''};
   else if(method==='sendMessage')result={message_id:++messageId};
   else if(['editMessageText','pinChatMessage','unpinChatMessage'].includes(method))result=true;
   else throw Error('Unexpected Telegram test method '+method);
   return new Response(JSON.stringify({ok:true,result:result??[]}),{headers:{'Content-Type':'application/json'}});
  };
 });
 await page.waitForFunction(()=>Boolean(window.jobloop));
 const token='123456789:synthetic_abcdefghijklmnopqrstuvwxyz';
 for(const [candidate,chat] of [[p,11],[other,22]]){
  await page.evaluate(({id,token})=>window.jobloop.telegramConfigure(id,{token,enabled:true}),{id:candidate.id,token});
  const pair=await page.evaluate(id=>window.jobloop.telegramPair(id),candidate.id),fixture=new NotificationFixture(file),telegram=new TelegramStore(fixture,Date.now,123456789);
  assert.ok(telegram.bind(new URL(pair.url).searchParams.get('start'),chat,chat,candidate.id===p.id?'Ada':'Grace'));
  if(candidate.id===p.id){const job=jobs.get('Silinen ilan'),row=telegram.enqueue(p.id,'new-job:'+job.id,{kind:'new_job',jobId:job.id});telegram.sent(row.id,42,123456789);telegram.deleted(row.id);}
  fixture.close();
  await page.evaluate(id=>window.jobloop.telegramPreferences(id,{newJobs:false,notifications:false,questions:false}),candidate.id);
 }
 await page.waitForFunction(id=>[...document.querySelector('#candidates').options].some(option=>option.value===id),p.id);
 await page.locator('#candidates').selectOption(p.id);await page.locator('aside nav [data-view=notifications]').click();
 const batch=page.locator('.telegram-batch');await batch.waitFor({state:'visible'});
 await batch.getByRole('spinbutton',{name:'Minimum puan'}).fill('70');await batch.getByLabel('Gönderim kapsamı').selectOption('resend');
 assert.match(await batch.textContent(),/70 → 71–100/);assert.match(await batch.textContent(),/tamamlanmış başvurular/);
 // Periodic refresh must not reset partially edited fields.
 await page.waitForTimeout(5200);assert.equal(await batch.getByLabel('Gönderim kapsamı').inputValue(),'resend');
 assert.equal((await app.evaluate(()=>globalThis.telegramTestCalls.filter(c=>c.method==='sendMessage'))).length,0);
 await page.locator('#notifications').screenshot({path:path.join(data,'telegram-resend.png')});
 await batch.getByRole('button',{name:'İlanları yeniden gönder',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-deliveries]')?.textContent.startsWith('0 mesaj'),null,{timeout:30000});
 // Read real sent receipts instead of accepting a transient zero in the UI.
 let messages=[];
 for(let i=0;i<60;i++){messages=await app.evaluate(()=>globalThis.telegramTestCalls.filter(c=>c.method==='sendMessage'));if(messages.length>=3)break;await page.waitForTimeout(300);}
 assert.equal(messages.length,3);assert.ok(messages.every(c=>c.body.chat_id==='11'));
 assert.deepEqual(new Set(messages.map(c=>c.body.reply_markup.inline_keyboard[0][0].url)),new Set(['Silinen ilan','Yeni ilan','Tamamlanan başvuru'].map(name=>jobs.get(name).url)));
 const completedCard=messages.find(c=>c.body.reply_markup.inline_keyboard[0][0].url===jobs.get('Tamamlanan başvuru').url).body;
 assert.match(completedCard.text,/İş arama · Başvuruldu/);assert.equal(completedCard.reply_markup.inline_keyboard.at(-1)[0].text,'🗑 Mesajı sil');
 const pendingCard=messages.find(c=>c.body.reply_markup.inline_keyboard[0][0].url===jobs.get('Yeni ilan').url).body;
 assert.equal(pendingCard.reply_markup.inline_keyboard.at(-1)[0].text,'🗑 Sil · Kaydı ele');
 const verify=new NotificationFixture(file);try{assert.deepEqual(verify.jobs(p.id),originalRecords);}finally{verify.close();}
 const automaticScore=page.getByRole('spinbutton',{name:'Otomatik ilanlar için minimum puan',exact:true});
 await automaticScore.fill('65');await automaticScore.press('Tab');
 await waitForStatus(c=>c.newJobsMinScore===65);
 await page.getByRole('checkbox',{name:'Yeni ilanları otomatik gönder',exact:true}).check();
 await waitForStatus(c=>c.newJobs);
 const automaticFixture=new NotificationFixture(file),automatic=[];
 try{
  for(const [name,score] of [['Automatic high',66],['Automatic boundary',65],['Automatic unscored',null]]){
   let job=automaticFixture.addRecord(p.id,{url:'https://example.test/automatic/'+automatic.length,company:name,role:'Engineer',location:'Remote'}).job;
   if(score!==null)job=automaticFixture.scoreRecord(p.id,job.id,score);
   automaticFixture.saveRecord({...job,updatedAt:job.createdAt});automatic.push(job);
  }
 }finally{automaticFixture.close();}
 await waitForStatus(c=>c.waitingScore===2&&c.pending===0);
 messages=await app.evaluate(()=>globalThis.telegramTestCalls.filter(c=>c.method==='sendMessage'));
 assert.equal(messages.length,4);assert.equal(messages.at(-1).body.reply_markup.inline_keyboard[0][0].url,automatic[0].url);
 // An in-progress edit survives polling and is saved only on change/blur.
 await automaticScore.fill('60');await page.waitForTimeout(5200);assert.equal(await automaticScore.inputValue(),'60');
 assert.equal((await page.evaluate(id=>window.jobloop.telegramStatus(id),p.id)).candidate.newJobsMinScore,65);
 await automaticScore.fill('65');await automaticScore.press('Tab');
 const rankingFixture=new NotificationFixture(file);try{rankingFixture.scoreRecord(p.id,automatic[1].id,66);}finally{rankingFixture.close();}
 await waitForStatus(c=>c.waitingScore===1&&c.pending===0);
 messages=await app.evaluate(()=>globalThis.telegramTestCalls.filter(c=>c.method==='sendMessage'));assert.equal(messages.length,5);
 assert.equal(messages.at(-1).body.reply_markup.inline_keyboard[0][0].url,automatic[1].url);
 assert.equal(await batch.getByLabel('Minimum puan',{exact:true}).inputValue(),'70');
 await page.waitForFunction(()=>document.querySelector('[data-deliveries]')?.textContent.includes('1 ilan puan sınırını geçmeyi bekliyor'));
 await page.locator('#notifications').screenshot({path:path.join(data,'telegram-automatic-score.png')});
 await page.locator('#candidates').selectOption(other.id);
 await page.waitForFunction(()=>document.querySelector('[data-candidate-state]')?.textContent!=='Ada hesabı bağlı.');
 await page.locator('aside nav [data-view=notifications]').click();await page.waitForFunction(()=>document.querySelector('[data-candidate-state]')?.textContent==='Grace hesabı bağlı.');
 assert.equal(await batch.getByLabel('Gönderim kapsamı').inputValue(),'unsent');assert.equal(await batch.getByLabel('Minimum puan').inputValue(),'70');
 assert.equal(await automaticScore.inputValue(),'');
 await page.locator('#candidates').selectOption(p.id);await page.waitForFunction(()=>document.querySelector('[data-candidate-state]')?.textContent!=='Grace hesabı bağlı.');
 await page.locator('aside nav [data-view=notifications]').click();await page.waitForFunction(()=>document.querySelector('[name=newJobsMinScore]')?.value==='65');
 assert.deepEqual(errors,[]);console.log('TELEGRAM_SCORE_UI_PASS',path.join(data,'telegram-automatic-score.png'));
 // Visual preview of actual sendMessage payloads, using only synthetic records.
 await page.setContent('<html lang="tr"><style>body{margin:0;background:#202b38;color:#fff;font:18px system-ui}main{display:flex;gap:24px;padding:32px}article{width:360px}section{background:#314355;padding:20px;border-radius:12px;line-height:1.6}button{width:100%;margin-top:5px;padding:14px;border:0;border-radius:7px;background:#1478ac;color:white;font:inherit}button[data-style=danger]{background:#aa3d3d}h1{font-size:18px;color:#c7d6e5}</style><main></main></html>');
 await page.evaluate(cards=>{
  for(const [title,body] of cards){
   const article=document.createElement('article'),heading=document.createElement('h1'),message=document.createElement('section');heading.textContent=title;message.innerHTML=body.text.replaceAll('\n','<br>');article.append(heading,message);
   for(const row of body.reply_markup.inline_keyboard)for(const button of row){const element=document.createElement('button');element.textContent=button.text;element.dataset.style=button.style??'';article.append(element);}
   document.querySelector('main').append(article);
  }
 },[['Başvurusu tamamlanan kayıt',completedCard],['Başvurusu yapılmamış kayıt',pendingCard]]);
 await page.locator('main').screenshot({path:path.join(data,'telegram-cards.png')});console.log('TELEGRAM_CARDS_UI_PASS',path.join(data,'telegram-cards.png'));
}catch(error){
 const page=await app.firstWindow();await page.screenshot({path:path.join(data,'failure.png'),fullPage:true});
 console.error('TELEGRAM_UI_FAILURE',data,await page.evaluate(()=>({selected:document.querySelector('#candidates')?.value,state:document.querySelector('[data-candidate-state]')?.textContent,notice:document.querySelector('#notice')?.textContent,notificationsHidden:document.querySelector('#notifications')?.hidden})));
 throw error;
}finally{await app.close();}
