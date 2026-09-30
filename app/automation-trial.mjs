// Legacy workspace metadata is retained for history; a skip never validates a source.
export const automationTrialReady=a=>a.trial?.revision===a.revision&&['passed','skipped'].includes(a.trial?.status);
export const automationReady=a=>a.reviewedRevision===a.revision;
export const sourceTrialReady=(a,url)=>a.sourceState?.[url]?.trial?.status==='passed';

// Adopt only sources covered by a successful historical trial or scan. A
// workspace-wide skip is not source evidence, nor does it cover new URLs.
export function migrateSourceTrials(store){
 store.store.workspaces.tasks.atomic(()=>{
  for(const a of store.list()){
   if(a.sourceTrialsVersion===1)continue;
   const sourceState={...a.sourceState};
   const runs=store.db.prepare("SELECT data FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.status')='completed' ORDER BY rowid DESC").all(a.id).map(row=>JSON.parse(row.data));
   for(const url of a.sources){
    if(sourceState[url]?.trial)continue;
    const run=runs.find(r=>!r.recordId&&!r.recordOperation&&(r.kind==='trial'&&a.trial?.status==='passed'&&r.id===a.trial.runId&&(r.sources??[]).includes(url)||r.kind==='run'&&(r.sourceUrl===url||r.sources?.length===1&&r.sources[0]===url)));
    if(run)sourceState[url]={...sourceState[url],trial:{status:'passed',runId:run.id,at:run.finishedAt}};
   }
   store.put({...a,sourceState,sourceTrialsVersion:1});
  }
 });
}
