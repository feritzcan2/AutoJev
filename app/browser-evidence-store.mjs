import {listingIdentity} from './job-urls.mjs';
const sameUrl=(a,b)=>a===b||Boolean(listingIdentity(a)?.key&&listingIdentity(a)?.key===listingIdentity(b)?.key);
const scope=run=>JSON.stringify([run.automationId,run.taskId??run.id,run.scan?.work?.activeSearchId??'default',run.recordId??'']);

// Bounded RAM cache only. A new app process starts empty; pages are read again.
export class BrowserEvidenceStore {
 constructor(now=Date.now){this.now=now;this.pages=new Map();}
 save(run,page){
  if(!page?.text?.trim()||page.text.length>1000000||this.pages.has(page.id))return;
  this.pages.set(page.id,{owner:run.automationId,taskId:run.taskId??run.id,scope:scope(run),value:structuredClone({...page,runId:run.id,at:this.now()})});
  const owned=[...this.pages].filter(([,row])=>row.owner===run.automationId);
  for(const [id] of owned.slice(0,Math.max(0,owned.length-64)))this.pages.delete(id);
 }
 get(run,id){const row=this.pages.get(id);return row?.scope===scope(run)?structuredClone(row.value):null;}
 known(id){return this.pages.has(id);}
 latest(run,url){return structuredClone([...this.pages.values()].reverse().find(row=>row.scope===scope(run)&&sameUrl(row.value.url,url))?.value??null);}
 release(owner,taskId){for(const [id,row] of this.pages)if(row.owner===owner&&(taskId===undefined||row.taskId===taskId))this.pages.delete(id);}
}
