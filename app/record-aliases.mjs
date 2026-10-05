import {recordUrlKey} from './record-identity.mjs';

// Only task-owned, completed detail reads can establish an alternate address.
// A redirect to a results/login page or an incomplete load is not identity.
export function observedRecordAliases(db,owner,run,url){
 const key=recordUrlKey(url),aliases=[url,...(db.browserEvidence?.aliases(run,url)??[])];
 const searchId=run.scan?.work?.activeSearchId??'default';
 for(const task of db.jevTasks.list(owner,run.taskId??run.id)){
  if(task.input.operation!=='collect_details'||(task.searchId??'default')!==searchId)continue;
  for(const item of task.items){
   if(!item.collected||item.detailComplete===false||item.error||item.pageKind==='results'||!item.triage?.decisions?.some(d=>d.raw==='possible'&&d.confidence>=0.85)||!item.evidenceId)continue;
   let page;try{page=db.jevTasks.fullEvidence(owner,run.taskId??run.id,item.evidenceId,task.id);}catch{continue;}
   const urls=[item.url,...(item.aliases??[]),page.url,page.canonicalUrl].filter(u=>recordUrlKey(u));
   if(urls.some(u=>recordUrlKey(u)===key))aliases.push(...urls);
  }
 }
 return [...new Set(aliases.filter(u=>recordUrlKey(u)))];
}
