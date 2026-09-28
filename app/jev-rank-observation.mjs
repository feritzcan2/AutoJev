import {rankActionAllowed} from './task-scope.mjs';

// Read rendered text, including below the fold. Never inspect hidden app state,
// JSON-LD or form values. Loading/virtualized content may still need a scroll.
export async function readRankText(page,limit=60000){
 const sections=[];let remaining=limit,truncated=false,unreadFrames=0;
 for(const frame of page.frames()){
  if(frame!==page.mainFrame()){
   const element=await frame.frameElement().catch(()=>null);
   if(!element){unreadFrames++;continue;}
   const visible=await element.isVisible().catch(()=>false);await element.dispose();
   if(!visible)continue;
  }
  try{
   const part=await frame.evaluate(max=>{
    const body=document.body;
    const text=body&&getComputedStyle(body).display!=='none'?body.innerText.trim():'';
    return {text:text.slice(0,max),truncated:text.length>max};
   },remaining);
   if(part.text)sections.push(part.text);
   remaining-=part.text.length;truncated||=part.truncated;
  }catch{unreadFrames++;}
 }
 return {text:sections.join('\n\n'),truncated,unreadFrames};
}

export async function presentRankObservation(slot,value,{restore=false}={}){
 // Non-observation error/decision receipts must keep their existing contract.
 if(!value.observationId)return value;
 const reading=await readRankText(slot.page);
 const previous=slot.rankReading;
 const unchanged=!restore&&previous?.owner===slot.owner&&previous.url===value.url&&previous.text===reading.text;
 slot.rankReading={owner:slot.owner,url:value.url,text:reading.text};
 const out={...value,observationMode:'rank',controlMaps:'replace',mapDeltas:false,
  controls:[],fillFields:[],clickTargets:(value.clickTargets??[]).filter(t=>rankActionAllowed({...t,kind:'click'})),
  reading:{scope:'rendered_document',truncated:reading.truncated,unreadFrames:reading.unreadFrames,
   guidance:'Read this posting text before scoring. It includes loaded content below the fold. Scroll only for missing requirements, lazy-loaded content or a truncated/unread section; do not scroll merely to cover the viewport.'}};
 for(const key of ['elements','passwordFields','accountCredentials','uploads','history','textUnchanged','text'])delete out[key];
 if(reading.text){if(unchanged)out.textUnchanged=true;else out.text=reading.text;}
 else {out.text=value.text;out.reading.guidance='No document text available; inspect loading, overlays or the current viewport before scoring.';}
 // Truncation must retain viewport evidence so scrolling can reach omitted text.
 const viewport=value.text??slot.presented?.text;
 const normalize=text=>text.replace(/\s+/g,' ').trim();
 const normalized=normalize(reading.text);
 // Snapshot text can include shadow-root content absent from body.innerText.
 if(reading.truncated||reading.unreadFrames||viewport&&viewport.split('\n').some(line=>line.trim()&&!normalized.includes(normalize(line))))out.viewportText=viewport;
 return out;
}
