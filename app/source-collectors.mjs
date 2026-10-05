import {siteExtensionFor} from './site-extensions/index.mjs';
import {recipeReplay,recipeValues} from './source-recipe.mjs';

// Only the explicitly requested job source uses a native collector. Other
// templates, record operations, and websites retain their existing behavior.
export const collectorExtension=(a,url)=>{const extension=siteExtensionFor(url);return extension?.collector?.templateId===a.templateId?extension:null;};
export const sourceCollector=(a,url)=>collectorExtension(a,url)?.id??null;
export const needsCollectorReview=record=>Boolean(record?.collectedBy&&!record.assessment&&record.status==='found'&&!record.proposal);
export const collectorRun=(a,run)=>!run.recordId&&!run.recordOperation&&run.kind==='run'&&sourceCollector(a,run.sourceUrl);
export function collectorSearches(a,url){
 if(!sourceCollector(a,url))throw Error('Bu kaynak için özel toplayıcı yok.');
 const recipe=a.sourceSettings?.[url]?.recipe;
 if(recipe&&recipe.entry.kind!=='url_template')throw Error('Himalayas toplayıcısı için URL arama reçetesi gerekli.');
 const values=recipeValues(a,url),fallback=new URL(url);
 if(!recipe&&fallback.pathname.replace(/\/$/,'')!=='/jobs/api'&&!fallback.searchParams.has('q')&&values.query)fallback.searchParams.set('q',values.query);
 const searches=recipeReplay(recipe,values)?.searches??[{url:fallback.href}];
 const adapter=collectorExtension(a,url).collector;
 const unique=new Map(searches.map(s=>{const url=adapter.searchUrl(s.url);return [url,{url,label:s.term??new URL(url).searchParams.get('q')??'Kaynak'}];}));
 return [...unique.values()].map((s,index)=>({id:`collector-${index+1}`,...s}));
}
