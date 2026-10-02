import {listingIdentity} from './job-urls.mjs';

// Scoring can reuse text held by this app process. After the app closes, a
// resumed task must read the listing again; old run excerpts are not a cache.
export function assessmentEvidence(db,owner,run,requestedUrl){
 if(run.automationId!==owner)return null;
 const identity=listingIdentity(requestedUrl)?.key;
 const matches=url=>url===requestedUrl||Boolean(identity&&listingIdentity(url)?.key===identity);
 const current=run.observations.findLast(o=>o.evidence?.trim()&&matches(o.url));
 if(current)return current;
 const cached=db.browserEvidence?.latest(run,requestedUrl);
 if(cached)return {url:cached.url,at:cached.at,evidence:cached.text};
 const detail=memoryDetail(db,owner,run,requestedUrl);
 return detail?{url:detail.url,at:detail.at,evidence:detail.text}:null;
}

export function assessmentListingText(db,owner,run,url){
 if(run.automationId!==owner)return '';
 const identity=listingIdentity(url)?.key,matches=value=>value===url||Boolean(identity&&listingIdentity(value)?.key===identity);
 const current=db.scoringListingTexts?.get(run.id);
 if(current?.owner===owner&&matches(current.url))return current.text;
 const cached=db.browserEvidence?.latest(run,url);if(cached)return cached.text;
 const detail=memoryDetail(db,owner,run,url);if(detail)return detail.text;
 return assessmentEvidence(db,owner,run,url)?.evidence??'';
}

function memoryDetail(db,owner,run,url){
 if(!run.taskId)return null;
 const searchId=run.scan?.work?.activeSearchId??'default',identity=listingIdentity(url)?.key;
 const matches=value=>value===url||Boolean(identity&&listingIdentity(value)?.key===identity),details=[];
 for(const task of db.jevTasks.list(owner,run.taskId)){
  if((task.searchId??'default')!==searchId||task.input.operation!=='collect_details')continue;
  for(const item of task.items){
   if(!item.collected||item.detailComplete===false||item.pageKind==='results'||item.error||!item.evidenceId)continue;
   let evidence;try{evidence=db.jevTasks.fullEvidence(owner,run.taskId,item.evidenceId,task.id);}catch{continue;}
   if(evidence.text?.trim()&&matches(evidence.url))details.push(evidence);
  }
 }
 return details.sort((a,b)=>b.at-a.at)[0]??null;
}
