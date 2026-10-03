import {createHash} from 'node:crypto';
import {accessBarrier} from './site-access.mjs';
import {findTurnstileCheckbox} from './turnstile-checkbox.mjs';
import {readTurnstileRegistration} from './turnstile-registration.mjs';

import {captchaProvider} from './captcha-provider.mjs';
export {captchaProvider} from './captcha-provider.mjs';
const questions=[['/m/0pg52',/^(taxis|taksiler)$/i],['/m/01bjv',/^(buses|bus|otobüsler|busse)$/i],['/m/02yvhj',/^school buses$/i],['/m/04_sv',/^(motorcycles|motosikletler|motorräder)$/i],['/m/013xlm',/^(tractors|traktörler|traktoren)$/i],['/m/01jk_4',/^(chimneys|bacalar|schornsteine)$/i],['/m/014xcs',/^(crosswalks|yaya geçitleri|fußgängerüberwege)$/i],['/m/015qff',/^(traffic lights|trafik ışıkları|ampeln)$/i],['/m/0199g',/^(bicycles|bisikletler|fahrräder)$/i],['/m/015qbp',/^parking meters$/i],['/m/0k4j',/^(cars|arabalar|autos)$/i],['/m/015kr',/^(bridges|köprüler|brücken)$/i],['/m/019jd',/^(boats|tekneler|boote)$/i],['/m/0cdl1',/^(palm trees|palmiyeler|palmen)$/i],['/m/09d_r',/^mountains or hills$/i],['/m/01pns0',/^(fire hydrants|yangın muslukları|hydranten)$/i],['/m/01lynh',/^(stairs|merdivenler|treppen)$/i]];
export const gridQuestion=text=>questions.find(([,pattern])=>pattern.test(text.trim()))?.[0]??null;
export const captchaHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Explicitly separate uncertain discovery from absence. Token presence is an
// observation, not evidence that the website accepted an injected answer.
export function classifyCaptcha({frames=[],pendingHosts=false,loading=false,staleError=false,ocr=null}={}){
 const active=frames.filter(f=>f.visible&&f.part==='challenge'&&f.grid&&f.instructions&&!f.loading&&!f.dynamic&&!f.audio&&!f.blocked);
 if(active.length>1)return {state:'unsupported',reason:'Birden fazla aktif CAPTCHA var; otomatik çözüm belirsiz.'};
 if(active.length===1)return {state:active[0].provider==='recaptcha'?'active':'unsupported',target:active[0],reason:'Görünür sağlayıcı challenge alanı ve görsel seçim yönergesi doğrulandı.'};
 const turnstiles=frames.filter(f=>f.provider==='turnstile'&&f.visible&&f.unchecked&&f.instructions&&!f.loading&&!f.token&&!f.blocked);
 if(turnstiles.length>1)return {state:'unsupported',reason:'Birden fazla aktif Turnstile var; otomatik çözüm belirsiz.'};
 if(turnstiles.length===1)return {state:'active',target:turnstiles[0],reason:'Turnstile içinde görünür, bekleyen doğrulama kontrolü doğrulandı.'};
 const unsupported=frames.find(f=>f.visible&&(f.audio||f.blocked||f.part==='challenge'&&f.loaded&&!f.grid&&!f.loading));
 if(unsupported)return {state:'unsupported',target:unsupported,reason:'Görünür doğrulama otomatik çözüm kapsamı dışında.'};
 if(pendingHosts||frames.some(f=>f.unavailable||f.visible&&(!f.loaded||f.loading||f.dynamic)))return {state:'unknown',reason:'Doğrulama alanı henüz okunamadı; yüklenme bekleniyor.'};
 const checked=frames.find(f=>f.visible&&f.checked&&!frames.some(c=>c.visible&&(c.part==='challenge'||c.part==='anchor'&&!c.checked&&!c.invisible)));
 if(checked)return {state:'cleared',reason:'Doğrulama kontrolü tamamlandı; sonraki site yanıtını kontrol et.'};
 const token=frames.find(f=>f.provider==='turnstile'&&f.visible&&f.token);
 if(token)return {state:'token_present',target:token,reason:'Doğrulama yanıtı var; site kabulünü normal görev akışında doğrula.'};
 if(frames.some(f=>f.provider==='turnstile'&&f.visible&&!f.checked&&!f.unchecked&&!f.token))return {state:'unknown',reason:'Turnstile durumu okunamadı; aktif challenge olduğu varsayılmadı.'};
 if(ocr)return {state:'active',target:ocr,reason:'Görünür CAPTCHA resmi ile açıkça ilişkili cevap alanı doğrulandı.'};
 if(staleError)return {state:'error',reason:'Doğrulama hata metni var; aktif CAPTCHA kanıtı yok.'};
 if(frames.some(f=>f.visible&&!f.invisible))return {state:loading?'checking':'idle',target:frames.find(f=>f.visible),reason:'Doğrulama widget’ı var; aktif challenge kanıtı yok.'};
 if(loading&&frames.length)return {state:'checking',reason:'Doğrulama yükleniyor.'};
 return {state:'none'};
}

export const gridSelector='table.rc-imageselect-table-33,table.rc-imageselect-table-44';
async function visibleFrame(frame){
 for(let current=frame,depth=0;current?.parentFrame()&&depth<12;current=current.parentFrame(),depth++){
  const host=await current.frameElement();
  try{if(!await host.evaluate(e=>{const r=e.getBoundingClientRect();return e.isConnected&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!e.closest('[inert],[aria-hidden="true"]')&&r.width>16&&r.height>16&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;}))return false;}
  finally{await host.dispose().catch(()=>{});}
 }
 return true;
}
async function imageCaptcha(page){
 const matches=[];
 for(const frame of page.frames()){
  if(captchaProvider(frame.url())||!await visibleFrame(frame).catch(()=>false))continue;
  const items=await frame.evaluate(()=>{
   const inputs=[...document.querySelectorAll('input')],images=[...document.images];
   return inputs.flatMap((input,index)=>{
    if(!['text',''].includes(input.getAttribute('type')??'')||input.disabled||input.readOnly||input.autocomplete==='one-time-code'||!input.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return [];
    const labels=[...(input.labels??[])],named=(input.getAttribute('aria-labelledby')??'').split(/\s+/).map(id=>document.getElementById(id)).filter(Boolean);
    const label=[input.getAttribute('aria-label')??'',...labels.map(e=>e.textContent),...named.map(e=>e.textContent)].join(' ');
    if(!/captcha/i.test(label)||/one.time|\botp\b|\bapi\b|\bkey\b|token|secret|anahtar|sms|email|e-posta|telefon/i.test(label))return [];
    const described=(input.getAttribute('aria-describedby')??'').split(/\s+/).map(id=>document.getElementById(id)).filter(Boolean);
    const candidates=[...new Set([...labels,...named,...described].flatMap(e=>e.tagName==='IMG'?[e]:[...e.querySelectorAll('img')]))].filter(e=>e.complete&&e.naturalWidth>0&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
    if(candidates.length!==1)return [];
    const img=candidates[0];return [{inputIndex:index,imageIndex:images.indexOf(img),src:img.currentSrc,label:label.trim().slice(0,300),value:input.value,origin:performance.timeOrigin}];
   });
  }).catch(()=>[]);
  for(const item of items)if(!item.value)matches.push({...item,provider:'image',part:'image',frame,parent:frame,visible:true,requiresSubmissionPermission:true,url:frame.url()});
 }
 return matches.length===1?matches[0]:null;
}
const inFlight=new WeakMap();
export async function detectCaptcha(page,{timeoutMs=1500}={}){
 let entry=inFlight.get(page);
 if(!entry){
  entry={};inFlight.set(page,entry);
  entry.promise=readCaptcha(page).catch(()=>({state:'unknown',reason:'Doğrulama alanı okunamadı.',frames:[]})).finally(()=>{if(inFlight.get(page)===entry)inFlight.delete(page);});
 }
 let timer;
 try{return await Promise.race([entry.promise,new Promise(resolve=>{timer=setTimeout(()=>resolve({state:'unknown',reason:'Doğrulama alanının yanıtı bekleniyor.',frames:[]}),timeoutMs);})]);}
 finally{clearTimeout(timer);}
}
async function readCaptcha(page){
 const frames=[],seen=new Set();
 const main=await page.evaluate(()=>({origin:performance.timeOrigin,url:location.href,title:document.title,text:(document.body?.innerText??'').slice(0,16000),loading:document.readyState!=='complete',staleError:/(?:captcha|human verification) (?:failed|error|expired)|There was an error verifying your application/i.test(document.body?.innerText??'')}));
 const barrier=accessBarrier(main);
 if(barrier==='ip_block')return {state:'unsupported',reason:'IP erişim engeli; aktif CAPTCHA olduğu varsayılmadı.',documentId:main.origin,pageUrl:main.url,frames:[]};
 for(const frame of page.frames()){
  const protocol=captchaProvider(frame.url());if(!protocol)continue;
  const item={...protocol,frame,url:frame.url(),visible:false};frames.push(item);seen.add(item.url);let host;
  try{
   host=await frame.frameElement();item.parent=frame.parentFrame();
   item.visible=await visibleFrame(frame);
   if(!item.visible)continue;
   Object.assign(item,await frame.evaluate(()=>{
    const visible=e=>e&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    const box=[...document.querySelectorAll('[role="checkbox"],input[type="checkbox"]')].find(visible);
    const table=[...document.querySelectorAll('table.rc-imageselect-table-33,table.rc-imageselect-table-44')].find(visible);
    const instructions=[...document.querySelectorAll('.rc-imageselect-desc-wrapper,[role="heading"],label')].filter(visible).map(e=>e.textContent.trim()).join(' ').slice(0,800);
    const text=document.body?.innerText??'';
    const cells=table?[...table.querySelectorAll('td')]:[];
    return {origin:performance.timeOrigin,loaded:document.readyState!=='loading'&&!!document.body?.childElementCount,loading:!!document.querySelector('[aria-busy="true"]')||box?.getAttribute('aria-checked')==='mixed'||!!table&&cells.some(e=>!e.querySelector('img')?.complete),checked:!!box&&(box.checked===true||box.getAttribute('aria-checked')==='true'),unchecked:!!box&&(box.checked===false||box.getAttribute('aria-checked')==='false'),instructions:instructions||box?.getAttribute('aria-label')||'',grid:!!table&&[9,16].includes(cells.length)&&cells.every(e=>e.querySelector('img')?.complete),count:cells.length,question:document.querySelector('.rc-imageselect-desc-wrapper strong')?.textContent?.trim()??'',images:cells.map(e=>e.querySelector('img')?.currentSrc??''),selected:cells.map((e,i)=>e.classList.contains('rc-imageselect-tileselected')?i:-1).filter(i=>i>=0),dynamic:!!table?.querySelector('.rc-imageselect-dynamic-selected'),audio:!![...document.querySelectorAll('audio,input#audio-response')].find(visible),blocked:/automated queries|try again later/i.test(text)};
   }));
   if(item.parent)Object.assign(item,await item.parent.evaluate(({provider,sitekey})=>{
    const widgets=[...document.querySelectorAll('[data-sitekey]')].filter(e=>!sitekey||e.getAttribute('data-sitekey')===sitekey);
    const widget=widgets.length===1?widgets[0]:null;
    const tokens=[...document.querySelectorAll(provider==='turnstile'?'input[name="cf-turnstile-response"]':provider==='hcaptcha'?'[name="h-captcha-response"]':'[name="g-recaptcha-response"]')];
    const fields=[...document.querySelectorAll('input:not([type="hidden"]),textarea,select')].filter(e=>!/(?:g-recaptcha|h-captcha|cf-turnstile)-response/.test(e.name)&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
    return {sitekey:sitekey||widget?.getAttribute('data-sitekey'),token:tokens.length===1&&tokens[0].value.length>=20,tokenCount:tokens.length,action:widget?.getAttribute('data-action')??null,cdata:widget?.getAttribute('data-cdata')??null,dataS:widget?.getAttribute('data-s')??null,requiresSubmissionPermission:fields.length>0||document.forms.length>0};
   },{provider:item.provider,sitekey:item.sitekey}));
   if(item.provider==='turnstile'){
    const registration=await readTurnstileRegistration(host);
    if(registration)Object.assign(item,{...registration,token:item.token||registration.answered});
   }
  }catch{item.unavailable=true;}finally{await host?.dispose().catch(()=>{});}
 }
 // Provider controls inside closed shadow roots are invisible to querySelector.
 // Reuse the native checkbox inspector, including transparent styled inputs.
 if(frames.some(f=>f.provider==='turnstile'&&f.visible&&!f.unchecked&&!f.checked&&!f.token)){
  const checkbox=await findTurnstileCheckbox(page);
  if(checkbox)try{
   const matches=frames.filter(f=>f.url===checkbox.frame.url()&&f.visible);
   if(matches.length===1)Object.assign(matches[0],{origin:checkbox.meta.origin,loaded:true,loading:false,unchecked:true,instructions:checkbox.meta.label});
  }finally{await checkbox.dispose();}
 }
 const hosts=await page.locator('iframe').evaluateAll(es=>es.filter(e=>{const r=e.getBoundingClientRect();return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&r.width>16&&r.height>16;}).map(e=>e.src)).catch(()=>[]);
 const pendingHosts=hosts.some(url=>captchaProvider(url)&&!seen.has(url));
 const ocr=frames.length||barrier?null:await imageCaptcha(page);
 let result=classifyCaptcha({frames,pendingHosts,loading:main.loading,staleError:main.staleError,ocr});
 if(barrier){
  const target=result.target;
  if(result.state==='active'&&target?.provider==='turnstile'&&target.sitekey&&target.callback&&!target.managed){target.fullPage=true;}
  else result={state:'unsupported',reason:target?.managed?'Cloudflare Challenge verisi saptandı; proxy gerektiren çözüm bu oturumda yapılandırılmadı.':target?.provider==='turnstile'?'Turnstile görülüyor; sitekey ve doğrulanmış sonuç callback’i birlikte okunamadı. API isteği gönderilmedi.':'Erişim engelinde API ile çözülebilen aktif bir widget doğrulanamadı.'};
 }
 const target=result.target;
 if(target){
  target.questionId=gridQuestion(target.question??'');
  target.identity=captchaHash([main.url,main.origin,target.url,target.origin,target.provider,target.sitekey,target.registration,target.action,target.cdata]);
  target.round=captchaHash([target.identity,target.question,target.images,target.selected,target.src,target.inputIndex,target.label]);
 }
 return {...result,barrier,documentId:main.origin,pageUrl:main.url,frames,pendingHosts};
}

export function captchaEvidence(detection){
 const {state,reason,target}=detection;
 if(state==='none')return null;
 if(state==='cleared')return {state:'cleared',capability:'supported',evidence:reason};
 if(state==='token_present')return {state:'answer_applied',capability:'supported',evidence:reason};
 if(state==='error')return {state:'verification_error',capability:'unknown',evidence:reason};
 if(state==='unknown'||state==='checking')return {state:'checking',capability:'pending',evidence:reason,captchaState:state};
 if(state==='idle')return null; // The existing checkbox affordance handles idle widgets.
 return {state:'required',capability:state==='active'?'solver':'not_exposed',provider:target?.provider,captchaState:state,evidence:reason};
}
