import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export function createUpdateManager({app,beforeInstall,onChange=()=>{},updater,platform=process.platform,env=process.env}){
 const enabled=Boolean(app.isPackaged)&&(platform!=='linux'||Boolean(env.APPIMAGE));
 let state={enabled,status:enabled?'idle':'unsupported',version:app.getVersion(),availableVersion:null,progress:null,error:null};
 let busy=false,disposed=false,releaseInstall;
 const publish=patch=>{if(disposed)return;state={...state,...patch};onChange({...state});};
 if(!enabled)return{snapshot:()=>({...state}),check:async()=>({...state}),download:async()=>{throw Error('Bu kurulumda otomatik güncelleme desteklenmiyor.');},install:async()=>{throw Error('Bu kurulumda otomatik güncelleme desteklenmiyor.');},dispose:()=>{disposed=true;}};
 const client=updater??require('electron-updater').autoUpdater;
 client.autoDownload=false;client.autoInstallOnAppQuit=false;client.allowDowngrade=false;client.allowPrerelease=false;
 const listeners={
  'checking-for-update':()=>publish({status:'checking',error:null}),
  'update-available':info=>publish({status:'available',availableVersion:info.version,progress:null,error:null}),
  'update-not-available':()=>publish({status:'current',availableVersion:null,progress:null,error:null}),
  'download-progress':info=>publish({status:'downloading',progress:Math.max(0,Math.min(100,Number(info.percent)||0))}),
  'update-downloaded':info=>publish({status:'downloaded',availableVersion:info.version,progress:100,error:null}),
  error:error=>{const release=releaseInstall;releaseInstall=null;Promise.resolve().then(()=>release?.()).catch(()=>{});publish({status:'error',error:String(error.message??error).slice(0,1000)});},
 };
 for(const [event,listener] of Object.entries(listeners))client.on(event,listener);
 async function action(fn){if(busy)throw Error('Güncelleme işlemi devam ediyor.');busy=true;try{await fn();return {...state};}catch(error){publish({status:'error',error:String(error.message??error).slice(0,1000)});throw error;}finally{busy=false;}}
 return {
  snapshot:()=>({...state}),
  check:()=>action(()=>client.checkForUpdates()),
  download:()=>action(async()=>{if(state.status!=='available')throw Error('İndirilecek güncelleme bulunamadı.');publish({status:'downloading',progress:0,error:null});await client.downloadUpdate();}),
  install:()=>action(async()=>{if(state.status!=='downloaded')throw Error('Önce güncellemeyi indir.');if(typeof beforeInstall!=='function')throw Error('Güncelleme öncesi yedekleme hazır değil.');try{releaseInstall=await beforeInstall();publish({status:'installing',error:null});client.quitAndInstall(false,true);}catch(error){const release=releaseInstall;releaseInstall=null;await release?.();throw error;}}),
  dispose:()=>{disposed=true;for(const [event,listener] of Object.entries(listeners))client.removeListener(event,listener);},
 };
}
