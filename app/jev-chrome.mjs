import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {chromeUserDataDirectory} from './chrome-profiles.mjs';
import {findChrome} from './chrome-installation.mjs';
// A cold Chrome process stays alive. Wait for its marker page, not process exit;
// cancelling a connection must not terminate the user's newly opened Chrome.
const exec=(file,args,{signal,windowsHide})=>new Promise((resolve,reject)=>{
  signal?.throwIfAborted();
  const child=spawn(file,args,{windowsHide,detached:true,stdio:'ignore'});
  child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
});

// Chrome's command-line forwarding discards about:/chrome: URLs. A short-lived
// loopback page identifies exactly the new window without inspecting personal tabs.
export async function chromeWindowMarker({observeFocus=false}={}){
  const route=`/jev/${randomUUID()}`,nonce=randomUUID(),waiters=new Set();
  let focused=false,closed=false;
  const server=createServer((req,res)=>{
    const host=`127.0.0.1:${server.address().port}`;
    if(req.headers.host!==host){res.writeHead(404);res.end();return;}
    if(observeFocus&&req.method==='POST'&&[route+'/focused',route+'/blurred'].includes(req.url)&&req.headers.origin===`http://${host}`){
      focused=req.url.endsWith('/focused');if(focused)for(const finish of waiters)finish();
      res.writeHead(204);res.end();return;
    }
    if(req.method!=='GET'||req.url!==route){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'`});
    res.end('<!doctype html><title>AutoJev · Jev</title><p>AutoJev mevcut Chrome oturumuna bağlanıyor…</p>'+(observeFocus?`<script nonce="${nonce}">
      let previous;
      const report=()=>{const active=document.visibilityState==='visible'&&document.hasFocus();if(active===previous)return;previous=active;fetch(location.pathname+(active?'/focused':'/blurred'),{method:'POST',keepalive:true}).catch(()=>{previous=undefined;});};
      addEventListener('focus',report);addEventListener('blur',report);document.addEventListener('visibilitychange',report);
      addEventListener('pagehide',()=>fetch(location.pathname+'/blurred',{method:'POST',keepalive:true}).catch(()=>{}));report();
    </script>`:''));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}${route}`,
    waitForReady({signal,timeout=10000}={}){
      return new Promise((resolve,reject)=>{
        if(signal?.aborted){reject(signal.reason);return;}
        if(closed){reject(Error('Chrome hazırlık penceresi kapandı.'));return;}
        if(focused){resolve();return;}
        const finish=error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);waiters.delete(finish);error?reject(error):resolve();};
        const abort=()=>finish(signal.reason),timer=setTimeout(()=>finish(Error('Seçili Chrome profili hazır değil. Açılan AutoJev penceresini öne getirip yeniden bağlan.')),timeout);
        waiters.add(finish);signal?.addEventListener('abort',abort,{once:true});
      });
    },
    close(){if(closed)return;closed=true;for(const finish of waiters)finish(Error('Chrome hazırlık penceresi kapandı.'));server.closeAllConnections();server.close();}
  };
}

export async function existingChromeEndpoint({directory=chromeUserDataDirectory()}={}){
  let lines;
  try{lines=(await readFile(path.join(directory,'DevToolsActivePort'),'utf8')).trim().split(/\r?\n/);}
  catch{throw Error('Mevcut Chrome bağlantısı kapalı. Chrome’da chrome://inspect/#remote-debugging sayfasından uzaktan hata ayıklamayı aç ve bağlantı isteğine izin ver. Jev ayrı profil açmaz.');}
  const [port,route]=lines;
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||!/^\/devtools\/browser\/[\w-]+$/.test(route))throw Error('Chrome bağlantı bilgisi geçersiz.');
  return `ws://127.0.0.1:${port}${route}`;
}

export async function resolveChromeProfile(selected){
  if(selected?.directory){if(!/^[\w -]{1,100}$/.test(selected.directory))throw Error('Geçersiz Chrome profili.');return selected.directory;}
  const state=JSON.parse(await readFile(path.join(chromeUserDataDirectory(),'Local State'),'utf8'));
  return state.profile?.last_used??'Default';
}

export async function openChromeWindow(url,selected,{directory=chromeUserDataDirectory(),findChromeImpl=findChrome,execImpl=exec,signal}={}){
  signal?.throwIfAborted();
  const state=JSON.parse(await readFile(path.join(directory,'Local State'),'utf8'));
  const profile=selected?.directory??state.profile?.last_used??'Default';
  if(!/^[\w -]{1,100}$/.test(profile)||!state.profile?.info_cache?.[profile])throw Error('Seçili mevcut Chrome profili bulunamadı.');
  const args=[`--profile-directory=${profile}`,'--new-window',url];
  const executable=await findChromeImpl();if(!executable)throw Error('Google Chrome bulunamadı. Chrome’u kur ve en az bir kez aç.');
  signal?.throwIfAborted();
  await execImpl(executable,args,{windowsHide:true,signal});
}
