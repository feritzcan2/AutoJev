import {dialog,shell} from 'electron';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {collectReadiness} from './readiness.mjs';
import {engineBinaryPath} from './runtime-paths.mjs';
import {createUpdateManager} from './update-manager.mjs';
import {createBackup,inspectBackup,stageRestore,pruneLogs,dataManagementStatus} from './data-management.mjs';
import {requestDataLocation,requestExistingDataLocation} from './data-location.mjs';

export async function registerSettingsServices({app,root,data,bootstrapDirectory=data,store,jevSettings,captchaSettings,handle,window,maintenance,emit,clearTerminalOutputs,activeRunIds}){
 const params={dataDirectory:data,db:store.db,appVersion:app.getVersion()};
 handle('readiness',input=>collectReadiness(input,{enginePath:engineBinaryPath({root}),jevStatus:()=>jevSettings.status()}));
 handle('jev-settings-status',()=>jevSettings.status());
 handle('jev-settings-save',input=>jevSettings.save(input));
 handle('jev-settings-remove',()=>jevSettings.remove());
 handle('jev-settings-test',()=>jevSettings.testConnection());
 if(captchaSettings){
  handle('captcha-settings-status',()=>captchaSettings.status());
  handle('captcha-settings-save',input=>captchaSettings.save(input));
  handle('captcha-settings-remove',()=>captchaSettings.remove());
  handle('captcha-settings-test',()=>captchaSettings.testConnection());
 }
 handle('data-status',async()=>({...await dataManagementStatus(params),directory:data}));
 handle('data-open-directory',async()=>{const error=await shell.openPath(data);if(error)throw Error(error);return {opened:true};});
 let choosingDirectory=false;
 handle('data-use-directory',async()=>{
  if(choosingDirectory)throw Error('Veri klasörü seçimi zaten açık.');choosingDirectory=true;
  try{
   const selected=await dialog.showOpenDialog(window(),{title:'Mevcut AutoJev veri klasörünü seç',buttonLabel:'Aç ve yeniden başlat',properties:['openDirectory']});
   if(selected.canceled)return null;
   const result=await requestExistingDataLocation({bootstrapDirectory,dataDirectory:data,destination:selected.filePaths[0]});
   if(result.restartRequired){app.relaunch();app.quit();}return result;
  }finally{choosingDirectory=false;}
 });
 handle('data-change-directory',async()=>{
  if(choosingDirectory)throw Error('Veri klasörü seçimi zaten açık.');choosingDirectory=true;
  try{
   const selected=await dialog.showOpenDialog(window(),{title:'Verilerin taşınacağı boş klasörü seç',buttonLabel:'Taşı ve yeniden başlat',properties:['openDirectory','createDirectory']});
   if(selected.canceled)return null;
   const result=await requestDataLocation({bootstrapDirectory,dataDirectory:data,destination:selected.filePaths[0]});
   if(result.restartRequired){app.relaunch();app.quit();}return result;
  }finally{choosingDirectory=false;}
 });
 handle('data-backup',()=>maintenance.run(async()=>{
  const selected=await dialog.showOpenDialog(window(),{title:'Yedeğin kaydedileceği klasörü seç',properties:['openDirectory','createDirectory']});
  if(selected.canceled)return null;
  return createBackup({...params,destination:path.join(selected.filePaths[0],`AutoJev-backup-${Date.now()}-${randomUUID().slice(0,8)}`),kind:'manual'});
 }));
 handle('data-restore',async()=>{
  // Keep the maintenance lock only once a validated restore is staged.
  let restart=false;
  const result=await maintenance.run(async()=>{
   const selected=await dialog.showOpenDialog(window(),{title:'AutoJev yedek klasörünü seç',properties:['openDirectory']});
   if(selected.canceled)return null;
   const directory=selected.filePaths[0],preview=await inspectBackup(directory);
   const answer=await dialog.showMessageBox(window(),{type:'warning',buttons:['Vazgeç','Geri yükle ve yeniden başlat'],defaultId:0,cancelId:0,title:'Yedeği geri yükle',message:'Mevcut otomasyonlar, template’ler, adaylar ve sonuç kayıtları bu yedekle değiştirilecek.',detail:`Önce mevcut verilerin kurtarma yedeği alınır. Etkin görevler durdurulmuş olarak açılır. Eski bir yedek, sonradan yapılan işlemleri içermeyebilir; devam etmeden sonuçları kontrol et. Otomasyonları yeniden dene; taşınabilir yedeklerde portal şifreleri, Telegram ve Jev anahtarı yeniden girilir.\n\nYedek: ${directory}\n${preview.candidates??preview.summary?.candidates??'?'} aday · ${preview.jobs??preview.summary?.jobs??'?'} ilan`});
   if(answer.response!==1)return null;
   const staged=await stageRestore({...params,directory});restart=true;return staged;
  },{hold:()=>restart});
  if(restart){app.relaunch();app.quit();}
  return result;
 });
 handle('data-clear-logs',async()=>{const result=await maintenance.run(async()=>{const result=await pruneLogs({...params,clear:true});clearTerminalOutputs();return result;});emit('changed',{});return result;});
 handle('data-open-backups',async()=>{const directory=path.join(data,'backups');await mkdir(directory,{recursive:true,mode:0o700});const error=await shell.openPath(directory);if(error)throw Error(error);return {opened:true};});
 const updates=createUpdateManager({app,onChange:state=>emit('update-status',state),beforeInstall:()=>maintenance.run(async()=>{
  const directory=path.join(data,'backups');await mkdir(directory,{recursive:true,mode:0o700});
  await createBackup({...params,destination:path.join(directory,`before-update-${Date.now()}-${randomUUID().slice(0,8)}`),kind:'upgrade'});
  return ()=>maintenance.release();
 },{hold:true})});
 handle('update-status',()=>updates.snapshot());handle('update-check',()=>updates.check());handle('update-download',()=>updates.download());handle('update-install',()=>updates.install());
 const prune=()=>pruneLogs({...params,activeBackgroundRunIds:activeRunIds()});
 await prune();let pruning=false;
 const timer=setInterval(async()=>{if(maintenance.busy||pruning)return;pruning=true;try{await maintenance.invoke('log-retention',prune);}catch(error){emit('agent-event',{event:'error',error:error.message});}finally{pruning=false;}},60*60*1000);timer.unref();
 return {dispose(){clearInterval(timer);updates.dispose();}};
}
