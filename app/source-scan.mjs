import {createHash,randomUUID} from 'node:crypto';
import {boundedText} from './automation-templates.mjs';

export const SCAN_OVERLAP_MS=24*60*60*1000;
export const FULL_SCAN_INTERVAL_MS=7*24*60*60*1000;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;

// Schedule, provider, table layout and permission changes do not change which
// listings belong to a search. Search criteria do.
export function sourceScanScope(a,url){
 const source=a.sourceSettings?.[url]??{};
 return createHash('sha256').update(JSON.stringify(stable({...(source.instructions?{sourceInstructions:source.instructions}:{}),...(source.skill?{sourceSkill:source.skill}:{}),url,query:source.query??a.goal,goal:a.goal,criteria:a.criteria,instructions:a.instructions,facts:a.facts,workflow:a.workflow,templateId:a.templateId,templateVersion:a.templateVersion}))).digest('hex');
}

export function beginSourceScan(saved,scopeKey,now){
 const state=saved?.scopeKey===scopeKey?saved:{scopeKey};
 if(state.active)return state; // Keep the original start and cutoff on recovery.
 const full=state.lastSuccessfulStartAt==null||state.lastFullScanAt==null||now-state.lastFullScanAt>=FULL_SCAN_INTERVAL_MS;
 return {...state,active:{id:randomUUID(),scopeKey,startedAt:now,mode:full?'full':'incremental',cutoffAt:full?null:state.lastSuccessfulStartAt-SCAN_OVERLAP_MS,overlapMs:SCAN_OVERLAP_MS,reason:state.lastSuccessfulStartAt==null?'initial':full?'periodic':'new_listings',order:null,boundary:null}};
}

// Only absolute dates can establish a cutoff. Ambiguous/relative/localized
// dates fall back to full coverage. Date-only values get a conservative upper
// bound covering the entire day in every timezone.
function publishedUpperBound(item){
 const value=item.publishedAt;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))return null;
 const at=Date.parse(value);
 if(!Number.isFinite(at))return null;
 return value.length===10?at+38*60*60*1000:at;
}

export function advanceSourceScan(plan,{chronology,pendingUrls,cursor,reason},snapshot,runId,now){
 if(!plan)throw Error('Kaynak tarama planı bulunamadı.');
 let next={...plan,boundary:null,checkpoint:{url:snapshot.url,pendingUrls,reason,at:now,...(cursor?{cursor:boundedText(cursor,'Devam işareti',2000)}:{})}};
 if(plan.mode==='full')return next;
 const fallback=reason=>({...next,mode:'full',reason,order:null,boundary:null});
 if(!chronology?.newestFirst)return fallback('ordering_unverified');
 if(!plan.order&&!chronology.fromStart)return fallback('start_unverified');
 const dates=chronology.items??[];
 if(!chronology.allItemsDated||!dates.length||dates.length>100)return fallback('dates_unverified');
 let evidence,times;
 try{
  evidence=boundedText(chronology.evidence,'Tarih sıralaması açıklaması',2000);
  times=dates.map(publishedUpperBound);
 }catch{return fallback('chronology_unverified');}
 if(times.some(t=>t===null))return fallback('dates_unverified');
 if(times.some((at,index)=>index>0&&at>times[index-1]))return fallback('ordering_changed');
 const newest=times[0],oldest=times.at(-1),previous=plan.order;
 if(previous&&previous.url!==snapshot.url&&newest>previous.oldest)return fallback('ordering_changed');
 // Incomplete pages can checkpoint, but never authorize an early finish.
 next.order={evidence,runId,url:snapshot.url,oldest:chronology.pageComplete?oldest:previous?.oldest??newest};
 if(chronology.pageComplete&&newest<plan.cutoffAt&&!pendingUrls.length)next.boundary={url:snapshot.url,runId,newestPublishedAt:newest,at:now};
 return next;
}

export function validateScanCompletion(plan,scan,pageProgress,runId){
 const completion=scan.completion??'end';
 if(!['end','cutoff','user_stop'].includes(completion))throw Error('Geçersiz tarama bitişi.');
 if(completion==='cutoff'&&(plan?.mode!=='incremental'||!plan.boundary||plan.boundary.runId!==runId||plan.boundary.url!==scan.evidenceUrl||plan.checkpoint?.pendingUrls.length))throw Error('Tarih sınırı doğrulanmadı. En yeniden başlayıp tüm sayfayı işle; güvenilir sıralama ve tarih yoksa son sayfaya devam et.');
 if(completion==='end'&&pageProgress?.totalPages&&pageProgress.currentPage<pageProgress.totalPages)throw Error('Son sayfaya henüz ulaşılmadı. Kalan sayfaları işle veya doğrulanmış tarih sınırını bildir.');
 return completion;
}

export function completeSourceScan(state,plan,completion,now){
 if(!state?.active||state.active.id!==plan?.id||state.scopeKey!==plan.scopeKey)return state;
 const completed={...state,active:null,lastCompleted:{...plan,completion,finishedAt:now}};
 if(completion==='user_stop')return completed;
 return {...completed,lastSuccessfulStartAt:plan.startedAt,lastSuccessfulAt:now,...(completion==='end'?{lastFullScanAt:now}:{})};
}

export const SOURCE_PAGE_INSTRUCTIONS="Page cycle: work one results page at a time. 1) Run browser_jev_run scan_results on the results page; Jev saves its listing links to the pending queue and the page number (checkpointSaved=true). 2) Run browser_jev_run collect_details without URLs; Jev reads the pending queue and classifies each listing. 3) In every review batch read briefs with read_jev_brief evidenceIds and save suitable listings together with record_automation_results (with score, optional scoreReason, eligibility and eligibilityReason when scoring is enabled) and reject or defer the rest. Saved and rejected listings leave the queue automatically. 4) Follow the observed next page and repeat. Never collect all result pages first and evaluate later.";
export const SOURCE_SCAN_INSTRUCTIONS=SOURCE_PAGE_INSTRUCTIONS+" Coverage: read assignedSource.instructions first; source guidance never grants outgoing actions. Run scan_results once per saved query or filter set; the pending queue is shared and has no size limit. get_scan_queue shows the pending count. When the queue is empty and the last results page was observed, call complete_scan_search with completion=end, then finish_automation_run. scanPlan may show an incremental plan with cutoffAt; without verified dates the app treats it as a full scan, so cover the board to its observed end. Known listing IDs never authorize stopping. user_stop is only for an explicit saved user stopping condition. Interrupted work resumes from the saved queue and page. These are coverage rules, not a time or step budget.";
