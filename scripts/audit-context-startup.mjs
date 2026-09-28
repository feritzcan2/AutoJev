// Read-only: aggregate metadata only, never print candidate content or images.
import {readFile} from 'node:fs/promises';
import {compactTaskContext} from '../app/agent-payloads.mjs';
const file=process.argv[2];if(!file)throw Error('Usage: node scripts/audit-context-startup.mjs conversation.jsonl [capacity]');
const capacity=Number(process.argv[3]||1000000);
if(!Number.isSafeInteger(capacity)||capacity<1)throw Error('Invalid capacity');
const calls=new Map(),seen=new Set(),samples=[],tools=new Map(),contexts=[];
const bytes=v=>Buffer.byteLength(typeof v==='string'?v:JSON.stringify(v));
let started=null,images=0,externalResultReads=0;
for(const line of (await readFile(file,'utf8')).split('\n')){
 let r;try{r=JSON.parse(line);}catch{continue;}
 if(r.isSidechain)continue;
 const m=r.message??{},u=m.usage;
 if(u&&m.id&&!seen.has(m.id)){
  seen.add(m.id);started??=r.timestamp;
  const tokens=['input_tokens','cache_read_input_tokens','cache_creation_input_tokens'].reduce((n,k)=>n+(u[k]??0),0);
  samples.push({timestamp:r.timestamp,elapsedSeconds:(Date.parse(r.timestamp)-Date.parse(started))/1000,tokens,percent:tokens/capacity*100});
 }
 if(!Array.isArray(m.content))continue;
 for(const b of m.content){
  if(b.type==='tool_use'){
   calls.set(b.id,b.name);
   if(b.name==='Read'&&b.input?.file_path?.includes('/tool-results/'))externalResultReads++;
  }
  if(b.type!=='tool_result')continue;
  const name=calls.get(b.tool_use_id)??'unknown',stat=tools.get(name)??{calls:0,textBytes:0,images:0};stat.calls++;
  const parts=typeof b.content==='string'?[{type:'text',text:b.content}]:b.content??[];
  for(const part of parts){
   if(part.type==='image'){images++;stat.images++;}
   if(part.type!=='text')continue;
   stat.textBytes+=bytes(part.text??'');
   if(!name.endsWith('get_task_context'))continue;
   let value;try{value=JSON.parse(part.text);}catch{continue;}
   if(!value.profile)continue;
   const compact=compactTaskContext(value);
   contexts.push({beforeBytes:bytes(value),afterBytes:bytes(compact),sections:Object.fromEntries(Object.entries(value).map(([key,v])=>[key,{beforeBytes:bytes(v),afterBytes:bytes(compact[key])}]))});
  }
  tools.set(name,stat);
 }
}
console.log(JSON.stringify({capacity,requestCount:samples.length,firstRequests:samples.slice(0,8),firstTenPercent:samples.find(s=>s.percent>=10)??null,last:samples.at(-1),tools:Object.fromEntries([...tools].sort((a,b)=>b[1].textBytes-a[1].textBytes)),contexts,images,externalResultReads,notes:'Request input tokens include cache. Bytes are payload sizes, not estimated tokens. Initial system/tool overhead cannot be attributed exactly from transcript alone.'},null,2));
