import {createHash,randomUUID} from 'node:crypto';
import {boundedText} from './automation-templates.mjs';

export const SCAN_OVERLAP_MS=24*60*60*1000;
export const FULL_SCAN_INTERVAL_MS=7*24*60*60*1000;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;

// Schedule, provider, table layout and permission changes do not change which
// listings belong to a search. Search criteria do.
export function sourceScanScope(a,url){
 const source=a.sourceSettings?.[url]??{};
 return createHash('sha256').update(JSON.stringify(stable({...(source.instructions?{sourceInstructions:source.instructions}:{}),...(source.tool?{sourceTool:source.tool}:{}),...(source.skill?{sourceSkill:source.skill}:{}),url,query:source.query??a.goal,goal:a.goal,criteria:a.criteria,instructions:a.instructions,facts:a.facts,workflow:a.workflow,templateId:a.templateId,templateVersion:a.templateVersion}))).digest('hex');
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

export const SOURCE_PAGE_INSTRUCTIONS="Page cycle: process one results page (or one newly loaded batch of an unnumbered list) at a time. 1) Save its unprocessed candidate URLs with save_scan_progress and put the exact next-page URL or continuation token in cursor. 2) Reject clear mismatches to the saved criteria from the cards; keep uncertain candidates. 3) Check known URLs with lookup_scan_results, read the remaining relevant details and save each finding at once with record_automation_result (with score and optional scoreReason, eligibility and eligibilityReason when scoring is enabled). 4) Retire saved, reused or rejected URLs with processedUrls. Only then open the next results page or another query. With Jev, checkpointSaved receipts replace these writes, and finish the current detail/review batches before more discovery. Keep unresolved URLs pending and continue the other reachable work. Never collect all result pages first and evaluate later.";
export const SOURCE_SCAN_INSTRUCTIONS=SOURCE_PAGE_INSTRUCTIONS+" Searches: read assignedSource.instructions first; source guidance never grants outgoing actions. Save each planned query/scope with save_scan_searches (resume the existing default queue under id default), select one with select_scan_search, read batches with get_scan_queue, and complete it with complete_scan_search; finish the source only after every search is complete. Never restart a completed search. The queue has no total size limit; pendingUrls is additive and processedUrls removes work explicitly; omission never deletes anything. save_scan_progress accepts your report without snapshot IDs; never reopen a page just to checkpoint. report_scan_page tracks the observed page separately; a recovery visit to an earlier page never resets progress. Coverage plan (scanPlan): full means every accessible results page and relevant detail. incremental starts at the newest results and covers everything through cutoffAt (epoch ms, 24-hour overlap included); it is only a candidate for early stopping. For incremental coverage report chronology on every page from the first: the selected ordering, every card date in display order as absolute ISO publishedAt, and allItemsDated/pageComplete only when true. Relative, missing or ambiguous dates, pinned or out-of-order listings, or unverified ordering mean a full scan. reason=start_unverified means restart coverage at the first results page while keeping saved findings. The tool returns boundary only after a fully processed page is entirely older than cutoffAt with no pending details; then finish with scan.completion=cutoff, otherwise continue to the actual end and use end. Known listing IDs never authorize stopping; recheck their fit when the search changed. user_stop is only for an explicit saved user stopping condition and does not advance the watermark. Interrupted work resumes its checkpoint with the original cutoff and start time. After a week a full scan is required again. These are coverage rules, not a time or step budget.";
