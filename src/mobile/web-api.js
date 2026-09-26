// Browser stand-in for the Electron preload bridge. Same method names as window.jobloop on the desktop,
// carried over HTTP to the JobLoop app running on the user's Mac (see app/mobile.mjs).
import {invoke,events} from 'jobloop:bridge';

const listeners=new Map();
let source=null,dropped=false;

function offline(on){
  document.documentElement.classList.toggle('mobile-offline',on);
  let bar=document.getElementById('mobile-offline');
  if(on&&!bar){bar=document.createElement('div');bar.id='mobile-offline';bar.setAttribute('role','status');bar.textContent='Bilgisayara ulaşılamıyor. JobLoop Mac’te açık mı, telefon aynı ağda mı? Yeniden deneniyor…';document.body.append(bar);}
  if(bar)bar.hidden=!on;
}
function toast(message){const box=document.getElementById('notice');if(!box)return;box.textContent=message;box.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>{if(box.textContent===message)box.hidden=true;},4000);}

async function call(channel,...args){
  let response;
  try{response=await fetch(`/api/${channel}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-JobLoop':'1'},body:JSON.stringify({args})});}
  catch{offline(true);throw Error('Bilgisayara ulaşılamıyor.');}
  offline(false);
  if(response.status===401){location.replace('/');throw Error('Telefon bağlantısı gerekli.');}
  const body=await response.json().catch(()=>({ok:false,error:'Bilgisayardan geçersiz yanıt geldi.'}));
  if(!body.ok)throw Error(body.error);
  return body.value;
}

function dispatch(channel,value){for(const callback of listeners.get(channel)??[]){try{callback(value);}catch(error){console.error(error);}}}
function subscribe(channel,callback){if(!listeners.has(channel))listeners.set(channel,new Set());listeners.get(channel).add(callback);return()=>listeners.get(channel).delete(callback);}
// Anything missed while the stream was down is recovered by asking the page to refresh.
function resync(){dispatch('changed',{});dispatch('background-changed',{});}
function connect(){
  source?.close();source=new EventSource('/events',{withCredentials:true});
  source.onmessage=event=>{try{const {channel,value}=JSON.parse(event.data);dispatch(channel,value);}catch{}};
  source.onopen=()=>{offline(false);if(dropped){dropped=false;resync();}};
  source.onerror=()=>{dropped=true;offline(true);if(source.readyState===EventSource.CLOSED)setTimeout(connect,3000);};
}
// Phones suspend background tabs; catch up as soon as the page is visible again.
document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')return;if(!source||source.readyState===EventSource.CLOSED)connect();resync();});

function pickFile(accept){
  return new Promise(resolve=>{
    const input=document.createElement('input');input.type='file';input.accept=accept;input.hidden=true;let done=false;
    const finish=file=>{if(done)return;done=true;window.removeEventListener('focus',returned);input.remove();resolve(file);};
    // Some mobile browsers never fire 'cancel'; returning to the page without a file counts as cancel.
    const returned=()=>setTimeout(()=>finish(input.files?.[0]??null),1000);
    input.onchange=()=>finish(input.files?.[0]??null);input.addEventListener('cancel',()=>finish(null));
    document.body.append(input);window.addEventListener('focus',returned);input.click();
  });
}
async function uploadCv(id,file){
  if(!file)return null;
  if(file.size>15*1024*1024)throw Error('CV 15 MB’tan büyük olamaz.');
  let response;
  try{response=await fetch(`/upload-cv?candidate=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`,{method:'POST',credentials:'same-origin',headers:{'X-JobLoop':'1','Content-Type':'application/octet-stream'},body:file});}
  catch{offline(true);throw Error('Bilgisayara ulaşılamıyor.');}
  const body=await response.json().catch(()=>({ok:false,error:'CV yüklenemedi.'}));
  if(!body.ok)throw Error(body.error);
  return body.value;
}
const desktopOnly=message=>async()=>{throw Error(message);};

const api={};
for(const [name,channel] of Object.entries(invoke)){
  // Tabs belong to the agent's Chrome on the Mac; say where they opened.
  api[name]=/^open-.*-tab$/.test(channel)?async(...args)=>{const value=await call(channel,...args);toast('Sekme bilgisayardaki Chrome’da açıldı.');return value;}:(...args)=>call(channel,...args);
}
for(const [name,channel] of Object.entries(events))api[name]=callback=>subscribe(channel,callback);
Object.assign(api,{
  openLink:async url=>{const target=new URL(url);if(!['http:','https:'].includes(target.protocol))throw Error('Geçersiz bağlantı');window.open(target.toString(),'_blank','noopener');},
  openDocument:async(id,file)=>{window.open(`/files/${encodeURIComponent(id)}/${String(file).split('/').map(encodeURIComponent).join('/')}`,'_blank','noopener');},
  pickCv:async id=>uploadCv(id,await pickFile('.pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain')),
  importSetupCv:(id,file)=>uploadCv(id,file),
  // The agent terminal keeps the desktop's size; a phone must not reflow it.
  resize:async()=>{},backgroundResize:async()=>{},
  backgroundPickSkill:desktopOnly('Skill dosyası bilgisayardan seçilir.'),
  backgroundConnectGmail:desktopOnly('Gmail bağlantısı bilgisayardan kurulur.'),
});
delete api.mobileStatus;delete api.mobileEnable;delete api.mobileRotate;
window.jobloop=api;
document.documentElement.classList.add('is-mobile-client');
connect();
