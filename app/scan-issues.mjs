import {randomUUID} from 'node:crypto';

export const sourceScan=run=>run.kind==='run'&&run.sourceUrl&&!run.recordId&&!run.actionId;
export function scanIssue(db,id,runId,{url,kind,evidence,verified=false,global=false}){
 const run=db.activeRun(id,runId);if(!sourceScan(run))return null;
 const previous=run.scanIssues?.[url],attempts=previous?.kind===kind?previous.attempts+1:1;
 const issue={id:randomUUID(),url,kind,evidence:String(evidence).slice(0,2000),attempts,verified:verified||kind==='browser_error'&&attempts>=2,global,at:db.now()};
 db.putRun({...run,scanIssues:{...run.scanIssues,[url]:issue}});return issue;
}
export function clearScanIssue(db,id,runId,url){
 const run=db.activeRun(id,runId),scanIssues={...run.scanIssues};
 for(const [key,issue]of Object.entries(scanIssues))if(key===url||issue.global)delete scanIssues[key];
 if(Object.keys(scanIssues).length!==Object.keys(run.scanIssues??{}).length)db.putRun({...run,scanIssues});
}
export function browserFailure(error){
 const text=String(error.message??error);
 if(!/timeout|timed out|zaman aşımı|net::|ERR_[A-Z_]+|ECONN|Execution context was destroyed|interrupted by another navigation|Cannot find context with specified id|Sayfa gözlemi alınamadı|disconnected|connection.*closed|Chrome bağlantısı|BROWSER_DISCONNECTED/i.test(text))return null;
 return {kind:'browser_error',evidence:text,global:/disconnected|connection.*closed|Chrome bağlantısı|BROWSER_DISCONNECTED/i.test(text)};
}
