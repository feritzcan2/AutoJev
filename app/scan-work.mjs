import {webUrl,boundedText} from './automation-templates.mjs';
import {validateScanCompletion} from './source-scan.mjs';
import {siteKey} from './site-access.mjs';

export function scanWork(run){
 if(run.scan?.work)return structuredClone(run.scan.work);
 return {activeSearchId:'default',searches:[{id:'default',label:'Kaynak taraması',status:'pending',pendingUrls:[...(run.scan?.pendingUrls??[])],processedUrls:[],pageProgress:run.pageProgress??null,plan:run.scanPlan??null}]};
}
export const activeSearch=work=>work.searches.find(s=>s.id===work.activeSearchId);
export function pendingScanUrls(work){return [...new Set(work.searches.flatMap(s=>s.pendingUrls))];}
export function hasUnblockedScanWork(run,sites){
 const blocked=new Set(sites),work=scanWork(run);
 // Undiscovered searches still use the assigned source. A source-wide gate
 // must release the worker even when those searches have empty queues.
 if(run.sourceUrl&&blocked.has(siteKey(run.sourceUrl)))return false;
 return work.searches.some(s=>s.status!=='completed'&&(s.pendingUrls.some(url=>!blocked.has(siteKey(url)))||s.id!==work.activeSearchId&&!s.pendingUrls.length));
}
export function withScanWork(run,work,patch={}){
 return {...run.scan,...patch,complete:false,pendingUrls:pendingScanUrls(work),work};
}
export function scanQueue(run,{searchId,offset=0,limit=100}={}){
 const work=scanWork(run),search=work.searches.find(s=>s.id===(searchId??work.activeSearchId));
 if(!search)throw Error('Tarama araması bulunamadı.');
 if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Kuyruk aralığı geçersiz; en fazla 100 adres oku.');
 return {searchId:search.id,label:search.label,status:search.status,pageProgress:search.pageProgress,checkpoint:scanPlanView(search.plan)?.checkpoint??null,total:search.pendingUrls.length,offset,pendingUrls:search.pendingUrls.slice(offset,offset+limit),nextOffset:offset+limit<search.pendingUrls.length?offset+limit:null,processedCount:search.processedUrls.length};
}
export function scanWorkSummary(run){
 const work=scanWork(run);
 return {activeSearchId:work.activeSearchId,searches:work.searches.map(({id,label,status,pendingUrls,processedUrls,pageProgress,completion})=>({id,label,status,pendingCount:pendingUrls.length,processedCount:processedUrls.length,pageProgress,completion})),queue:scanQueue(run)};
}
export function reportWorkPage(run,pageProgress){
 const work=scanWork(run),search=activeSearch(work),previous=search.pageProgress;
 // A lower page can be visited to recover access. It is not a new checkpoint.
 if(search.status==='completed')throw Error('Bu arama tamamlandı; kalan aramayı seç.');
 const revisiting=Boolean(previous&&pageProgress.currentPage<previous.currentPage);
 if(!revisiting){
  search.pageProgress=pageProgress;
  if(!search.processedUrls.includes(pageProgress.url)&&!search.pendingUrls.includes(pageProgress.url))search.pendingUrls.push(pageProgress.url);
 }
 return {work,pageProgress:search.pageProgress,revisiting};
}
export function updateScanQueue(run,input){
 const work=scanWork(run),search=activeSearch(work);
 if(search.status==='completed')throw Error('Tamamlanan aramaya yeni iş eklenemez. Kalan aramayı seç.');
 const processed=input.processedUrls??[];
 if(!Array.isArray(processed)||processed.length>100)throw Error('Bir seferde en fazla 100 işlenmiş adres kaydet.');
 const additions=[...new Set(input.pendingUrls.map(webUrl))],done=[...new Set(processed.map(webUrl))];
 if(done.some(url=>additions.includes(url)))throw Error('Bir adres aynı anda bekleyen ve işlenmiş olamaz.');
 search.processedUrls=[...new Set([...search.processedUrls,...done])];
 search.pendingUrls=[...new Set([...search.pendingUrls,...additions])].filter(url=>!search.processedUrls.includes(url));
 return work;
}
export function completeScanSearch(run,completion,evidenceUrl){
 const work=scanWork(run),search=activeSearch(work);
 if(search.pendingUrls.length)throw Error(`${search.pendingUrls.length} bekleyen adres var; arama tamamlanamaz.`);
 validateScanCompletion(run.scanPlan,{complete:true,pendingUrls:[],completion,evidenceUrl},search.pageProgress,run.id);
 search.status='completed';search.completion=completion;search.plan=run.scanPlan;
 return work;
}
export function assertScanWorkFinished(run){
 if(!run.scan?.work)return;
 const work=scanWork(run);
 if(pendingScanUrls(work).length)throw Error('Bekleyen sayfa veya kayıtlar var. İşlenen adresleri processedUrls ile kaydet.');
 if(work.searches.length>1&&work.searches.some(s=>s.status!=='completed'))throw Error('Kayıtlı aramaların tamamı bitmedi; kalan aramayı complete_scan_search ile tamamla.');
}
export function otherScanSearchesPending(run){
 return Boolean(run.scan?.work?.searches.some(s=>s.id!==run.scan.work.activeSearchId&&s.status!=='completed'));
}

export function scanPlanView(plan){
 if(!plan||!plan.checkpoint?.pendingUrls||plan.checkpoint.pendingUrls.length<=100)return plan;
 return {...plan,checkpoint:{...plan.checkpoint,pendingUrls:plan.checkpoint.pendingUrls.slice(0,100),pendingCount:plan.checkpoint.pendingUrls.length,nextOffset:100}};
}
export function validateWorkCompletion(run,scan){
 if((run.scan?.work?.searches.length??0)<=1){
  const completion=validateScanCompletion(run.scanPlan,scan,run.pageProgress,run.id);assertScanWorkFinished(run);return completion;
 }
 assertScanWorkFinished(run);
 const completions=run.scan.work.searches.map(s=>s.completion);
 const expected=completions.includes('user_stop')?'user_stop':completions.includes('cutoff')?'cutoff':'end';
 if((scan.completion??'end')!==expected)throw Error(`Aramaların doğrulanan ortak bitişi: ${expected}.`);
 return expected;
}

export function scanProgressView(run){
 if(!run.scan)return null;
 const {work,...scan}=run.scan;
 if(!work&&scan.pendingUrls.length<=100)return scan;
 return {...scan,pendingUrls:scan.pendingUrls.slice(0,100),pendingCount:scan.pendingUrls.length,nextOffset:scan.pendingUrls.length>100?100:null};
}
