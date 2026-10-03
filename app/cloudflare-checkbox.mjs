import {setTimeout as delay} from 'node:timers/promises';
import {findTurnstileCheckbox} from './turnstile-checkbox.mjs';
import {captchaProvider} from './captcha-provider.mjs';

export async function prepareCloudflareCheckbox(slot){
 const document=await slot.page.evaluate(()=>performance.timeOrigin);
 if(slot.cloudflareDocument!==undefined&&slot.cloudflareDocument!==document){
  // Never carry a captured target into a replacement document. An in-flight
  // attempt stops; a later authorized site probe starts from fresh evidence.
  if(pending.has(slot)){
   if(slot.cloudflareDiagnostic)slot.cloudflareDiagnostic.reason='document_changed';
   if(slot.cloudflareDiscovery)slot.cloudflareDiscovery.finished=true;
   if(slot.cloudflareAttempt)slot.cloudflareAttempt.finished=true;
   return false;
  }
  await slot.cloudflareCheckbox?.dispose();delete slot.cloudflareCheckbox;
  delete slot.cloudflareAttempt;delete slot.cloudflareDiscovery;delete slot.cloudflareDiagnostic;
 }
 slot.cloudflareDocument=document;
 const attempt=slot.cloudflareAttempt;
 if(attempt)return !attempt.finished&&Date.now()<attempt.until;
 if(slot.cloudflareCheckbox)return true;
 // This helper is only called on an observed full-page verification barrier.
 // Do not complete verification for a page with user form fields.
 const form=await slot.page.locator('input:not([type="hidden"]),textarea,select').evaluateAll(es=>es.some(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})));
 if(form)return false;
 slot.cloudflareDiscovery??={startedAt:Date.now(),until:Date.now()+8000};
 if(slot.cloudflareDiscovery.finished||Date.now()>=slot.cloudflareDiscovery.until)return false;
 slot.cloudflareDiagnostic??={kind:'cloudflare_checkbox',phase:'discovering',checks:0,clicked:false};
 slot.cloudflareDiagnostic.checks++;
 slot.cloudflareCheckbox=await findTurnstileCheckbox(slot.page,reason=>{slot.cloudflareDiagnostic.reason=reason;});
 // The provider often spends several seconds checking before it renders a
 // checkbox. Keep discovery pending; only the verified target permits a click.
 // A provider may already have a hidden input while its initial check runs.
 // Re-read it within the deadline; hidden controls still never permit a click.
 return !!slot.cloudflareCheckbox||['provider_not_ready','frame_loading','frame_unavailable','checkbox_not_ready','checkbox_not_actionable'].includes(slot.cloudflareDiagnostic.reason);
}

export async function clickCloudflareCheckbox(slot,check){
 const target=slot.cloudflareCheckbox;delete slot.cloudflareCheckbox;
 if(!target||slot.cloudflareAttempt)return false;
 let focus=false,timer;
 try{
  check();
  // CDP input needs the iframe's compositor hit-test region as well as DOM
  // geometry. Wait for two real paints; a newly loaded iframe can have its
  // correct rectangle before Chrome can route a mouse event into it.
  if(await slot.page.evaluate(()=>document.visibilityState==='hidden')){focus=true;await slot.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});}
  const painted=await Promise.race([slot.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1500);})]);
  if(!painted){if(slot.cloudflareDiagnostic)slot.cloudflareDiagnostic.reason='paint_pending';return false;}
  const fresh=await target.evaluate(target.read);
  if(fresh?.origin!==target.meta.origin||fresh.label!==target.meta.label||captchaProvider(target.frame.url())?.provider!=='turnstile'){if(slot.cloudflareDiagnostic)slot.cloudflareDiagnostic.reason='target_changed';return false;}
  const host=await target.frame.frameElement();let box,metrics;
  try{
   box=await host.boundingBox();
   metrics=await host.evaluate((e,p)=>{
    const r=e.getBoundingClientRect(),sx=r.width/e.offsetWidth,sy=r.height/e.offsetHeight;
    const x=r.x+(e.clientLeft+p.x)*sx,y=r.y+(e.clientTop+p.y)*sy,hit=e.getRootNode().elementFromPoint(x,y);
    if(hit!==e||!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return null;
    return {sx,sy,left:e.clientLeft,top:e.clientTop};
   },fresh);
  }finally{await host.dispose();}
  if(!box||!metrics){if(slot.cloudflareDiagnostic)slot.cloudflareDiagnostic.reason='frame_obscured';return false;}
  // The host bounding box is in the main viewport; checkbox geometry is in
  // its own frame. This also handles a bordered or scaled iframe.
  const x=box.x+(metrics.left+fresh.x)*metrics.sx,y=box.y+(metrics.top+fresh.y)*metrics.sy;
  check();slot.cloudflareAttempt={until:Date.now()+8000,finished:false};
  if(slot.cloudflareDiagnostic)Object.assign(slot.cloudflareDiagnostic,{phase:'checking',reason:'click_dispatched',clicked:true});
  await slot.page.mouse.click(x,y);
  return true;
 }finally{clearTimeout(timer);if(focus)await slot.cdp.send('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});await target.dispose();}
}

const pending=new WeakMap();
export async function resolveCloudflareCheckbox(browser,id,result,owner,options){
 const value=JSON.parse(result.content.find(p=>p.type==='text').text);
 const connection=browser.clients.get(id),client=connection?.client,slot=client?.tabs.get(value.tabId);
 if(!slot||slot.owner!==owner)return result;
 if(pending.has(slot))return pending.get(slot);
 const signal=AbortSignal.any([client.abort.signal,...(browser.signal?[browser.signal]:[])]);
 const check=()=>{
  signal.throwIfAborted();
  if(browser.clients.get(id)!==connection||client.tabs.get(slot.id)!==slot||slot.owner!==owner||slot.page.isClosed()||browser.isActive&&!browser.isActive()||!browser.captcha?.settings.status().enabled||client.tabJobs.has(slot.id)||client.automationTabs.get(slot.id)?.startsWith('record:'))throw Error('Doğrulama görevi değişti.');
 };
 const observe=()=>browser.enqueue(id,()=>{check();return browser.performCall(id,'browser_jev_observe',{tabId:slot.id,scope:'document',full:true,fullReason:'context_loss'},owner,options);});
 const promise=(async()=>{
  try{
   slot.captchaProgress={state:'checking',message:'Cloudflare doğrulama kutusu kontrol ediliyor…'};browser.onCaptchaProgress?.(id);
   // Discovery and post-click waiting are outside the workspace queue. A late
   // checkbox gets its one attempt; a disappeared/replaced widget is re-read.
   for(let n=0;n<32;n++){
    check();
    if(!slot.cloudflareAttempt&&slot.cloudflareCheckbox){
     const clicked=await browser.enqueue(id,()=>{check();return clickCloudflareCheckbox(slot,check);});
     if(!clicked){if(slot.cloudflareDiscovery)slot.cloudflareDiscovery.finished=true;return await observe();}
    }
    await delay(500,undefined,{signal});check();
    const current=await observe(),page=JSON.parse(current.content.find(p=>p.type==='text').text);
    if(page.status!=='verification_pending'||page.captcha?.kind!=='cloudflare_checkbox')return current;
   }
   if(slot.cloudflareDiscovery)slot.cloudflareDiscovery.finished=true;
   if(slot.cloudflareAttempt)slot.cloudflareAttempt.finished=true;
   return await observe();
  }catch(error){
   if(slot.owner===owner)slot.cloudflareAttempt={...slot.cloudflareAttempt,finished:true};
   if(signal.aborted)throw error;
   // Preserve the normal site-access error path when the native check fails.
   return await observe();
  }finally{await slot.cloudflareCheckbox?.dispose();delete slot.cloudflareCheckbox;delete slot.captchaProgress;browser.onCaptchaProgress?.(id);pending.delete(slot);}
 })();
 pending.set(slot,promise);return promise;
}
