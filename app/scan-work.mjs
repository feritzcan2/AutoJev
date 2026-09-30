import {webUrl,boundedText} from './automation-templates.mjs';
import {validateScanCompletion} from './source-scan.mjs';

export function scanWork(run){
 if(run.scan?.work)return structuredClone(run.scan.work);
 return {activeSearchId:'default',searches:[{id:'default',label:'Kaynak taraması',status:'pending',pendingUrls:[...(run.scan?.pendingUrls??[])],processedUrls:[],pageProgress:run.pageProgress??null,plan:run.scanPlan??null}]};
}
export const activeSearch=work=>work.searches.find(s=>s.id===work.activeSearchId);
export function pendingScanUrls(work){return [...new Set(work.searches.flatMap(s=>s.pendingUrls))];}
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
export function declareScanSearches(run,searches){
 if(!Array.isArray(searches)||!searches.length||searches.length>100)throw Error('Bir seferde 1–100 arama tanımla.');
 const work=scanWork(run);
 for(const input of searches){
  if(!/^[a-zA-Z0-9_-]{1,80}$/.test(input.id))throw Error('Arama kimliği geçersiz.');
  const label=boundedText(input.label,'Arama kapsamı',500),existing=work.searches.find(s=>s.id===input.id);
  if(existing){existing.label=label;continue;}
  work.searches.push({id:input.id,label,status:'pending',pendingUrls:[],processedUrls:[],pageProgress:null,plan:null});
 }
 const initial=work.searches.find(s=>s.id==='default');
 if(initial&&!searches.some(s=>s.id==='default')&&!initial.pendingUrls.length&&!initial.processedUrls.length&&!initial.pageProgress){
  work.searches=work.searches.filter(s=>s!==initial);if(work.activeSearchId==='default')work.activeSearchId=work.searches[0].id;
 }
 return work;
}
export function selectScanSearch(run,searchId){
 const work=scanWork(run),previous=activeSearch(work),search=work.searches.find(s=>s.id===searchId);
 if(!search)throw Error('Önce aramayı save_scan_searches ile kaydet.');
 if(search.status==='completed')throw Error('Bu arama tamamlandı; kalan aramalara devam et.');
 if(previous)previous.plan=run.scanPlan??previous.plan;
 work.activeSearchId=searchId;
 const plan=search.plan??{...run.scanPlan,order:null,boundary:null,checkpoint:null};
 return {work,plan,pageProgress:search.pageProgress};
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
export function updateScanQueue(run,input,snapshot){
 const work=scanWork(run),search=activeSearch(work);
 if(search.status==='completed')throw Error('Tamamlanan aramaya yeni iş eklenemez. Kalan aramayı seç.');
 const processed=input.processedUrls??[];
 if(!Array.isArray(processed)||processed.length>100)throw Error('Bir seferde en fazla 100 işlenmiş adres kaydet.');
 const additions=[...new Set(input.pendingUrls.map(webUrl))],done=[...new Set(processed.map(webUrl))];
 if(done.some(url=>additions.includes(url)))throw Error('Bir adres aynı anda bekleyen ve işlenmiş olamaz.');
 const observed=new Set([snapshot.url,...(run.navigation??[]).map(n=>n.url),...(run.observedLinks??[])]);
 if(done.some(url=>!observed.has(url)))throw Error('İşlenmiş adres bu turda gözlenmeli; eski bekleyen işleri sessizce silme.');
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
 if(work.searches.length>1&&work.searches.some(s=>s.status!=='completed'))throw Error('Tüm kayıtlı aramalar bitmedi. Kalan aramaları select_scan_search ile seç ve complete_scan_search ile tamamla.');
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
