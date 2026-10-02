import {readFile,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {documentPath} from './artifacts.mjs';
import {workspaceDirectory} from './workspace-paths.mjs';
const cache=new Map();
const source=(text,extra={})=>({text,digest:createHash('sha256').update(text).digest('hex'),...extra});
export function scoringSources(automation,cv){
 const profile=automation.referenceData?.profile??{};
 const facts=[automation.facts,profile.facts,...Object.values(profile.learnedFacts??{}).map(x=>x.value)].filter(x=>typeof x==='string').join('\n');
 return {facts:source(facts),preferences:source([automation.goal,automation.criteria?.preferences,automation.criteria?.constraints,automation.instructions].filter(Boolean).join('\n')),...(cv?{cv}:{})};
}
export async function loadScoringCv(db,id){
 const a=db.get(id),file=a.referenceData?.profile?.cvPath;
 if(!file)return source('',{unavailable:'Kayıtlı CV yok; doğrulanmayan deneyimi unknown bırak.'});
 const root=await realpath(workspaceDirectory(db.store.directory,db.store.workspaces.get(id))),requested=await realpath(path.resolve(root,file)),safe=await documentPath(root,path.relative(root,requested)),info=await stat(safe);
 if(info.size>10*1024*1024)throw Error('CV metin kontrolü için en fazla 10 MB olmalı.');
 const key=JSON.stringify([id,safe,info.size,info.mtimeMs]),previous=cache.get(key);if(previous)return previous;
 let text;const extension=path.extname(safe).toLowerCase();
 if(['.txt','.md'].includes(extension))text=await readFile(safe,'utf8');
 else if(extension==='.pdf'){
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading=getDocument({data:new Uint8Array(await readFile(safe)),isEvalSupported:false,useSystemFonts:false,disableFontFace:true});
  try{const pdf=await loading.promise;if(pdf.numPages>40)throw Error('CV en fazla 40 sayfa olmalı.');const pages=[];
   for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i),content=await page.getTextContent();pages.push(content.items.map(x=>typeof x.str==='string'?x.str+(x.hasEOL?'\n':' '):'').join(''));page.cleanup();}text=pages.join('\n');
  }finally{await loading.destroy();}
 }else return source('',{path:path.relative(root,safe),unavailable:'Bu CV biçiminden doğrulanabilir metin alınamadı; kayıtlı facts kullan veya ilgili kanıtı unknown bırak.'});
 if(text.length>300000)throw Error('CV metni çok uzun.');
 const result=source(text,{path:path.relative(root,safe)});if(cache.size>=32)cache.delete(cache.keys().next().value);cache.set(key,result);return result;
}
