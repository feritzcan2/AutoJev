// Browser text and queue internals belong to execution, not UI refreshes.
// Keep the last observed URL for blocked-source navigation.
export function runSnapshot(run){
 const {scan,scanPlan,navigation,observedLinks,observations,jevTask,...summary}=run;
 const url=observations?.at(-1)?.url;
 return {...summary,observations:url?[{url}]:[]};
}
export function taskSnapshot(task){
 const {scan,scanPlan,continuation,...summary}=task;
 return summary;
}
