import {detectCaptcha,captchaProvider} from './captcha-detection.mjs';
import {captureCaptcha,applyCaptcha,verifyCaptchaGrid} from './captcha-browser.mjs';
import {resolveCloudflareCheckbox} from './cloudflare-checkbox.mjs';
import {resolveTurnstileBarrier} from './captcha-barrier.mjs';

export async function resolveBrowserCaptcha(browser,id,result,owner,options){
 const coordinator=browser.captcha;if(!coordinator)return result;
 const part=result.content?.find(p=>p.type==='text');let value;
 try{value=JSON.parse(part.text);}catch{return result;}
 if(value.status==='verification_pending'&&value.captcha?.kind==='cloudflare_checkbox'){
  const next=await resolveCloudflareCheckbox(browser,id,result,owner,options);
  const fresh=JSON.parse(next.content.find(p=>p.type==='text').text);
  return fresh.status==='verification_pending'&&fresh.captcha?.kind==='turnstile_token'?resolveTurnstileBarrier(browser,id,next,owner,options):next;
 }
 if(value.status==='verification_pending'&&value.captcha?.kind==='turnstile_token')return resolveTurnstileBarrier(browser,id,result,owner,options);
 const connection=browser.clients.get(id),client=connection?.client,slot=client?.tabs.get(value.tabId);
 // Only evidence of a challenge starts the bounded solver loop: a confirmed
 // widget, or a provider frame still loading. A detection that merely ran out
 // of time on an ordinary page must not cost every browser call its wait.
 const detection=slot?.captchaDetection,evidence=detection?.state==='active'||['checking','unknown'].includes(detection?.state)&&(detection.frames?.length>0||detection.pendingHosts===true);
 if(!slot||!evidence||value.siteWait||slot.owner!==owner)return result;
 if(slot.captchaDetection.target?.provider==='turnstile'&&slot.verificationCheckboxAttempt!==slot.captchaDetection.target.url)return result;
 const page=slot.page,url=page.url(),cancel=new AbortController();
 const closed=()=>cancel.abort(),navigated=frame=>{if(!frame.parentFrame()||captchaProvider(frame.url()))cancel.abort();};
 page.on('close',closed);page.on('framenavigated',navigated);
 const signal=AbortSignal.any([client.abort.signal,cancel.signal,...(browser.signal?[browser.signal]:[])]);
 const active=()=>!signal.aborted&&!client.closed&&!page.isClosed()&&browser.clients.get(id)===connection&&client.tabs.get(slot.id)===slot&&slot.owner===owner&&page.url()===url&&(!browser.isActive||browser.isActive());
 const queued=run=>browser.enqueue(id,async()=>{if(!active())throw Error('CAPTCHA görevi artık etkin değil.');return run();});
 const allowed=target=>{
  if(!target.requiresSubmissionPermission&&!client.tabJobs.has(slot.id)&&!client.automationTabs.get(slot.id)?.startsWith('record:'))return true;
  return browser.captchaMaySubmit?.()===true;
 };
 try{
  const outcome=await coordinator.run(slot,{owner,signal,active,allowed,
   changed:()=>browser.onCaptchaProgress?.(id),
   observe:()=>queued(()=>detectCaptcha(page)),
   capture:target=>queued(async()=>{const fresh=await detectCaptcha(page);if(fresh.state!=='active'||fresh.target?.identity!==target.identity||fresh.target?.round!==target.round)throw Error('CAPTCHA değişti.');return captureCaptcha(page,fresh.target);}),
   apply:(target,capture,solution,check)=>queued(()=>applyCaptcha(page,target,capture,solution,{check:()=>{check();if(!active()||!allowed(target))throw Error('Doğrulama görevi veya gönderim yetkisi değişti.');}})),
   verify:(target,check)=>queued(()=>verifyCaptchaGrid(page,target,{check:()=>{check();if(!active()||!allowed(target))throw Error('Doğrulama görevi veya gönderim yetkisi değişti.');}}))
  });
  if(!outcome)return result;
  if(!active())return {content:[{type:'text',text:JSON.stringify({browser:'Jev Chrome',tabId:slot.id,status:'verification_cancelled',executed:value.executed??false,message:'Doğrulama görevi veya sayfa değişti; eski çözüm uygulanmadı. Güncel sekmeyi gözlemle, önceki gönderimi tekrarlama.'})}]};
  if(outcome.state==='answer_applied')slot.captchaAnswer={identity:outcome.identity,message:outcome.message};
  const observed=await browser.enqueue(id,()=>browser.performCall(id,'browser_jev_observe',{tabId:slot.id,full:true,fullReason:'context_loss',...(value.reading?{scope:'document'}:{})},owner,options));
  const output=observed.content?.find(p=>p.type==='text');if(!output)return observed;
  const fresh=JSON.parse(output.text);fresh.captcha={state:outcome.state,message:outcome.message};
  if(value.executed!==undefined)fresh.executed=value.executed;
  if(outcome.state==='handoff'){
   fresh.status='verification_handoff';fresh.verification={...fresh.verification,state:'required',handoff:true,evidence:outcome.message,message:outcome.message};slot.verification=fresh.verification;
  }
  output.text=JSON.stringify(fresh);return observed;
 }finally{page.off('close',closed);page.off('framenavigated',navigated);}
}
