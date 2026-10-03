// A source recipe records how a results page for the current query is reached
// and how it pages. It is data learned per source, never code tied to a site.
// The app verifies every recipe by actually finding listings with it.
// This module is also bundled into the renderer; keep it free of app imports.
function boundedText(value,label,max){
 if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`${label}: 1–${max} karakter gerekli`);
 return value.trim();
}

export const RECIPE_ENTRY_KINDS=['url_template','search_form','discovery'];
export const RECIPE_PAGINATION_KINDS=['auto','url_param','next_link','next_click','load_more','infinite_scroll','none'];
export const RECIPE_FIELD_KEYS=['query','location'];
export const RECIPE_STALE_FAILURES=2;
export const RECIPE_TERM_LIMIT=5;
const placeholderPattern=/\{([a-z_][a-z0-9_]*)\}/g;

const webAddress=(value,label)=>{
 let url;try{url=new URL(String(value));}catch{throw Error(`${label}: geçerli bir web adresi gerekli`);}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error(`${label}: kullanıcı bilgisi içermeyen HTTP(S) adresi gerekli`);
 url.hash='';return url.href;
};

export function normalizeSourceRecipe(input){
 if(input===null||input===undefined)return null;
 if(typeof input!=='object'||Array.isArray(input))throw Error('Geçersiz kaynak reçetesi');
 const entry=input.entry;
 if(!entry||typeof entry!=='object'||!RECIPE_ENTRY_KINDS.includes(entry.kind))throw Error('Reçete yöntemi url_template, search_form veya discovery olmalı');
 const recipe={entry:{kind:entry.kind}};
 if(entry.kind==='url_template'){
  const template=boundedText(entry.template,'URL şablonu',2000);
  // A template without {query} is a fixed results address.
  webAddress(template.replace(placeholderPattern,'x'),'URL şablonu');
  recipe.entry.template=template;
 }else if(entry.kind==='search_form'){
  recipe.entry.url=webAddress(entry.url,'Arama formu adresi');
  if(!Array.isArray(entry.fields)||!entry.fields.length||entry.fields.length>6)throw Error('Arama formu için 1–6 alan gerekli');
  const seen=new Set();
  recipe.entry.fields=entry.fields.map(field=>{
   if(!field||typeof field!=='object'||!RECIPE_FIELD_KEYS.includes(field.key))throw Error('Form alanı anahtarı query veya location olmalı');
   if(seen.has(field.key))throw Error('Form alanı anahtarları benzersiz olmalı');seen.add(field.key);
   return {key:field.key,label:boundedText(field.label,'Form alanı etiketi',120)};
  });
  if(!seen.has('query'))throw Error('Arama formunda query alanı gerekli');
 }
 const pagination=input.pagination??'auto';
 if(!RECIPE_PAGINATION_KINDS.includes(pagination))throw Error('Geçersiz sayfalama türü');
 recipe.pagination=pagination;
 if(input.loginRequired!==undefined&&input.loginRequired!==null){if(typeof input.loginRequired!=='boolean')throw Error('loginRequired doğru/yanlış olmalı');recipe.loginRequired=input.loginRequired;}
 if(input.notes!==undefined&&input.notes!==null&&input.notes!==''){recipe.notes=boundedText(input.notes,'Reçete notu',1000);}
 // Search terms replace {query} when the source query is a description rather
 // than a keyword. Each term is its own search on the same results pattern.
 if(input.terms!==undefined&&input.terms!==null&&recipe.entry.kind!=='discovery'){
  if(!Array.isArray(input.terms)||!input.terms.length||input.terms.length>RECIPE_TERM_LIMIT)throw Error(`Arama terimleri: 1–${RECIPE_TERM_LIMIT} öğe gerekli`);
  recipe.terms=[...new Set(input.terms.map(term=>boundedText(term,'Arama terimi',80)))];
  if(recipe.entry.kind==='url_template'&&!hasQueryPlaceholder(recipe.entry.template))throw Error('Arama terimleri için URL şablonu {query} yer tutucusunu içermeli');
 }
 return recipe;
}
const hasQueryPlaceholder=template=>[...template.matchAll(placeholderPattern)].some(m=>m[1]==='query');

// {query} is the saved source query; other placeholders read the workspace
// criteria field with the same id. Empty values drop their query parameter.
export function recipeValues(a,url){
 const source=a.sourceSettings?.[url]??{};
 const values={query:(source.query??a.goal??'').trim()};
 for(const [key,value] of Object.entries(a.criteria??{}))if(typeof value==='string'&&!(key in values))values[key]=value.trim();
 return values;
}

export function replayUrl(template,values){
 const filled=template.replace(placeholderPattern,(_,key)=>encodeURIComponent(values[key]??''));
 const url=new URL(filled);
 for(const [key,value] of [...url.searchParams])if(value==='')url.searchParams.delete(key);
 // Query parameters use form encoding consistently (spaces become +).
 if([...url.searchParams].length)url.search=url.searchParams.toString();
 return url.href;
}

// One replay holds one search per term (or a single search with the source
// query). Scans run every search; checks verify the first one.
export function recipeReplay(recipe,values){
 if(!recipe||recipe.entry.kind==='discovery')return null;
 const terms=recipe.terms?.length?recipe.terms:[null];
 const searches=terms.map(term=>{
  const filled=term===null?values:{...values,query:term};
  if(recipe.entry.kind==='url_template')return {term,url:replayUrl(recipe.entry.template,filled)};
  return {term,url:recipe.entry.url,answers:recipe.entry.fields.map(f=>({key:f.key,label:f.label,value:filled[f.key]??''})).filter(a=>a.value)};
 });
 return {kind:recipe.entry.kind,pagination:recipe.pagination,searches};
}
export const replayUrls=replay=>replay?[...new Set(replay.searches.map(s=>s.url))]:[];
// A scan belongs to a replayed search when it opened that address or the same
// address with extra parameters (a later page, a site-added token). Different
// routes or changed values are another search.
export function replayMatches(replay,url){
 if(!replay||typeof url!=='string')return false;
 let target;try{target=new URL(url);}catch{return false;}
 return replayUrls(replay).some(candidate=>{
  const base=new URL(candidate);
  return base.origin===target.origin&&base.pathname.replace(/\/$/,'')===target.pathname.replace(/\/$/,'')&&[...base.searchParams].every(([k,v])=>target.searchParams.getAll(k).includes(v));
 });
}

export const recipeStatus=(recipe,state)=>!recipe?'none':recipe.entry.kind==='discovery'?'discovery':state?.status==='verified'?'verified':state?.status==='stale'?'stale':'candidate';

export const RECIPE_FAILURE_REASONS=new Set(['no_listing_links','search_control_missing','search_control_uncertain','search_not_verified','no_progress','page_changed','unmatched_answers','fill_not_verified','pagination_uncertain','pagination_action_unconfirmed','task_error']);

// A result link is a listing when discovery confirmed it, or when its detail
// was read and judged an individual opportunity (fit or not). Boards whose
// result links are redirects only prove themselves through details.
export const jevListingItem=item=>item.discovery?.decision==='listing'||Boolean(item.collected&&item.pageKind!=='results'&&item.assessment&&(item.assessment.decision==='possible'||item.assessment.decision==='mismatch'&&item.assessment.reason!=='not_listing'));

// Judge one finished scan from its Jev tasks. Access barriers and loading
// pages are neutral: they say nothing about whether the recipe still works.
export function recipeRunOutcome(replay,tasks){
 if(!replay)return 'neutral';
 const relevant=tasks.filter(t=>['scan_results','prepare_search'].includes(t.input?.operation)&&replayMatches(replay,t.input?.url));
 if(!relevant.length)return 'neutral';
 const ids=new Set(relevant.map(t=>t.id)),details=tasks.filter(t=>t.input?.operation==='collect_details'&&ids.has(t.input?.fromTaskId));
 if([...relevant,...details].some(t=>(t.items??[]).some(jevListingItem)))return 'success';
 if(relevant.some(t=>t.issue?.reason==='access_barrier'||t.status==='running'||t.status==='continue'||t.status==='pending'))return 'neutral';
 if(relevant.every(t=>t.status==='completed'&&!(t.items??[]).length||RECIPE_FAILURE_REASONS.has(t.issue?.reason)))return 'failure';
 return 'neutral';
}

export function advanceRecipeState(state,outcome,{runId,now,reason=null,url=null}){
 const current={status:'candidate',successCount:0,failCount:0,...state};
 if(outcome==='neutral')return current;
 if(outcome==='success')return {...current,status:'verified',successCount:current.successCount+1,failCount:0,verifiedAt:now,lastRunId:runId,lastFailure:null};
 const failCount=current.failCount+1;
 return {...current,status:failCount>=RECIPE_STALE_FAILURES?'stale':current.status==='verified'?'verified':'candidate',failCount,lastRunId:runId,lastFailure:{reason,url,at:now}};
}

export function recipeSummary(recipe,state){
 const status=recipeStatus(recipe,state);
 if(status==='none')return {status,label:'Reçete yok',detail:'İlk deneme turunda öğrenilecek.'};
 if(status==='discovery')return {status,label:'Keşif modu',detail:recipe.notes??'Agent her turda aramayı kendisi yapar.'};
 if(status==='verified')return {status,label:'Reçete doğrulandı',detail:`${state.successCount} başarılı tur${state.failCount?`, ${state.failCount} başarısız`:''}${recipe.terms?.length?` · ${recipe.terms.length} arama terimi`:''}`};
 if(status==='stale')return {status,label:'Reçete bozuldu',detail:state.lastFailure?.reason?`Son hata: ${state.lastFailure.reason}. Yeniden öğrenilecek.`:'Yeniden öğrenilecek.'};
 return {status,label:'Reçete bekliyor',detail:state?.lastFailure?.reason?`Doğrulanamadı: ${state.lastFailure.reason}`:'İlk taramada doğrulanacak.'};
}
