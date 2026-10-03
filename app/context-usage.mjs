import {open,readdir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {opencodeDatabase,opencodeModel} from './opencode-context.mjs';

const validCount=n=>Number.isSafeInteger(n)&&n>=0;
export function contextRestartTokens(value=0){
 if(!Number.isSafeInteger(value)||value<0)throw Error('Yeni oturum eşiği 0 (kapalı) veya pozitif bir tam token sayısı olmalı.');
 return value;
}

// Each sample describes one request's input context, never lifetime billing.
// Codex includes cached tokens; the Claude status writer has already added them.
export function contextTokens(provider,record,nativeId){
 if(!record||typeof record!=='object')return null;
 if(provider==='codex'){
  if(record.type!=='event_msg'||record.payload?.type!=='token_count')return null;
  const count=record.payload.info?.last_token_usage?.input_tokens;
  return validCount(count)?count:null;
 }
 if(provider==='claude'){
  if(record.type!=='context_usage'||record.sessionId!==nativeId||record.isSidechain)return null;
  return validCount(record.tokens)?record.tokens:null;
 }
 if(provider==='opencode'){
  if(record.role!=='assistant'||record.sessionID!==nativeId||record.summary||record.error||!record.time?.completed)return null;
  const tokens=record.tokens;
  if(!tokens||!validCount(tokens.input))return null;
  const counts=[tokens.input,tokens.cache?.read??0,tokens.cache?.write??0];
  const total=counts.every(validCount)?counts.reduce((a,b)=>a+b,0):0;return total>0?total:null;
 }
 return null;
}

export function contextSample(provider,record,nativeId){
 const tokens=contextTokens(provider,record,nativeId);
 const capacity=provider==='codex'?record?.payload?.info?.model_context_window:record?.contextWindow;
 const contextWindow=validCount(capacity)&&capacity>0?capacity:null;
 return {tokens,contextWindow,percent:tokens!==null&&contextWindow?Math.min(100,tokens/contextWindow*100):null};
}

async function locate(root,nativeId,depth=0){
 if(depth>4)return null;
 let entries;try{entries=await readdir(root,{withFileTypes:true});}catch{return null;}
 const file=entries.find(e=>e.isFile()&&e.name.startsWith('rollout-')&&e.name.endsWith(`-${nativeId}.jsonl`));
 if(file)return path.join(root,file.name);
 // Newest date buckets first. Do not follow symlinks.
 for(const entry of entries.filter(e=>e.isDirectory()).sort((a,b)=>b.name.localeCompare(a.name))){
  const found=await locate(path.join(root,entry.name),nativeId,depth+1);if(found)return found;
 }
 return null;
}

export class ContextUsage {
 constructor({provider,nativeId,cwd,root,statusFile,opencodeFile=opencodeDatabase(),modelsFile,now=()=>Date.now(),chunkBytes=2*1024*1024}){
  Object.assign(this,{provider,nativeId,cwd,statusFile,now,chunkBytes});
  Object.assign(this,{opencodeFile,modelsFile});
  this.root=root??path.join(process.env.CODEX_HOME||path.join(homedir(),'.codex'),'sessions');
  this.file=null;this.nextLookup=0;this.offset=null;this.partial='';this.discard=false;this.tokens=null;this.percent=null;this.peakPercent=0;this.peakTokens=0;this.contextWindow=null;this.updatedAt=null;this.compactionId=null;
 }
 async read(){
  try{
   if(this.provider==='opencode')return await this.readOpenCode();
   if(!['codex','claude'].includes(this.provider))return this.value(false);
   if(!/^[a-f0-9-]{36}$/i.test(this.nativeId??''))return this.value(false);
   if(!this.file){
    if(this.now()<this.nextLookup)return this.value(false);
    this.nextLookup=this.now()+5000;this.file=this.provider==='claude'?this.statusFile:await locate(this.root,this.nativeId);
    if(!this.file)return this.value(false);
   }
   const file=await open(this.file,'r');
   try{
    const stat=await file.stat();
    if(this.offset===null){
     // Verify identity and workspace before trusting even a matching filename.
     const head=Buffer.alloc(Math.min(stat.size,2*1024*1024));await file.read(head,0,head.length,0);
     const records=head.toString().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
     const record=records.find(r=>r&&(this.provider==='codex'?r.type==='session_meta'&&r.payload?.id===this.nativeId:r.sessionId===this.nativeId&&typeof r.cwd==='string'&&!r.isSidechain));
     const cwd=this.provider==='codex'?record?.payload?.cwd:record?.cwd;
     if(typeof cwd!=='string')return this.value(false);
     const normalize=value=>realpath(value).catch(()=>path.resolve(value));
     if(await normalize(cwd)!==await normalize(this.cwd))return this.value(false);
     this.offset=Math.max(0,stat.size-this.chunkBytes);this.discard=this.offset>0;
    }
    if(stat.size<this.offset){this.offset=null;this.partial='';return this.value(false);}
    const buffer=Buffer.alloc(Math.min(this.chunkBytes,stat.size-this.offset));
    const {bytesRead}=await file.read(buffer,0,buffer.length,this.offset);this.offset+=bytesRead;
    let text=this.partial+buffer.subarray(0,bytesRead).toString();this.partial='';
    if(this.discard){const end=text.indexOf('\n');if(end<0)return this.value(this.offset===stat.size,this.offset<stat.size);text=text.slice(end+1);this.discard=false;}
    const lines=text.split('\n');this.partial=lines.pop();
    if(this.partial.length>this.chunkBytes){this.partial='';this.discard=true;}
    for(const line of lines){
     let record;try{record=JSON.parse(line);}catch{continue;}
     if(this.provider==='codex'&&record?.type==='compacted'&&typeof record.timestamp==='string')this.compactionId=record.timestamp;
     const sample=contextSample(this.provider,record,this.nativeId);if(sample.tokens===null)continue;
     Object.assign(this,sample);this.peakTokens=Math.max(this.peakTokens,sample.tokens);if(sample.percent!==null)this.peakPercent=Math.max(this.peakPercent,sample.percent);this.updatedAt=this.now();
    }
    return this.value(this.offset===stat.size,this.offset<stat.size);
   }finally{await file.close();}
  }catch{this.file=null;this.offset=null;this.partial='';return this.value(false);}
 }
 async readOpenCode(){
  if(!/^ses_[A-Za-z0-9_-]{16,80}$/.test(this.nativeId??''))return this.value(false);
  let db;
  try{
   db=new DatabaseSync(this.opencodeFile,{readOnly:true});
   const session=db.prepare('SELECT directory,parent_id FROM session WHERE id=?').get(this.nativeId);
   const normalize=value=>realpath(value).catch(()=>path.resolve(value));
   if(!session||session.parent_id||await normalize(session.directory)!==await normalize(this.cwd))return this.value(false);
   const rows=db.prepare("SELECT id,time_updated,data FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' AND json_extract(data,'$.time.completed') IS NOT NULL ORDER BY time_created DESC LIMIT 100").all(this.nativeId);
   const summary=rows.find(row=>{const m=JSON.parse(row.data);return m.summary&&m.finish&&!m.error;});
   if(summary)this.compactionId=summary.id;
   for(const row of rows){
    const record={sessionID:this.nativeId,...JSON.parse(row.data)},tokens=contextTokens('opencode',record,this.nativeId);if(tokens===null)continue;
    const limit=await opencodeModel(record.providerID,record.modelID,this.modelsFile);
    const sample=contextSample('opencode',{...record,contextWindow:limit?.context},this.nativeId);
    Object.assign(this,sample);this.peakTokens=Math.max(this.peakTokens,sample.tokens);if(sample.percent!==null)this.peakPercent=Math.max(this.peakPercent,sample.percent);
    this.updatedAt=row.time_updated;return this.value(true);
   }
   return this.value(false);
  }catch{return this.value(false);}finally{db?.close();}
 }
 value(caughtUp,pending=false){return{tokens:this.tokens,contextWindow:this.contextWindow,percent:this.percent,peakPercent:this.peakPercent,peakTokens:this.peakTokens,updatedAt:this.updatedAt,compactionId:this.compactionId,caughtUp,pending};}
}
