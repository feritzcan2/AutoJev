import {readFileSync} from 'node:fs';
import {normalizeTemplateSources} from './template-sources.mjs';
import {sourceToolContext} from './source-tools.mjs';
import {copySourceSkill} from './source-copy.mjs';

export const bundledSources=normalizeTemplateSources(JSON.parse(readFileSync(new URL('../source-library/sources.json',import.meta.url),'utf8')));
export function catalogSources(input){
 if(!Array.isArray(input)||input.length>200)throw Error('Kaynak listesi en fazla 200 kayıt içerebilir');
 const sources=input.map(source=>copySourceSkill(normalizeTemplateSources([source])[0]));
 if(new Set(sources.map(s=>s.url)).size!==sources.length)throw Error('Kaynak listesinde yinelenen adres var');
 return sources;
}
export async function loadSourceLibrary(url,{fetchImpl=fetch}={}){
 let sources=bundledSources;
 if(url){
  const address=normalizeTemplateSources([{url}])[0].url,response=await fetchImpl(address,{signal:AbortSignal.timeout(10000),headers:{Accept:'application/json'}});
  if(!response.ok)throw Error(`Kaynak listesi okunamadı: HTTP ${response.status}`);
  let size=0;const parts=[];
  for await(const part of response.body){size+=part.length;if(size>1024*1024)throw Error('Kaynak listesi 1 MB sınırını aşıyor');parts.push(Buffer.from(part));}
  sources=catalogSources(JSON.parse(Buffer.concat(parts).toString('utf8')));
 }
 return sources.map(source=>({...source,toolAvailable:!source.tool||sourceToolContext(source.tool).available}));
}
export function importSourceLibrary(db,id,input){
 const selected=normalizeTemplateSources(input).map(copySourceSkill);
 return db.store.workspaces.tasks.atomic(()=>{
  const result={added:0,enriched:0,skipped:0};
  for(const source of selected){
   if(source.tool&&!sourceToolContext(source.tool).available)throw Error(`${source.name}: ${source.tool} bu kurulumda bulunamadı`);
   const a=db.get(id);
   if(a.sources.includes(source.url)){
    const saved=a.sourceSettings?.[source.url]??{};
    if(!saved.tool&&!saved.instructions&&!saved.skill&&(source.tool||source.instructions||source.skill)){
     db.saveSource(id,source.url,{instructions:source.instructions??'',tool:source.tool??'',skill:source.skill??''});result.enriched++;
    }else result.skipped++;
   }else{db.addSource(id,{...source,query:source.query||a.goal||'Kayıtlı çalışma alanı kriterleri',enabled:true});result.added++;}
  }
  return result;
 });
}
