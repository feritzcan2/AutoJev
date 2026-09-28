import {observedId} from './jev-ids.mjs';
const consentLabel=/^(accept(?: all(?: cookies)?)?|decline|reject(?: all(?: cookies)?)?|customi[sz]e|allow all|only necessary|save preferences|alle akzeptieren|alle ablehnen|nur notwendige|einstellungen|kabul et|tümünü kabul et|reddet)$/i;
async function consentFrame(frame,page){
 if(frame.parentFrame()!==page.mainFrame()||frame.url()!=='about:srcdoc')return false;
 const host=await frame.frameElement();
 try{
  if(!await host.evaluate(e=>e.hasAttribute('srcdoc')&&!e.hasAttribute('sandbox')&&!/captcha|challenge|oauth|login/i.test(e.id+' '+e.title)&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!e.closest('[inert],[aria-hidden="true"]')))return false;
  return await frame.evaluate(()=>/cookie|cookies|çerez/i.test(document.body?.innerText||'')&&!document.querySelector('input[type=password],input[type=email],form[action]'));
 }finally{await host.dispose();}
}
function metadata(e){
 if(!e.isConnected||e.matches(':disabled')||e.getAttribute('aria-disabled')==='true'||e.closest('[inert],[aria-hidden="true"]')||!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return null;
 return {label:(e.getAttribute('aria-label')||e.innerText||e.value||'').replace(/\s+/g,' ').trim(),tag:e.tagName,id:e.id,type:e.type??null,origin:performance.timeOrigin};
}
export async function captureCookieFrameTargets(slot){
 const old=slot.cookieFrameTargets??new Map(),next=new Map(),targets=[];slot.cookieFrameTargets=next;
 try{
  for(const frame of slot.page.frames()){
   if(!await consentFrame(frame,slot.page).catch(()=>false))continue;
   for(const input of await frame.locator('button,[role=button],input[type=button]').elementHandles()){
    const meta=await input.evaluate(metadata).catch(()=>null);
    if(!meta||!consentLabel.test(meta.label)){await input.dispose();continue;}
    let targetId;
    for(const [id,saved] of old)if(saved.owner===slot.owner&&saved.frame===frame&&JSON.stringify(meta)===JSON.stringify(saved.meta)&&await saved.input.evaluate((e,n)=>e===n,input).catch(()=>false)){targetId=id;break;}
    targetId??=observedId('cookie');next.set(targetId,{input,frame,meta,owner:slot.owner,url:slot.page.url()});
    targets.push({targetId,label:meta.label,role:'button',context:'Cookie consent iframe',frameUrl:'about:srcdoc'});
   }
  }
 }finally{await Promise.all([...old.values()].map(s=>s.input.dispose().catch(()=>{})));}
 return targets;
}
export async function clickCookieFrameTarget(slot,targetId,owner){
 const saved=slot.cookieFrameTargets?.get(targetId);if(!saved)return null;
 if(saved.owner!==owner)throw Error('Bu oturuma ait güncel çerez hedefi gerekli.');
 slot.cookieFrameTargets.delete(targetId);
 try{
  if(saved.url!==slot.page.url()||!await consentFrame(saved.frame,slot.page)||JSON.stringify(await saved.input.evaluate(metadata))!==JSON.stringify(saved.meta))return {status:'stale',executed:false,message:'Çerez penceresi değişti; dönen güncel hedefleri kullan.'};
  // Playwright enforces visibility, stability and hit testing through the frame.
  await saved.input.click({timeout:2000});
  return {status:'ready',executed:true,message:'Çerez tercihine tıklandı; dönen sayfada pencerenin kapandığını veya güncellendiğini kontrol et.'};
 }catch{return {status:'uncertain',executed:'unknown',message:'Çerez tıklaması doğrulanamadı. Pencere taşınmış, kapanmış veya üzeri örtülmüş olabilir; sonucu kontrol et, aynı işlemi körlemesine tekrarlama.'};}
 finally{await saved.input.dispose().catch(()=>{});}
}
