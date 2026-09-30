import {createHash,randomUUID} from 'node:crypto';

export const SCAN_OVERLAP_MS=24*60*60*1000;
export const FULL_SCAN_INTERVAL_MS=7*24*60*60*1000;
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;

// Schedule, provider, table layout and permission changes do not change which
// listings belong to a search. Search criteria do.
export function sourceScanScope(a,url){
 return createHash('sha256').update(JSON.stringify(stable({url,query:a.sourceSettings?.[url]?.query??a.goal,goal:a.goal,criteria:a.criteria,instructions:a.instructions,facts:a.facts,workflow:a.workflow,templateId:a.templateId,templateVersion:a.templateVersion}))).digest('hex');
}

export function beginSourceScan(saved,scopeKey,now){
 const state=saved?.scopeKey===scopeKey?saved:{scopeKey};
 if(state.active)return state; // Keep the original start and cutoff on recovery.
 const full=state.lastSuccessfulStartAt==null||state.lastFullScanAt==null||now-state.lastFullScanAt>=FULL_SCAN_INTERVAL_MS;
 return {...state,active:{id:randomUUID(),scopeKey,startedAt:now,mode:full?'full':'incremental',cutoffAt:full?null:state.lastSuccessfulStartAt-SCAN_OVERLAP_MS,overlapMs:SCAN_OVERLAP_MS,reason:state.lastSuccessfulStartAt==null?'initial':full?'periodic':'new_listings',order:null,boundary:null}};
}

const normalized=value=>String(value??'').replace(/\s+/gu,' ').trim();
export function observedScanQuote(snapshot,value){
 if(typeof value!=='string'||!value.trim()||value.length>2000)throw Error('Kısa ve gerçek sayfa kanıtı gerekli.');
 let text=snapshot.text;
 try{const page=JSON.parse(text.replace(/^Page URL: [^\n]+\n/,''));text=JSON.stringify(page);}catch{}
 if(!normalized(text).includes(normalized(value)))throw Error('Tarama kanıtı güncel sayfa gözleminde bulunamadı.');
 return value.trim();
}

// Only absolute dates can establish a cutoff. Ambiguous/relative/localized
// dates fall back to full coverage. Date-only values get a conservative upper
// bound covering the entire day in every timezone.
function publishedUpperBound(item,snapshot){
 const quote=observedScanQuote(snapshot,item.evidence),value=item.publishedAt;
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))return null;
 const at=Date.parse(value),shown=Date.parse(quote);
 if(!Number.isFinite(at)||!Number.isFinite(shown)||at!==shown)return null;
 return value.length===10?at+38*60*60*1000:at;
}

export function advanceSourceScan(plan,{chronology,pendingUrls,cursor,reason},snapshot,runId,now){
 if(!plan)throw Error('Kaynak tarama planı bulunamadı.');
 let next={...plan,boundary:null,checkpoint:{url:snapshot.url,pendingUrls,reason,at:now,...(cursor?{cursor:observedScanQuote(snapshot,cursor)}:{})}};
 if(plan.mode==='full')return next;
 const fallback=reason=>({...next,mode:'full',reason,order:null,boundary:null});
 if(!chronology?.newestFirst)return fallback('ordering_unverified');
 const evidence=observedScanQuote(snapshot,chronology.evidence);
 if(!plan.order&&!chronology.fromStart)return fallback('start_unverified');
 const dates=chronology.items??[];
 if(!chronology.allItemsDated||!dates.length||dates.length>100)return fallback('dates_unverified');
 const times=dates.map(item=>publishedUpperBound(item,snapshot));
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

export const SOURCE_SCAN_INSTRUCTIONS='Use save_scan_searches to persist each planned query/scope separately; resume an existing default queue under id default. Select one with select_scan_search and use get_scan_queue for batches. Never restart completed searches. Save pending URLs in additive batches and explicitly remove processed/rejected URLs with processedUrls. There is no 100-URL total queue limit. report_scan_page tracks observation separately from pending work: a recovery visit to an earlier page never resets progress. Complete each search with complete_scan_search, then finish the source after all searches are complete. Prioritise strong candidates using the saved template criteria without changing hard constraints. Follow scanPlan. full means all accessible result pages and relevant details. incremental starts at the newest results and covers everything through cutoffAt (epoch milliseconds, including a 24-hour overlap). It is only a candidate for early stopping: verify newest-first ordering on the actual site. Save progress before leaving each results page with save_scan_progress, including unprocessed detail/next-page URLs and an observed cursor if any. For incremental coverage report chronology for every page from the first: quote the selected ordering, report every card date in display order, and mark allItemsDated/pageComplete only when true. publishedAt uses an absolute ISO date/time; evidence is the exact displayed date. Relative, missing or ambiguous dates, pinned/out-of-order listings or unverified ordering require a full scan. If reason=start_unverified, restart coverage at the first results page while preserving saved findings. Known IDs may have been saved for different criteria: recheck their fit when the search changes. The tool returns boundary only after a fully processed page is entirely older than cutoffAt with no pending details. Then finish with scan.completion=cutoff; otherwise continue to the actual end and use end. Known listing IDs alone never authorize stopping. Use user_stop only for an explicit saved user stopping condition; that does not advance the scan watermark. Interrupted work resumes the saved checkpoint with the original cutoff and start time. After a week a full scan is required again. This is a coverage rule, not a time or step budget.';
