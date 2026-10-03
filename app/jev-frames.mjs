import {usableFormFrame} from './jev-frame-actions.mjs';
import {observedId} from './jev-ids.mjs';
export async function captureEmbeddedForms(slot){
 const previous=slot.embeddedFrames??new Map();slot.embeddedFrames=new Map();const frames=[];
 for(const frame of slot.page.frames().filter(f=>f!==slot.page.mainFrame())){
  const rawUrl=frame.url();if(!await usableFormFrame(frame,slot.page).catch(()=>false))continue;
  let element;
  try{
   element=await frame.frameElement();
   const url=rawUrl||await element.evaluate(e=>e.src);
   const visible=await element.evaluate(e=>!e.hasAttribute('sandbox')&&!/captcha|challenge/i.test(e.title+' '+e.id)&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&e.getBoundingClientRect().width>1&&e.getBoundingClientRect().height>1);
   if(!visible)continue;
   const kind=await frame.evaluate(()=>({form:!!document.querySelector('input:not([type="hidden"]):not([type="password"]),select,textarea,form'),links:!!document.querySelector('a[href]'),password:!!document.querySelector('input[type="password"]')}));
   if(kind.password||!kind.form&&!kind.links)continue;
   const id=[...previous].find(([,s])=>s.frame===frame&&s.url===url&&s.owner===slot.owner)?.[0]??observedId('frame');
   slot.embeddedFrames.set(id,{frame,url,rawUrl,owner:slot.owner});frames.push({frameId:id,url,inPlace:true,hasForm:kind.form,nextAction:'browser_open url'});
  }catch{}finally{await element?.dispose().catch(()=>{});}
 }
 return frames;
}
export async function embeddedFormTarget(slot,frameId,owner){
 const saved=slot.embeddedFrames?.get(frameId);
 if(!saved||saved.owner!==owner)throw Error('Güncel embeddedForms listesindeki frameId gerekli.');
 await captureEmbeddedForms(slot);
 if(!slot.embeddedFrames.has(frameId))throw Error('Gömülü form değişti veya erişilebilir değil; yeniden açılmadı.');
 return saved.url;
}
