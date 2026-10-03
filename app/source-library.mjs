import sources from '../source-library/sources.json' with {type:'json'};
import {normalizeTemplateSources} from './template-sources.mjs';

export const bundledSources=normalizeTemplateSources(sources);
export function catalogSources(input){
 if(!Array.isArray(input)||input.length>200)throw Error('Kaynak listesi en fazla 200 kayıt içerebilir');
 const sources=normalizeTemplateSources(input);
 if(new Set(sources.map(s=>s.url)).size!==sources.length)throw Error('Kaynak listesinde yinelenen adres var');
 return sources;
}
export async function loadSourceLibrary(url,{fetchImpl=fetch}={}){
 if(!url)return bundledSources;
 const address=normalizeTemplateSources([{url}])[0].url,response=await fetchImpl(address,{signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});
 if(!response.ok)throw Error(`Kaynak listesi okunamadı: HTTP ${response.status}`);
 let size=0;const parts=[];
 for await(const part of response.body){size+=part.length;if(size>1024*1024)throw Error('Kaynak listesi 1 MB sınırını aşıyor');parts.push(Buffer.from(part));}
 return catalogSources(JSON.parse(Buffer.concat(parts).toString('utf8')));
}
export function importSourceLibrary(db,id,input){
 const selected=normalizeTemplateSources(input);
 return db.store.workspaces.tasks.atomic(()=>{
  const result={added:0,enriched:0,skipped:0};
  for(const source of selected){
   const a=db.get(id);
   if(a.sources.includes(source.url)){
    const saved=a.sourceSettings?.[source.url]??{};
    const method=!saved.instructions&&!saved.skill&&(source.instructions||source.skill),recipe=!saved.recipe&&source.recipe;
    if(method||recipe){
     db.saveSource(id,source.url,{...(method?{instructions:source.instructions??'',skill:source.skill??''}:{}),...(recipe?{recipe:source.recipe}:{})});result.enriched++;
    }else result.skipped++;
   }else{db.addSource(id,{...source,query:source.query||a.goal||'Kayıtlı çalışma alanı kriterleri',enabled:true});result.added++;}
  }
  return result;
 });
}
