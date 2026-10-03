import {open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TranscriptReader} from './agent-transcript.mjs';

const count=value=>Number.isSafeInteger(value)&&value>=0;
const sum=values=>values.every(count)&&count(values.reduce((a,b)=>a+b,0))?values.reduce((a,b)=>a+b,0):null;
const normalize=value=>realpath(value).catch(()=>path.resolve(value));

// These are billed request totals, independent of the latest context size.
export function requestTokens(provider,usage){
 if(!usage)return null;
 if(provider==='codex')return count(usage.total_tokens)?usage.total_tokens:sum([usage.input_tokens,usage.output_tokens]);
 if(provider==='claude')return sum([usage.input_tokens,usage.output_tokens,usage.cache_read_input_tokens??0,usage.cache_creation_input_tokens??0]);
 if(provider==='opencode')return count(usage.total)?usage.total:sum([usage.input,usage.output,usage.reasoning??0,usage.cache?.read??0,usage.cache?.write??0]);
 return null;
}

// Read after the worker closes, including its final request. A resumed native
// conversation can span many runs: timestamps and cumulative deltas isolate this
// run. No transcript or page content is copied into the workspace database.
export async function readRunTokenUsage(options){
 const {provider,nativeId,cwd,since,until=Date.now()}=options;
 if(!Number.isFinite(since)||!Number.isFinite(until)||until<since)return null;
 const reader=new TranscriptReader(options);
 if(provider==='opencode'){
  if(!/^ses_[A-Za-z0-9_-]{16,80}$/.test(nativeId??''))return null;
  let db;
  try{
   db=new DatabaseSync(reader.opencodeFile,{readOnly:true});
   const session=db.prepare('SELECT directory,parent_id FROM session WHERE id=?').get(nativeId);
   if(!session||session.parent_id||await normalize(session.directory)!==await normalize(cwd))return null;
   const rows=db.prepare("SELECT data FROM message WHERE session_id=? AND time_created>=? AND time_created<=? AND json_extract(data,'$.role')='assistant'").iterate(nativeId,since,until);
   let total=0,observed=false;
   for(const row of rows){
    const record=JSON.parse(row.data),tokens=requestTokens(provider,record.tokens);
    if(tokens===null)return null;
    total+=tokens;observed=true;
   }
   return observed&&count(total)?total:null;
  }catch{return null;}finally{db?.close();}
 }
 if(!['codex','claude'].includes(provider)||!/^[a-f0-9-]{36}$/i.test(nativeId??''))return null;
 let file;
 try{
  const location=await reader.locate();if(!location)return null;
  file=await open(location,'r');const {size}=await file.stat();if(!size)return null;
  let verified=false,partial='',discard=false,previous=0,total=0,observed=false,invalid=false;
  const messages=new Map(),signal=AbortSignal.timeout(5000);
  const accept=async line=>{
   let record;try{record=JSON.parse(line);}catch{return;}
   if(!verified){
    const identity=provider==='codex'?record.type==='session_meta'&&record.payload?.id===nativeId:record.sessionId===nativeId&&!record.isSidechain;
    const directory=provider==='codex'?record.payload?.cwd:record.cwd;
    if(identity&&typeof directory==='string')verified=await normalize(directory)===await normalize(cwd);
   }
   if(!verified)return;
   const at=Date.parse(record.timestamp),inRun=at>=since&&at<=until;
   if(provider==='codex'){
    if(record.type!=='event_msg'||record.payload?.type!=='token_count')return;
    const usage=record.payload.info?.total_token_usage;if(!usage)return;
    const tokens=requestTokens(provider,usage);
    if(tokens===null||!Number.isFinite(at)){invalid=true;return;}
    if(inRun){total+=tokens>=previous?tokens-previous:tokens;observed=true;}
    previous=tokens;
   }else{
    if(record.type!=='assistant'||record.sessionId!==nativeId||record.isSidechain||!inRun)return;
    const tokens=requestTokens(provider,record.message?.usage),id=record.message?.id;
    if(tokens===null||!id){invalid=true;return;}
    // Claude writes separate content blocks with the same request usage.
    messages.set(id,Math.max(messages.get(id)??0,tokens));observed=true;
   }
  };
  for await(const chunk of file.createReadStream({end:size-1,autoClose:false,encoding:'utf8',signal})){
   let text=partial+chunk;partial='';
   if(discard){const end=text.indexOf('\n');if(end<0)continue;text=text.slice(end+1);discard=false;}
   const lines=text.split('\n');partial=lines.pop();
   for(const line of lines)await accept(line);
   // Tool output can be huge; usage records fit well below this bound.
   if(partial.length>2*1024*1024){partial='';discard=true;}
  }
  if(provider==='claude')total=[...messages.values()].reduce((a,b)=>a+b,0);
  return verified&&observed&&!invalid&&count(total)?total:null;
 }catch{return null;}finally{await file?.close().catch(()=>{});}
}

export function jevTokenTotal(tasks){return tasks.reduce((total,task)=>total+(sum([task.usage?.input_tokens??0,task.usage?.output_tokens??0])??0),0);}
export function runTokenUsage(agentTokens,jevTokens){return {agentTokens,jevTokens,totalTokens:agentTokens===null?null:sum([agentTokens,jevTokens])};}
