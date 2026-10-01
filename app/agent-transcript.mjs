import {open,readdir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// The provider's own conversation file is the only faithful record of what the
// agent said. Terminal bytes carry TUI redraws; saved run summaries come late.
const NATIVE_ID=/^[a-f0-9-]{36}$/i;
export const claudeProjectDirectory=cwd=>cwd.replace(/[^A-Za-z0-9]/g,'-');
const text=content=>typeof content==='string'?content:Array.isArray(content)?content.filter(p=>p?.type==='text'&&typeof p.text==='string').map(p=>p.text).join('\n'):'';
const injected=/^\s*<(?:local-command-stdout|local-command-stderr|command-name|command-message|system-reminder|bash-input|bash-stdout|bash-stderr)\b/;

// Messages the app itself sent (launch and task prompts) are tasks, not the person’s words.
export function transcriptMessage(provider,record,nativeId,appSent=new Set()){
 if(!record||typeof record!=='object')return null;
 const role=(kind,body)=>kind==='agent'?'agent':appSent.has(body)?'task':'user';
 if(provider==='claude'){
  if(record.sessionId!==nativeId||record.isSidechain||!['assistant','user'].includes(record.type))return null;
  const body=text(record.message?.content).trim();
  if(!body||record.type==='user'&&(injected.test(body)||Array.isArray(record.message?.content)&&record.message.content.some(p=>p?.type==='tool_result')))return null;
  return {id:String(record.uuid??record.timestamp),role:role(record.type==='assistant'?'agent':'user',body),text:body,at:record.timestamp??null};
 }
 if(provider==='codex'){
  if(record.type!=='event_msg'||!['agent_message','user_message'].includes(record.payload?.type))return null;
  const body=String(record.payload.message??'').trim();if(!body)return null;
  return {id:`${record.timestamp}:${record.payload.type}`,role:role(record.payload.type==='agent_message'?'agent':'user',body),text:body,at:record.timestamp??null};
 }
 return null;
}

async function locateCodex(root,nativeId,depth=0){
 if(depth>4)return null;
 let entries;try{entries=await readdir(root,{withFileTypes:true});}catch{return null;}
 const file=entries.find(e=>e.isFile()&&e.name.startsWith('rollout-')&&e.name.endsWith(`-${nativeId}.jsonl`));
 if(file)return path.join(root,file.name);
 for(const entry of entries.filter(e=>e.isDirectory()).sort((a,b)=>b.name.localeCompare(a.name))){const found=await locateCodex(path.join(root,entry.name),nativeId,depth+1);if(found)return found;}
 return null;
}

export class TranscriptReader {
 constructor({provider,nativeId,cwd,claudeRoot,codexRoot,opencodeFile,appSent=[],now=()=>Date.now(),chunkBytes=2*1024*1024,limit=80}){
  Object.assign(this,{provider,nativeId,cwd,now,chunkBytes,limit});this.appSent=new Set(appSent.map(t=>String(t??'').trim()).filter(Boolean));
  this.claudeRoot=claudeRoot??path.join(process.env.CLAUDE_CONFIG_DIR||path.join(homedir(),'.claude'),'projects');
  this.codexRoot=codexRoot??path.join(process.env.CODEX_HOME||path.join(homedir(),'.codex'),'sessions');
  this.opencodeFile=opencodeFile??path.join(process.env.XDG_DATA_HOME||path.join(homedir(),'.local','share'),'opencode','opencode.db');this.activity=null;
  this.file=null;this.nextLookup=0;this.offset=null;this.partial='';this.discard=false;this.messages=[];this.verified=false;
 }
 async locate(){
  if(this.provider==='codex')return locateCodex(this.codexRoot,this.nativeId);
  const normalize=value=>realpath(value).catch(()=>path.resolve(value));
  for(const cwd of new Set([this.cwd,await normalize(this.cwd)])){
   const candidate=path.join(this.claudeRoot,claudeProjectDirectory(cwd),`${this.nativeId}.jsonl`);
   try{await (await open(candidate,'r')).close();return candidate;}catch{}
  }
  return null;
 }
 async read(){
  try{
   if(this.provider==='opencode')return await this.readOpenCode();
   if(!['codex','claude'].includes(this.provider))return this.messages;
   if(!NATIVE_ID.test(this.nativeId??''))return this.messages;
   if(!this.file){if(this.now()<this.nextLookup)return this.messages;this.nextLookup=this.now()+3000;this.file=await this.locate();if(!this.file)return this.messages;}
   const file=await open(this.file,'r');
   try{
    const stat=await file.stat();
    if(!this.verified){
     const head=Buffer.alloc(Math.min(stat.size,2*1024*1024));await file.read(head,0,head.length,0);
     const records=head.toString().split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
     const record=records.find(r=>r&&(this.provider==='codex'?r.type==='session_meta'&&r.payload?.id===this.nativeId:r.sessionId===this.nativeId&&typeof r.cwd==='string'&&!r.isSidechain));
     const cwd=this.provider==='codex'?record?.payload?.cwd:record?.cwd;
     if(typeof cwd!=='string')return this.messages;
     const normalize=value=>realpath(value).catch(()=>path.resolve(value));
     if(await normalize(cwd)!==await normalize(this.cwd)){this.file=null;this.nextLookup=Number.MAX_SAFE_INTEGER;return this.messages;}
     this.verified=true;this.offset=Math.max(0,stat.size-this.chunkBytes);this.discard=this.offset>0;
    }
    if(stat.size<this.offset){this.offset=0;this.partial='';this.messages=[];}
    const buffer=Buffer.alloc(Math.min(this.chunkBytes,stat.size-this.offset));
    const {bytesRead}=await file.read(buffer,0,buffer.length,this.offset);this.offset+=bytesRead;
    let chunk=this.partial+buffer.subarray(0,bytesRead).toString();this.partial='';
    if(this.discard){const end=chunk.indexOf('\n');if(end<0)return this.messages;chunk=chunk.slice(end+1);this.discard=false;}
    const lines=chunk.split('\n');this.partial=lines.pop();
    if(this.partial.length>this.chunkBytes){this.partial='';this.discard=true;}
    for(const line of lines){let record;try{record=JSON.parse(line);}catch{continue;}const message=transcriptMessage(this.provider,record,this.nativeId,this.appSent);if(message)this.messages.push(message);}
    if(this.messages.length>this.limit)this.messages=this.messages.slice(-this.limit);
    return this.messages;
   }finally{await file.close();}
  }catch{this.file=null;this.verified=false;this.offset=null;this.partial='';return this.messages;}
 }
 async readOpenCode(){
  if(!/^ses_[A-Za-z0-9_-]{16,80}$/.test(this.nativeId??''))return [];
  let db;
  try{
   db=new DatabaseSync(this.opencodeFile,{readOnly:true});
   const session=db.prepare('SELECT directory FROM session WHERE id=?').get(this.nativeId);
   const normalize=value=>realpath(value).catch(()=>path.resolve(value));
   if(!session||await normalize(session.directory)!==await normalize(this.cwd)){this.messages=[];this.activity=null;return [];}
   const messages=db.prepare("SELECT id,time_created,json_extract(data,'$.role') AS role FROM message WHERE session_id=? ORDER BY time_created DESC LIMIT ?").all(this.nativeId,this.limit).reverse(),result=[];this.activity=null;
   const parts=db.prepare("SELECT id,time_created,json_extract(data,'$.type') AS type,json_extract(data,'$.text') AS text,json_extract(data,'$.synthetic') AS synthetic,json_extract(data,'$.ignored') AS ignored,json_extract(data,'$.tool') AS tool,json_extract(data,'$.state.status') AS status FROM part WHERE session_id=? AND message_id=? ORDER BY time_created,id");
   for(const message of messages){
    const rows=parts.all(this.nativeId,message.id),body=rows.filter(p=>p.type==='text'&&!p.synthetic&&!p.ignored).map(p=>p.text??'').join('\n').trim();
    if(body&&['user','assistant'].includes(message.role))result.push({id:message.id,role:message.role==='assistant'?'agent':this.appSent.has(body)?'task':'user',text:body,at:new Date(message.time_created).toISOString()});
    if(message.role==='assistant')for(const p of rows)if(p.type==='tool')this.activity={tool:p.tool,status:p.status,at:p.time_created};
   }
   this.messages=result;return result;
  }catch{return this.messages;}finally{db?.close();}
 }
}
