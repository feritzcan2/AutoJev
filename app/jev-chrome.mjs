import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {chromeUserDataDirectory} from './chrome-profiles.mjs';
const exec=promisify(execFile);

// Chrome's command-line forwarding discards about:/chrome: URLs. A short-lived
// loopback page identifies exactly the new window without inspecting personal tabs.
export async function chromeWindowMarker(){
  const route=`/jev/${randomUUID()}`;
  const server=createServer((req,res)=>{
    if(req.url!==route||req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"});
    res.end('<!doctype html><title>Jobloop · Jev</title><p>Jobloop mevcut Chrome oturumuna bağlanıyor…</p>');
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}${route}`,close(){server.closeAllConnections();server.close();}};
}

export async function existingChromeEndpoint(){
  let lines;
  try{lines=(await readFile(path.join(chromeUserDataDirectory(),'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);}
  catch{throw Error('Mevcut Chrome bağlantısı kapalı. Chrome’da chrome://inspect/#remote-debugging sayfasından uzaktan hata ayıklamayı aç ve bağlantı isteğine izin ver. Jev ayrı profil açmaz.');}
  const [port,route]=lines;
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||!/^\/devtools\/browser\/[\w-]+$/.test(route))throw Error('Chrome bağlantı bilgisi geçersiz.');
  return `ws://127.0.0.1:${port}${route}`;
}

export async function openChromeWindow(url,selected){
  const state=JSON.parse(await readFile(path.join(chromeUserDataDirectory(),'Local State'),'utf8'));
  const profile=selected?.directory??state.profile?.last_used??'Default';
  if(!/^[\w -]{1,100}$/.test(profile)||!state.profile?.info_cache?.[profile])throw Error('Seçili mevcut Chrome profili bulunamadı.');
  const args=[`--profile-directory=${profile}`,'--new-window',url];
  if(process.platform==='darwin')await exec('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args,{timeout:10000});
  else if(process.platform==='win32')await exec(path.join(process.env.PROGRAMFILES??'C:\\Program Files','Google/Chrome/Application/chrome.exe'),args,{timeout:10000});
  else await exec('google-chrome',args,{timeout:10000});
}
