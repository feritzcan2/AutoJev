import {scanWork,activeSearch,withScanWork} from './scan-work.mjs';
import {JEV_CLASSIFICATION_VERSION,JEV_TRIAGE_CONFIDENCE,EXCLUSION_REASONS} from './jev-triage.mjs';
import {jevDetailKey} from './jev-detail-urls.mjs';

export const jevReviewRequired=message=>Object.assign(Error(message),{code:'JEV_REVIEW_REQUIRED'});

// Numbers refer to the current batch order, including across index pages.
// Normalize legacy URL selectors too, so deferred work retains its decision.
export function resolveJevReview(items,decisions=[]){
 const keys=new Map(items.flatMap((item,index)=>[item.url,...(item.aliases??[])].map(url=>[jevDetailKey(url),index]))),seen=new Map();
 if(!Array.isArray(decisions)||decisions.length>20)throw jevReviewRequired('review en fazla 20 karar içeren bir liste olmalı.');
 return decisions.map((decision,position)=>{
  const fail=message=>{throw jevReviewRequired(`review[${position}]: ${message} Güncel grup için read_jev_task(taskId, batchId, limit:20) kullan; kararı item numarasıyla gönder.`);};
  if(!decision||typeof decision!=='object'||Array.isArray(decision))fail('Karar bir nesne olmalı.');
  const numbered=decision.item!==undefined,byUrl=decision.url!==undefined;
  if(numbered===byUrl)fail('Tek bir ilan seç: item veya eski biçimde url.');
  let index;
  if(numbered){
   if(!Number.isInteger(decision.item)||decision.item<1||decision.item>items.length)fail(`item bu grubun 1–${items.length} aralığında olmalı; verilen: ${String(decision.item).slice(0,30)}.`);
   index=decision.item-1;
  }else{
   try{index=keys.get(jevDetailKey(decision.url));}catch{}
   if(index===undefined)fail('URL bu grubun ilanlarından biriyle eşleşmiyor.');
  }
  if(seen.has(index))fail(`item ${index+1} zaten review[${seen.get(index)}] içinde seçildi; tek karar gönder.`);
  if(!['reject','defer'].includes(decision.decision)||typeof decision.reason!=='string'||!decision.reason.trim()||decision.reason.length>1500)fail(`item ${index+1} için decision reject/defer ve 1–1500 karakterlik reason olmalı.`);
  seen.set(index,position);
  return {url:items[index].url,decision:decision.decision,reason:decision.reason};
 });
}

// A local review can retire saved records or explicitly acknowledged exclusions.
// It cannot manufacture a new browser observation or complete source coverage.
export function reviewJevBatch(db,owner,runId,taskId,batchId,decisions=[]){
 return db.store.workspaces.tasks.atomic(()=>{
  const run=db.activeRun(owner,runId),scope=run.taskId??run.id,task=db.jevTasks.get(owner,scope,taskId);
  if(task.searchId!==(run.scan?.work?.activeSearchId??'default')||task.batch?.id!==batchId||task.classificationVersion!==JEV_CLASSIFICATION_VERSION)throw Error('İnceleme grubu güncel göreve ve aramaya ait olmalı.');
  const items=task.batch.urls.map(url=>task.items.find(i=>i.url===url));
  const review=resolveJevReview(items,decisions),choices=new Map(review.map(decision=>[jevDetailKey(decision.url),decision]));
  const known=db.db.prepare("SELECT 1 FROM workspace_records WHERE workspace_id=? AND json_extract(data,'$.url') IN (?,?) AND NOT coalesce(json_extract(data,'$.trial'),0) LIMIT 1");
  const missing=[],deferred=new Set();
  for(const [index,item] of items.entries()){
   const key=jevDetailKey(item.url),decision=choices.get(key);
   if(decision?.decision==='defer'){deferred.add(key);continue;}
   if(!item?.collected||!item.assessment||item.pageKind==='results'||item.error)throw Error('Eksik ilan inceleme grubundan çıkarılamaz.');
   const evidence=db.jevTasks.fullEvidence(owner,scope,item.evidenceId);
   if(decision?.decision==='reject')continue;
   if(item.assessment.decision==='mismatch'){
    const proof=item.assessment.exclusion;
    if(!(item.assessment.confidence>=JEV_TRIAGE_CONFIDENCE)||!proof||!(proof.confidence>=JEV_TRIAGE_CONFIDENCE)||!Object.hasOwn(EXCLUSION_REASONS,proof.reason)||proof.reason==='none'||proof.evidenceId!==item.evidenceId)throw Error('Uyumsuz ilan için bu ilana ait en az %85 güvenli eleme değerlendirmesi gerekli.');
   }else if(![item.url,...(item.aliases??[])].some(url=>known.get(owner,url,evidence.url)))missing.push(index+1);
  }
  if(missing.length)throw jevReviewRequired('İnceleme tamamlanmadı: uygun ilanları önce record_automation_result ile kaydet; uygun olmayanlar için review=[{item,decision:"reject",reason}], okunamayanlar için decision:"defer" gönder. Karar bekleyen item numaraları: '+missing.join(', ')+'. %85 güvenli Jev mismatch kararlarını tekrar yazma; grup onayı yeterli.');
  if(run.kind==='run'&&run.sourceUrl&&!run.recordId){
   const work=scanWork(run),search=activeSearch(work),doneKeys=new Set(items.filter(i=>!deferred.has(jevDetailKey(i.url))).flatMap(i=>[i.url,...(i.aliases??[])].map(jevDetailKey)));
   const done=new Set([...items.filter(i=>doneKeys.has(jevDetailKey(i.url))).flatMap(i=>[i.url,...(i.aliases??[])]),...search.pendingUrls.filter(url=>doneKeys.has(jevDetailKey(url)))]);
   search.pendingUrls=search.pendingUrls.filter(url=>!doneKeys.has(jevDetailKey(url)));
   search.processedUrls=[...new Set([...search.processedUrls,...done])];
   const scanPlan=run.scanPlan?{...run.scanPlan,boundary:null,...(run.scanPlan.checkpoint?{checkpoint:{...run.scanPlan.checkpoint,pendingUrls:[...search.pendingUrls]}}:{})}:run.scanPlan;search.plan=scanPlan??search.plan;
   db.persistScan(owner,{...run,scanPlan,scan:withScanWork(run,work,{reason:'Jev grubu incelendi; kayıtlı ilanlar ve kanıtlı elemeler işlendi.'})});
  }
  return review;
 });
}
