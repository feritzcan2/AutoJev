import {access,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createConnection} from 'node:net';
import {listChromeProfiles} from './chrome-profiles.mjs';
import {existingChromeEndpoint} from './jev-chrome.mjs';
import {findChrome,findExecutable} from './chrome-installation.mjs';
import {launchEnvironment as readinessEnvironment} from './launch-environment.mjs';
export {findChrome,findExecutable} from './chrome-installation.mjs';
export {launchEnvironment as readinessEnvironment} from './launch-environment.mjs';
const exec=promisify(execFile);
const providers={codex:{label:'Codex',args:['login','status'],login:'codex login'},claude:{label:'Claude Code',args:['auth','status','--json'],login:'claude auth login'}};
const item=(id,label,state,detail)=>({id,label,state,detail});

export async function inspectLogin(provider,executable,{execImpl=exec,env=process.env,platform=process.platform,home=homedir()}={}){
 const descriptor=providers[provider];
 // Windows package-manager shims need a shell; readiness never evaluates shell
 // code. Native CLI installs are checked, shim users get an explicit manual step.
 if(platform==='win32'&&/\.(cmd|bat)$/i.test(executable))return item('login','Agent oturumu','warning',`Terminalde ${descriptor.login} ile oturum aç. Bu kurulumun oturumu otomatik doğrulanamıyor.`);
 let output,stdout;
 try{const result=await execImpl(executable,descriptor.args,{env,cwd:home,timeout:5000,maxBuffer:32768,windowsHide:true});stdout=result.stdout;output=result.stdout+'\n'+result.stderr;}
 catch(error){
  // Never forward provider output: status commands can include identity or keys.
  if(error.code===1)return item('login','Agent oturumu','error',`Oturum doğrulanamadı. Terminalde ${descriptor.login} ile oturum aç ve tekrar kontrol et.`);
  return item('login','Agent oturumu','warning',`Oturum kontrolü tamamlanamadı. Terminalde ${descriptor.login} ile girişini kontrol et.`);
 }
 let authenticated=false;
 if(provider==='claude'){try{const status=JSON.parse(stdout.trim());if(status.loggedIn===false)return item('login','Agent oturumu','error',`Terminalde ${descriptor.login} ile oturum aç ve tekrar kontrol et.`);authenticated=status.loggedIn===true;}catch{}}
 else authenticated=/\blogged in\b/i.test(output)&&!/\bnot logged in\b/i.test(output);
 return authenticated?item('login','Agent oturumu','ready','CLI oturum bilgisi mevcut. Hizmet erişimi görev başladığında doğrulanır.'):item('login','Agent oturumu','warning',`Oturum durumu doğrulanamadı. Terminalde ${descriptor.login} ile kontrol et.`);
}
export async function chromePortAvailable(endpoint){
 const url=new URL(endpoint);
 if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||!/^\/devtools\/browser\/[\w-]+$/.test(url.pathname))return false;
 return new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port:Number(url.port)});const finish=value=>{socket.destroy();resolve(value);};socket.setTimeout(1000);socket.once('connect',()=>finish(true));socket.once('timeout',()=>finish(false));socket.once('error',()=>finish(false));});
}
export async function collectReadiness(input={},options={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Geçersiz kurulum seçimi.');
 const provider=input.provider??'codex',browserMode=input.browserMode??'existing';
 if(!Object.hasOwn(providers,provider)||!['existing','separate','jev'].includes(browserMode))throw Error('Geçersiz kurulum seçimi.');
 const profile=input.chromeProfile?.directory;
 if(profile!==undefined&&(typeof profile!=='string'||!/^[\w -]{1,100}$/.test(profile)))throw Error('Geçersiz Chrome profili.');
 const platform=options.platform??process.platform,home=options.home??homedir(),env=readinessEnvironment(options.env??process.env,platform,home);
 const deps={env,platform,home},checks=[],descriptor=providers[provider];
 if(options.enginePath){let usable=false;try{await access(options.enginePath,platform==='win32'?constants.F_OK:constants.X_OK);usable=(await stat(options.enginePath)).isFile();}catch{}checks.push(item('engine','JobLoop engine',usable?'ready':'error',usable?'Uygulama motoru hazır.':'Uygulama motoru bulunamadı. JobLoop’u yeniden kur; kaynak koddan çalıştırıyorsan engine:build komutunu çalıştır.'));}
 const executable=await (options.findExecutable??findExecutable)(provider,deps);
 checks.push(item('agent',descriptor.label,executable?'ready':'error',executable?'Agent komutu bulundu.':`${descriptor.label} CLI’ını kur ve JobLoop’u yeniden aç. Komutun terminalden çalışabildiğini kontrol et.`));
 if(executable)checks.push(await (options.inspectLogin??inspectLogin)(provider,executable,deps));
 const bun=await (options.findExecutable??findExecutable)('bun',deps);
 checks.push(item('bun','İlan kaynakları için Bun',bun?'ready':'warning',bun?'Kaynak araçlarını çalıştıran Bun bulundu.':'CLI ile ilan tarayan kaynaklar için Bun’u kur. Tarayıcı kullanan kaynaklarla devam edebilirsin.'));
 if(browserMode==='existing')checks.push(item('browser','Agent tarayıcısı','warning','Tarayıcı araçlarını seçtiğin agent içinde etkinleştir. Bu bağlantı JobLoop tarafından otomatik doğrulanamaz.'));
 else{
  const chrome=await (options.findChrome??findChrome)(deps);
  checks.push(item('chrome','Google Chrome',chrome?'ready':'error',chrome?'Chrome kurulumu bulundu.':'Google Chrome’u kur ve en az bir kez aç.'));
  if(browserMode==='jev'){
   let profiles=[];try{profiles=await (options.listChromeProfiles??listChromeProfiles)();}catch{}
   const hasProfile=profile?profiles.some(p=>p.directory===profile):profiles.length>0;
   checks.push(item('chrome-profile','Chrome profili',hasProfile?'ready':'error',hasProfile?'Mevcut Chrome profili bulundu.':'Chrome’da profil oluştur veya Agent ayarlarından mevcut bir profil seç.'));
   let listening=false;try{listening=await (options.chromePortAvailable??chromePortAvailable)(await (options.existingChromeEndpoint??existingChromeEndpoint)());}catch{}
   checks.push(item('chrome-debug','Chrome bağlantısı',listening?'ready':'error',listening?'Yerel hata ayıklama bağlantısı açık. Agent başlarken Chrome’un bağlantı isteğine izin ver.':'Chrome’da chrome://inspect/#remote-debugging sayfasından uzaktan hata ayıklamayı aç. Agent başlarken bağlantı isteğine izin ver.'));
   let jev;try{jev=await options.jevStatus?.();}catch{}
   checks.push(item('jev','Jev anahtarı',jev?.configured?'ready':'error',jev?.configured?'Jev anahtarı yapılandırıldı. Yapılandırma → Jev bölümünden bağlantıyı test edebilirsin.':jev?.error??'Yapılandırma → Jev bölümünden TypeSafe API anahtarını kaydet.'));
  }
 }
 return {ready:checks.every(check=>check.state!=='error'),checkedAt:Date.now(),provider,browserMode,checks};
}
