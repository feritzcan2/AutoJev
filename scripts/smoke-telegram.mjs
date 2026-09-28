import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Store} from '../app/store.mjs';
import {rankInput} from '../tests/rank-fixture.mjs';
const require=createRequire(import.meta.url),{_electron:electron}=createRequire(require.resolve('@playwright/mcp/package.json'))('playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),data=await mkdtemp(path.join(os.tmpdir(),'jobloop-telegram-ui-'));
const seed=new Store(path.join(data,'jobloop.sqlite')),candidate=seed.saveProfile({name:'Ada Lovelace',preferences:'Remote'}),other=seed.saveProfile({name:'Grace Hopper',preferences:'Hybrid'});
const previous=seed.addJob(candidate.id,{url:'https://example.com/previous',company:'Previous',role:'Engineer',location:'Remote',fit:'Test listing'}).job;
const completed=seed.addJob(candidate.id,{url:'https://example.com/completed',company:'Completed',role:'Engineer',location:'Remote',fit:'Test listing'}).job;
seed.setManualJobStatus(candidate.id,completed.id,'manual_submitted');seed.close();
const legacyPairing=path.join(data,'mobile.json');
await writeFile(legacyPairing,JSON.stringify({enabled:true,token:'retired-pairing-fixture',port:0}));
const application=await electron.launch({executablePath:process.env.JOBLOOP_ELECTRON_BINARY||require('electron'),args:[root],env:{...process.env,JOBLOOP_DATA_DIR:data}});
try{
 const page=await application.firstWindow(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await assert.rejects(access(legacyPairing),{code:'ENOENT'});
 assert.equal(await page.evaluate(()=>['mobileStatus','mobileEnable','mobileRotate'].some(key=>key in window.jobloop)),false);
 // A removed settings tab falls back to the notification settings shortcut.
 await page.evaluate(()=>localStorage.setItem('jobloop-config-tab','phone'));await page.reload();
 await page.locator('button[data-view=config]').click();await page.locator('#config-telegram').waitFor({state:'visible'});
 assert.equal(await page.locator('#config-phone, a[href="#config-phone"]').count(),0);
 await page.getByRole('button',{name:'Bildirim ayarlarını aç',exact:true}).click();
 await page.getByRole('heading',{name:'Bildirim ayarları',exact:true}).waitFor();
 assert.equal(await page.locator('button[data-view=notifications]').getAttribute('class'),'selected');
 assert.equal(await page.locator('#config').isVisible(),false);
 assert.equal(await page.getByLabel('Telegram bot token’ı').count(),1);
 // Exercise the real app, database, IPC, polling and forms without contacting Telegram.
 await application.evaluate(async(_,url)=>{
  const vm=process.getBuiltinModule('node:vm'),load=vm.runInThisContext('(url)=>import(url)',{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {TelegramApi}=await load(url),{BrowserTools}=await load(new URL('./browser.mjs',url).href);
  // Keep the real queue handler and campaign, while preventing browser/agent launches.
  BrowserTools.prototype.prepare=()=>({ready:false});
  globalThis.telegramUpdates=[];globalThis.telegramSent=[];globalThis.telegramDeleted=[];globalThis.telegramEdited=[];globalThis.telegramCallbacks=[];globalThis.telegramPins=[];
  TelegramApi.prototype.call=async function(method,body,signal){
   const botId=Number(this.token.split(':')[0]);
   if(method==='getMe'){if(botId===987654321)await new Promise(resolve=>setTimeout(resolve,300));return {id:botId,username:botId===123456789?'jobloop_test_bot':'jobloop_second_bot',is_bot:true};}
   if(method==='getWebhookInfo')return {url:''};
   if(method==='getUpdates'){
    await new Promise(resolve=>setTimeout(resolve,100));if(signal.aborted)return [];
    const updates=globalThis.telegramUpdates.filter(update=>(update.testBotId??123456789)===botId);globalThis.telegramUpdates=globalThis.telegramUpdates.filter(update=>(update.testBotId??123456789)!==botId);return updates;
   }
   if(method==='sendMessage'){globalThis.telegramSent.push({...body,botId,message_id:globalThis.telegramSent.length+1});return {message_id:globalThis.telegramSent.length};}
   if(method==='editMessageText'){globalThis.telegramEdited.push({...body,botId});return {message_id:body.message_id};}
   if(method==='deleteMessage'){globalThis.telegramDeleted.push({...body,botId});return true;}
   if(['pinChatMessage','unpinChatMessage'].includes(method)){globalThis.telegramPins.push({method,...body,botId});return true;}
   if(method==='answerCallbackQuery'){globalThis.telegramCallbacks.push({...body,botId});return true;}
   throw Error('Unexpected Telegram method '+method);
  };
 },pathToFileURL(path.join(root,'app/telegram.mjs')).href);
 await page.locator('#candidates').selectOption(candidate.id);
 await page.locator('button[data-view=profile]').click();await page.locator('.profile-telegram button').click();
 await page.getByLabel('Telegram bot token’ı').fill('123456789:abcdefghijklmnopqrstuvwxyz_123456789');
 await page.getByRole('button',{name:'Kaydet ve aç',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-bot-status]').textContent.includes('@jobloop_test_bot'));
 assert.equal(await page.getByLabel('Telegram bot token’ı').inputValue(),'');
 await page.getByRole('button',{name:'Adayı Telegram’a bağla',exact:true}).click();
 const url=await page.getByLabel('Aday Telegram bağlantısı').inputValue();assert.ok(url.startsWith('https://t.me/jobloop_test_bot?start='));
 await page.locator('#notifications').screenshot({path:path.join(data,'telegram-pair.png')});
 await application.evaluate((_,token)=>globalThis.telegramUpdates.push({update_id:1,message:{message_id:1,chat:{id:11,type:'private'},from:{id:11,first_name:'Ada'},text:'/start '+token}}),new URL(url).searchParams.get('start'));
 await page.waitForFunction(()=>document.querySelector('[data-candidate-state]').textContent.includes('Ada hesabı bağlı.'));
 assert.equal(await page.getByLabel('Her yeni ilanı gönder', {exact:true}).isChecked(),true);
 await page.getByLabel('Her yeni ilanı gönder', {exact:true}).uncheck();
 await page.waitForFunction(async id=>(await window.jobloop.telegramStatus(id)).candidate.newJobs===false,candidate.id);
 await page.reload();await page.locator('button[data-view=notifications]').click();
 await page.waitForFunction(()=>document.querySelector('[data-candidate-state]').textContent.includes('Ada hesabı bağlı.'));
 assert.equal(await page.getByLabel('Her yeni ilanı gönder',{exact:true}).isChecked(),false);
 await page.getByLabel('Her yeni ilanı gönder', {exact:true}).check();
 await page.waitForFunction(async id=>(await window.jobloop.telegramStatus(id)).candidate.newJobs===true,candidate.id);
 await page.getByLabel('Gönderilen başvuruları bildir').uncheck();
 await page.waitForFunction(async id=>(await window.jobloop.telegramStatus(id)).candidate.notifications===false,candidate.id);
 await page.getByLabel('Gönderilen başvuruları bildir').check();
 await page.waitForFunction(async id=>(await window.jobloop.telegramStatus(id)).candidate.notifications===true,candidate.id);
 const db=new Store(path.join(data,'jobloop.sqlite'));
 const job=db.addJob(candidate.id,{url:'https://example.com/telegram-smoke',company:'Telegram Demo',role:'Engineer',location:'Remote',fit:'Test listing'}).job;
 const q=db.ask(candidate.id,{question:'Çalışma iznin var mı?',fields:[{id:'permit',label:'Çalışma izni',type:'boolean'}]});db.close();
 let jobMessage;
 for(let i=0;i<100;i++){jobMessage=await application.evaluate((_,url)=>globalThis.telegramSent.find(message=>message.reply_markup?.inline_keyboard?.[0]?.[0]?.url===url),job.url);if(jobMessage)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(jobMessage?.text.startsWith('<b>🔵 İlan bulundu</b>'));assert.equal(jobMessage.chat_id,'11');assert.equal(jobMessage.parse_mode,'HTML');
 assert.ok(jobMessage.text.includes('<b>Engineer</b>\n🏢 <b>Telegram Demo</b>'));assert.ok(jobMessage.text.includes('Henüz puanlanmadı'));
 const scoring=new Store(path.join(data,'jobloop.sqlite'));scoring.rankJob(candidate.id,job.id,rankInput(scoring,candidate.id,62));scoring.close();
 let scoredMessage;
 for(let i=0;i<150;i++){scoredMessage=await application.evaluate((_,id)=>globalThis.telegramEdited.find(message=>message.message_id===id&&message.text.includes('Uygunluk puanı: 62/100')),jobMessage.message_id);if(scoredMessage)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(scoredMessage);assert.equal(scoredMessage.parse_mode,'HTML');assert.ok(scoredMessage.text.includes('<b>Uygunluk puanı: 62/100</b>'));
 await application.evaluate((_,q)=>globalThis.telegramUpdates.push({update_id:2,callback_query:{id:'q',from:{id:11},message:{chat:{id:11,type:'private'}},data:'q:'+q}}),q.id);
 const dialog=async()=>{const s=new Store(path.join(data,'jobloop.sqlite'));try{return JSON.parse(s.db.prepare('SELECT data FROM telegram_links WHERE candidate_id=?').get(candidate.id).data).dialog;}finally{s.close();}};
 let state;for(let i=0;i<50;i++){state=await dialog();if(state)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(state);
 await application.evaluate((_,prompt)=>globalThis.telegramUpdates.push({update_id:3,callback_query:{id:'false',from:{id:11},message:{chat:{id:11,type:'private'}},data:`a:${prompt}:false`}}),state.promptId);
 for(let i=0;i<50;i++){state=await dialog();if(state?.index===1)break;await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(state.index,1);
 await application.evaluate((_,prompt)=>globalThis.telegramUpdates.push({update_id:4,callback_query:{id:'save',from:{id:11},message:{chat:{id:11,type:'private'}},data:`a:${prompt}:save`}}),state.promptId);
 await page.waitForFunction(async({candidate,q})=>(await window.jobloop.snapshot(candidate)).questions.find(item=>item.id===q)?.answerValues?.permit===false,{candidate:candidate.id,q:q.id});
 const desktopDb=new Store(path.join(data,'jobloop.sqlite'));
 const desktopQuestion=desktopDb.ask(candidate.id,{question:'Masaüstü yanıt senkronizasyonu',fields:[{id:'permit',label:'Masaüstü çalışma izni',type:'boolean'},{id:'location',label:'Masaüstü konum tercihi',type:'text'}]});desktopDb.close();
 let questionMessage;
 for(let i=0;i<200;i++){questionMessage=await application.evaluate((_,id)=>globalThis.telegramSent.find(message=>message.reply_markup?.inline_keyboard?.flat().some(button=>button.callback_data==='q:'+id)),desktopQuestion.id);if(questionMessage)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(questionMessage);await page.reload();
 await page.getByLabel('Masaüstü çalışma izni',{exact:true}).selectOption('false');await page.getByLabel('Masaüstü konum tercihi',{exact:true}).fill('Berlin & remote');
 await page.getByRole('button',{name:'Yanıtları gönder',exact:true}).click();
 let answeredMessage;
 for(let i=0;i<150;i++){answeredMessage=await application.evaluate((_,id)=>globalThis.telegramEdited.find(message=>message.message_id===id&&message.text.includes('✅ Yanıtlandı')),questionMessage.message_id);if(answeredMessage)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(answeredMessage);assert.equal(answeredMessage.chat_id,questionMessage.chat_id);assert.match(answeredMessage.text,/Masaüstü çalışma izni: Hayır/);assert.match(answeredMessage.text,/Berlin &amp; remote/);
 assert.ok(!answeredMessage.reply_markup.inline_keyboard.flat().some(button=>button.callback_data?.match(/^[qa]:/)));
 assert.equal(await application.evaluate((_,id)=>globalThis.telegramSent.filter(message=>message.reply_markup?.inline_keyboard?.flat().some(button=>button.callback_data==='q:'+id)).length,desktopQuestion.id),1);
 await page.locator('button[data-view=board]').click();
 await page.getByLabel('Telegram Demo · Engineer başvuru durumu',{exact:true}).selectOption('manual_submitted');
 await page.waitForFunction(async({candidate,job})=>(await window.jobloop.snapshot(candidate)).jobs.find(item=>item.id===job)?.status==='submitted',{candidate:candidate.id,job:job.id});
 let edited;
 for(let i=0;i<100;i++){edited=await application.evaluate((_,id)=>globalThis.telegramEdited.find(message=>message.message_id===id&&message.text.includes('Başvuru gönderildi')),jobMessage.message_id);if(edited)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(edited);assert.equal(edited.chat_id,jobMessage.chat_id);assert.match(edited.text,/Başvuru gönderildi \(kullanıcı beyanı\)/);
 assert.deepEqual(edited.reply_markup.inline_keyboard[0],jobMessage.reply_markup.inline_keyboard[0]);assert.deepEqual(edited.reply_markup.inline_keyboard.at(-1),jobMessage.reply_markup.inline_keyboard.at(-1));
 assert.ok(!edited.reply_markup.inline_keyboard.flat().some(button=>button.callback_data?.startsWith('queue:')));
 await page.locator('button[data-view=profile]').click();await page.locator('.profile-telegram button').click();
 const deleteButton=jobMessage.reply_markup.inline_keyboard.at(-1)[0];assert.equal(deleteButton.text,'🗑 Sil · Vazgeç');assert.equal(deleteButton.style,'danger');
 await application.evaluate((_,{data,messageId})=>globalThis.telegramUpdates.push({update_id:5,callback_query:{id:'delete',from:{id:11},message:{chat:{id:11,type:'private'},message_id:messageId,date:Math.floor(Date.now()/1000)},data}}),{data:deleteButton.callback_data,messageId:jobMessage.message_id});
 let deleted;for(let i=0;i<50;i++){deleted=await application.evaluate(()=>globalThis.telegramDeleted[0]);if(deleted)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.deepEqual(deleted,{chat_id:'11',message_id:jobMessage.message_id,botId:123456789});
 const withdrawn=await page.evaluate(async({candidate,job})=>(await window.jobloop.snapshot(candidate)).jobs.find(item=>item.id===job),{candidate:candidate.id,job:job.id});
 assert.equal(withdrawn.status,'skipped');assert.equal(withdrawn.manualOutcome,'withdrawn');
 const editsAfterDelete=await application.evaluate((_,id)=>globalThis.telegramEdited.filter(message=>message.message_id===id).length,jobMessage.message_id);
 await page.getByRole('button',{name:'Gönderilmemiş ilanları gönder',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#notice').textContent.startsWith('1 ilan Telegram gönderim sırasına alındı.'));
 await page.getByRole('button',{name:'Gönderilmemiş ilanları gönder',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#notice').textContent.startsWith('0 ilan Telegram gönderim sırasına alındı.'));
 let previousMessage;
 for(let i=0;i<200;i++){previousMessage=await application.evaluate((_,url)=>globalThis.telegramSent.find(message=>message.reply_markup?.inline_keyboard?.[0]?.[0]?.url===url),previous.url);if(previousMessage)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(previousMessage?.text.startsWith('<b>🔵 İlan bulundu</b>'));
 const counts=await application.evaluate((_,urls)=>urls.map(url=>globalThis.telegramSent.filter(message=>message.reply_markup?.inline_keyboard?.[0]?.[0]?.url===url).length),[previous.url,completed.url,job.url]);
 assert.deepEqual(counts,[1,0,1]);
 assert.equal(await application.evaluate((_,id)=>globalThis.telegramEdited.filter(message=>message.message_id===id).length,jobMessage.message_id),editsAfterDelete);
 await page.getByLabel('Bekleyen soruları gönder ve bottan yanıtlamaya izin ver',{exact:true}).uncheck();
 await page.waitForFunction(async id=>(await window.jobloop.telegramStatus(id)).candidate.questions===false,candidate.id);
 await page.locator('#candidates').selectOption(other.id);
 await page.waitForFunction(()=>document.querySelector('[data-candidate-name]').textContent.startsWith('Grace Hopper'));
 assert.match(await page.locator('[data-candidate-state]').textContent(),/henüz Telegram’a bağlı değil/);
 assert.match(await page.locator('[data-bot-status]').textContent(),/Önce bir bot bağla/);
 assert.equal(await page.getByLabel('Telegram bot token’ı').inputValue(),'');
 await page.getByLabel('Telegram bot token’ı').fill('987654321:abcdefghijklmnopqrstuvwxyz_987654321');
 await page.getByRole('button',{name:'Kaydet ve aç',exact:true}).click();
 // Switch while getMe is still resolving: the save belongs to Grace, and Ada's panel stays isolated.
 await page.locator('#candidates').selectOption(candidate.id);
 await page.waitForFunction(async id=>(await window.jobloop.telegramStatus(id)).bot?.id===987654321,other.id);
 await page.waitForFunction(()=>document.querySelector('[data-candidate-name]').textContent.startsWith('Ada Lovelace'));
 assert.match(await page.locator('[data-bot-status]').textContent(),/@jobloop_test_bot/);
 assert.equal(await page.getByLabel('Bekleyen soruları gönder ve bottan yanıtlamaya izin ver',{exact:true}).isChecked(),false);
 assert.equal(await page.getByLabel('Telegram bot token’ı').inputValue(),'');
 await page.locator('#candidates').selectOption(other.id);
 await page.waitForFunction(()=>document.querySelector('[data-bot-status]').textContent.includes('@jobloop_second_bot'));
 await page.getByRole('button',{name:'Adayı Telegram’a bağla',exact:true}).click();
 const secondUrl=await page.getByLabel('Aday Telegram bağlantısı').inputValue();assert.ok(secondUrl.startsWith('https://t.me/jobloop_second_bot?start='));
 await application.evaluate((_,token)=>globalThis.telegramUpdates.push({testBotId:987654321,update_id:1,message:{message_id:1,chat:{id:11,type:'private'},from:{id:11,first_name:'Ada'},text:'/start '+token}}),new URL(secondUrl).searchParams.get('start'));
 await page.waitForFunction(()=>document.querySelector('[data-candidate-state]').textContent.includes('Ada hesabı bağlı.'));
 assert.equal(await page.getByLabel('Bekleyen soruları gönder ve bottan yanıtlamaya izin ver',{exact:true}).isChecked(),true);
 const secondDb=new Store(path.join(data,'jobloop.sqlite')),secondJob=secondDb.addJob(other.id,{url:'https://example.com/second-bot',company:'Second Bot',role:'Engineer',location:'Remote',fit:'Test listing'}).job;secondDb.close();
 let secondMessage;
 for(let i=0;i<150;i++){secondMessage=await application.evaluate((_,url)=>globalThis.telegramSent.find(message=>message.reply_markup?.inline_keyboard?.[0]?.[0]?.url===url),secondJob.url);if(secondMessage)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(secondMessage);assert.equal(secondMessage.botId,987654321);assert.equal(secondMessage.chat_id,'11');
 const queueButton=secondMessage.reply_markup.inline_keyboard.flat().find(button=>button.callback_data?.startsWith('queue:'));assert.equal(queueButton?.text,'Öncelikli başvur');
 await application.evaluate((_,{data,messageId})=>globalThis.telegramUpdates.push({testBotId:987654321,update_id:2,callback_query:{id:'queue-first',from:{id:11},message:{chat:{id:11,type:'private'},message_id:messageId},data}}),{data:queueButton.callback_data,messageId:secondMessage.message_id});
 let requestId;
 for(let i=0;i<100;i++){requestId=await page.evaluate(async({candidate,job})=>(await window.jobloop.snapshot(candidate)).campaign?.pendingRetries?.[job]?.requestId,{candidate:other.id,job:secondJob.id});if(requestId)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(requestId);
 await application.evaluate((_,{data,messageId})=>globalThis.telegramUpdates.push({testBotId:987654321,update_id:3,callback_query:{id:'queue-again',from:{id:11},message:{chat:{id:11,type:'private'},message_id:messageId},data}}),{data:queueButton.callback_data,messageId:secondMessage.message_id});
 let queuedMessage;
 for(let i=0;i<100;i++){queuedMessage=await application.evaluate((_,id)=>globalThis.telegramEdited.find(message=>message.message_id===id&&message.botId===987654321&&message.text.includes('Başvuru sırasında')),secondMessage.message_id);if(queuedMessage)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(queuedMessage);assert.ok(!queuedMessage.reply_markup.inline_keyboard.flat().some(button=>button.callback_data?.startsWith('queue:')));
 assert.equal(await page.evaluate(async({candidate,job})=>(await window.jobloop.snapshot(candidate)).campaign.pendingRetries[job].requestId,{candidate:other.id,job:secondJob.id}),requestId);
 assert.equal(await page.evaluate(async id=>(await window.jobloop.snapshot(id)).campaign,candidate.id),null);
 assert.ok(await application.evaluate(()=>globalThis.telegramCallbacks.some(call=>call.callback_query_id==='queue-again'&&call.text.includes('zaten başvuru sırasında'))));
 let pinned;
 for(let i=0;i<100;i++){pinned=await application.evaluate((_,id)=>globalThis.telegramPins.find(message=>message.method==='pinChatMessage'&&message.message_id===id&&message.botId===987654321),secondMessage.message_id);if(pinned)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(pinned);assert.equal(pinned.chat_id,'11');assert.equal(pinned.disable_notification,true);
 await page.evaluate(({candidate,job})=>window.jobloop.setManualJobStatus(candidate,job,'manual_submitted'),{candidate:other.id,job:secondJob.id});
 let unpinned;
 for(let i=0;i<150;i++){unpinned=await application.evaluate((_,id)=>globalThis.telegramPins.find(message=>message.method==='unpinChatMessage'&&message.message_id===id&&message.botId===987654321),secondMessage.message_id);if(unpinned)break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.ok(unpinned);assert.equal(unpinned.chat_id,'11');
 await page.locator('#notifications').screenshot({path:path.join(data,'telegram-second-candidate.png')});
 await page.locator('[data-toggle]').click();await page.waitForFunction(()=>document.querySelector('.telegram-badge').textContent==='Kapalı');
 assert.equal(await page.evaluate(async id=>(await window.jobloop.telegramStatus(id)).running,candidate.id),true);
 await page.locator('#candidates').selectOption(candidate.id);
 await page.waitForFunction(()=>document.querySelector('[data-candidate-name]').textContent.startsWith('Ada Lovelace'));
 assert.match(await page.locator('[data-bot-status]').textContent(),/@jobloop_test_bot/);
 assert.equal(await page.getByLabel('Bekleyen soruları gönder ve bottan yanıtlamaya izin ver',{exact:true}).isChecked(),false);
 await page.locator('#notifications').screenshot({path:path.join(data,'telegram-connected.png')});
 await page.getByRole('button',{name:'Bağlantıyı kaldır',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-candidate-state]').textContent.includes('henüz Telegram’a bağlı değil'));
 await page.locator('[data-toggle]').click();await page.waitForFunction(()=>document.querySelector('.telegram-badge').textContent==='Kapalı');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,screenshots:data,checks:['notification settings page, sidebar and configuration/profile shortcuts','preferences survive reload and stay isolated per candidate','bot setup','pairing','candidate isolation','preferences','formatted job notification and colored buttons','ranking updates score on the same Telegram message','Telegram answer through app handler','desktop form answer updates the original Telegram question and removes answer buttons','desktop status change edits the same Telegram message','Telegram delete marks the job withdrawn through the app handler','deleted messages stay deleted after status changes','send unsent jobs button and duplicate clicks','two candidate tokens and bots with the same Telegram account','candidate switch during token save','Telegram queues its candidate application through the real app handler','duplicate queue clicks retain one request and update the same message','queued card is pinned and completion unpins that exact message','stopping one bot leaves the other running','unlink','stop']}));
}finally{await application.close();}
