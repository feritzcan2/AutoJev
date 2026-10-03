import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

export const opencodeDatabase=()=>path.join(process.env.XDG_DATA_HOME||path.join(homedir(),'.local','share'),'opencode','opencode.db');
export const opencodeModelsFile=()=>path.join(process.env.XDG_CACHE_HOME||path.join(homedir(),'.cache'),'opencode','models.json');
const caches=new Map();
export async function opencodeModel(provider,model,file=opencodeModelsFile()){
 let cached=caches.get(file);
 if(!cached||Date.now()-cached.at>60000){
  try{cached={at:Date.now(),models:JSON.parse(await readFile(file,'utf8'))};caches.set(file,cached);}catch{return null;}
 }
 const limit=cached.models[provider]?.models?.[model]?.limit;
 return Number.isSafeInteger(limit?.context)&&limit.context>0?limit:null;
}

// OpenCode's reserved buffer applies to limit.input. Pin that input budget in
// this launch's config, leaving the provider's real context/output limits intact.
export async function opencodeCompaction(settings,modelsFile){
 if(settings.provider!=='opencode'||!settings.contextCompactTokens)return null;
 const slash=settings.model.indexOf('/');if(slash<1)return null;
 const providerID=settings.model.slice(0,slash),modelID=settings.model.slice(slash+1),limit=await opencodeModel(providerID,modelID,modelsFile);
 if(!limit||!Number.isSafeInteger(limit.output)||limit.output<0)return null;
 const ceiling=Number.isSafeInteger(limit.input)&&limit.input>0?Math.min(limit.context,limit.input):limit.context;
 const reserved=Math.min(20000,Math.floor(ceiling*.1)),trigger=Math.min(settings.contextCompactTokens,ceiling-reserved);
 return {providerID,modelID,inputLimit:trigger+reserved,reserved,contextWindow:limit.context,outputLimit:limit.output};
}
