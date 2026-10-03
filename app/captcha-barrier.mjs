import {setTimeout as delay} from 'node:timers/promises';
import {detectCaptcha,captchaProvider} from './captcha-detection.mjs';
import {captureCaptcha,applyCaptcha} from './captcha-browser.mjs';
import {installTurnstileRegistration} from './turnstile-registration.mjs';

export async function prepareTurnstileBarrier(slot){
 const previous=slot.turnstileBarrier;
 if(previous&&['queued','solving','checking'].includes(previous.phase))return true;
 if(previous&&previous.documentId===await slot.page.evaluate(()=>performance.timeOrigin))return false;
 if(previous)delete slot.turnstileBarrier;
 if(!slot.page.frames().some(f=>captchaProvider(f.url())?.provider==='turnstile'))return false;
 await installTurnstileRegistration(slot.page);
 const detection=await detectCaptcha(slot.page);slot.captchaDetection=detection;
 if(detection.state!=='active'||!detection.target?.fullPage||detection.target.requiresSubmissionPermission){
  slot.turnstileDiagnostic={kind:'turnstile_token',state:'unsupported',message:detection.reason??'Turnstile çözüm bilgileri doğrulanamadı.'};return false;
 }
 slot.turnstileBarrier={documentId:detection.documentId,phase:'queued'};
 delete slot.turnstileDiagnostic;return true;
}

export function turnstileBarrierResult(slot,observed){
 slot.verification={state:'checking',capability:'pending',handoff:false,message:'Turnstile API çözümü ve site sonucu kontrol ediliyor…'};
 return {browser:'Jev Chrome',tabId:slot.id,url:observed.url,title:observed.title,text:'',status:'verification_pending',verification:slot.verification,captcha:{kind:'turnstile_token',state:'checking',message:slot.verification.message}};
}

// This path never performs an application submission. Only source/read tabs
// with an observed full-page barrier and no form fields may deliver a callback.
// Polling and provider HTTP stay outside the workspace queue.
export async function resolveTurnstileBarrier(browser,id,result,owner,options){
 const value=JSON.parse(result.content.find(p=>p.type==='text').text);
 const connection=browser.clients.get(id),client=connection?.client,slot=client?.tabs.get(value.tabId);
 if(!slot||slot.owner!==owner||!slot.turnstileBarrier)return result;
 if(pending.has(slot))return pending.get(slot);
 const marker=slot.turnstileBarrier,settings=browser.captcha.settings,revision=settings.revision;
 const page=slot.page,url=page.url(),origin=new URL(url).origin,cancel=new AbortController();let callbackStarted=false;
 const signal=AbortSignal.any([cancel.signal,client.abort.signal,settings.changes.signal,...(browser.signal?[browser.signal]:[])]);
 const readonly=()=>!client.tabJobs.has(slot.id)&&!client.automationTabs.get(slot.id)?.startsWith('record:');
 const active=()=>!signal.aborted&&!page.isClosed()&&!client.closed&&browser.clients.get(id)===connection&&client.tabs.get(slot.id)===slot&&slot.owner===owner&&slot.turnstileBarrier===marker&&readonly()&&settings.revision===revision&&(!browser.isActive||browser.isActive())&&(callbackStarted?new URL(page.url()).origin===origin:page.url()===url);
 const check=()=>{signal.throwIfAborted();if(!active())throw Error('Doğrulama görevi veya sekme değişti.');};
 const closed=()=>cancel.abort(),navigated=frame=>{if(!callbackStarted&&(!frame.parentFrame()||captchaProvider(frame.url())))cancel.abort();};
 page.on('close',closed);page.on('framenavigated',navigated);
 const queued=run=>browser.enqueue(id,()=>{check();return run();});
 const observe=()=>queued(()=>browser.performCall(id,'browser_jev_observe',{tabId:slot.id,scope:'document',full:true,fullReason:'context_loss'},owner,options));
 const fail=message=>{marker.phase='failed';slot.turnstileDiagnostic={kind:'turnstile_token',state:'handoff',message};};
 const promise=(async()=>{
  try{
   marker.phase='solving';
   const outcome=await browser.captcha.run(slot,{owner,signal,active,
    allowed:target=>readonly()&&target.fullPage&&!target.requiresSubmissionPermission,
    changed:()=>browser.onCaptchaProgress?.(id),
    observe:()=>queued(()=>detectCaptcha(page)),
    capture:target=>queued(async()=>{
     const fresh=await detectCaptcha(page);
     if(fresh.state!=='active'||fresh.target?.identity!==target.identity||fresh.target?.round!==target.round||!fresh.target.fullPage||fresh.target.requiresSubmissionPermission)throw Error('Doğrulama veya işlem yetkisi değişti.');
     return captureCaptcha(page,fresh.target);
    }),
    apply:(target,capture,solution,guard)=>queued(()=>applyCaptcha(page,target,capture,solution,{
     check:()=>{guard();check();},allowBarrierCallback:true,
     beforeCallback:()=>{guard();check();callbackStarted=true;marker.phase='checking';}
    }))
   });
   check();
   if(callbackStarted){
    slot.captchaProgress={state:'checking',message:'CapSolver cevabı aktarıldı; sayfanın açılması kontrol ediliyor…'};browser.onCaptchaProgress?.(id);
    for(let n=0;n<16;n++){
     await delay(500,undefined,{signal});check();
     const current=await observe(),fresh=JSON.parse(current.content.find(p=>p.type==='text').text);
     if(fresh.status!=='verification_pending'){
      const accepted=marker.phase==='cleared'&&!fresh.siteWait&&!fresh.reading?.readiness?.loading&&!!fresh.text?.trim()&&!fresh.verification;
      fresh.captcha={kind:'turnstile_token',state:accepted?'cleared':'handoff',message:accepted?'Doğrulama engeli kalktı ve sayfa içeriği okundu.':'Çözüm aktarıldı; sitenin erişimi açtığı doğrulanamadı.'};
      current.content.find(p=>p.type==='text').text=JSON.stringify(fresh);return current;
     }
    }
   }
   fail(outcome?.state==='handoff'?outcome.message:callbackStarted?'CapSolver cevabı siteye aktarıldı ancak doğrulama engeli kalkmadı. Aynı cevap tekrar gönderilmedi.':'Aktif doğrulama değişti; API çözümü uygulanmadı.');
   return await observe();
  }catch(error){
   fail('Doğrulama görevi durdu veya sayfa değişti; eski cevap yeniden uygulanmadı.');
   if(signal.aborted)throw error;
   if(active())return await observe();
   return {content:[{type:'text',text:JSON.stringify({browser:'Jev Chrome',tabId:slot.id,status:'verification_cancelled',executed:false,captcha:slot.turnstileDiagnostic,message:slot.turnstileDiagnostic.message})}]};
  }finally{page.off('close',closed);page.off('framenavigated',navigated);delete slot.captchaProgress;browser.onCaptchaProgress?.(id);pending.delete(slot);}
 })();
 pending.set(slot,promise);return promise;
}
const pending=new WeakMap();
