import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';

const LIMIT=128000;
const secret=/^(?:password|passwd|secret|token|accessToken|refreshToken|apiKey|authorizationHeader|ciphertext)$/i;
export function instructionText(value){
 if(typeof value==='string')return value;
 const clean=value=>Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,secret.test(key)?'[Gizlendi]':clean(value[key])])):value;
 return JSON.stringify(clean(value),null,2)??'';
}
const hash=text=>createHash('sha256').update(text).digest('hex');
export const instructionPart=(key,title,source,value,extra={})=>({key,title,source,text:instructionText(value),...extra});
export function fileInstructionParts(file,text){
 return text.split(/\n(?=[A-Z#])/).filter(p=>p.trim()).map((part,index)=>instructionPart(`file:${file}:${index}`,`${file} · ${part.replace(/^#+\s*/, '').split(/[.\n]/)[0].slice(0,85)}`,file.startsWith('.agents/')||file==='TASK.md'?'skill':'system',part,{when:'Oturum başında dosyadan erişilebilir; okunduğu doğrulanmaz.'}));
}
export function contextInstructionParts(name,value){
 if(!value||typeof value!=='object')return [instructionPart(`tool:${name}`,name,'tool',value)];
 return Object.entries(value).flatMap(([key,item])=>{
  if(key==='messages'&&Array.isArray(item))return item.map((message,index)=>instructionPart(`tool:${name}:messages:${message.id??index}`,message.role==='user'?'Kullanıcı mesajı':'Konuşma bağlamı',message.role==='user'?'user':'workspace',message));
  const source=key==='template'||key==='assignedOperation'?'template':key==='messages'?'user':'workspace';
  if(item&&typeof item==='object'&&!Array.isArray(item))return Object.entries(item).map(([field,text])=>instructionPart(`tool:${name}:${key}:${field}`,`${key} · ${field}`,source,secret.test(field)?'[Gizlendi]':text));
  return [instructionPart(`tool:${name}:${key}`,key,source,item)];
 });
}
export async function launchInstructionParts(cwd){
 const files=['AGENTS.md','CLAUDE.md','TASK.md'];
 async function skills(relative){let entries;try{entries=await readdir(path.join(cwd,relative),{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
  for(const entry of entries){const file=path.join(relative,entry.name);if(entry.isDirectory())await skills(file);else if(entry.isFile()&&file.endsWith('.md'))files.push(file);}
 }
 await skills('.agents/skills');const parts=[];
 for(const file of files){try{parts.push(...fileInstructionParts(file,await readFile(path.join(cwd,file),'utf8')));}catch(error){if(error.code!=='ENOENT')throw error;}}
 return parts;
}
export function pruneInstructionLogs(db,{now=Date.now(),clear=false}={}){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_instruction_events'").get())return 0;
 const before=db.prepare('SELECT count(*) AS n FROM workspace_instruction_events').get().n;
 if(clear)db.exec('DELETE FROM workspace_instruction_events');
 else{
  db.prepare('DELETE FROM workspace_instruction_events WHERE at<?').run(new Date(now-30*86400000).toISOString());
  db.exec('DELETE FROM workspace_instruction_events WHERE seq IN (SELECT seq FROM (SELECT seq,row_number() OVER(PARTITION BY workspace_id ORDER BY seq DESC) AS n FROM workspace_instruction_events) WHERE n>500)');
  db.exec('DELETE FROM workspace_instruction_events WHERE seq NOT IN (SELECT seq FROM workspace_instruction_events ORDER BY seq DESC LIMIT 2000)');
 }
 return before-db.prepare('SELECT count(*) AS n FROM workspace_instruction_events').get().n;
}
export class InstructionLog {
 constructor(workspaces,{changed=()=>{},now=()=>Date.now()}={}){
  this.workspaces=workspaces;this.db=workspaces.db;this.changed=changed;this.now=now;
  this.db.exec(`CREATE TABLE IF NOT EXISTS workspace_instruction_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,worker_id TEXT NOT NULL,session_id TEXT NOT NULL,at TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS workspace_instruction_owner ON workspace_instruction_events(workspace_id,seq);`);
  pruneInstructionLogs(this.db,{now:this.now()});
 }
 record({workspaceId,workerId='main',sessionId,kind,title,status,parts=[],...metadata}){
  this.workspaces.get(workspaceId);let remaining=LIMIT;
  const saved=parts.map(part=>{const text=instructionText(part.text),kept=text.slice(0,remaining);remaining-=kept.length;return {...part,text:kept,hash:hash(text),characters:text.length,truncated:kept.length!==text.length};});
  const result=this.db.prepare('INSERT INTO workspace_instruction_events(workspace_id,worker_id,session_id,at,kind,data) VALUES(?,?,?,?,?,?)').run(workspaceId,workerId,sessionId,new Date(this.now()).toISOString(),kind,JSON.stringify({title,status,parts:saved,...metadata}));
  pruneInstructionLogs(this.db,{now:this.now()});this.changed(workspaceId);return Number(result.lastInsertRowid);
 }
 detail(id,seq){this.workspaces.get(id);const row=this.db.prepare('SELECT seq,worker_id AS workerId,session_id AS sessionId,at,kind,data FROM workspace_instruction_events WHERE workspace_id=? AND seq=?').get(id,seq);if(!row)throw Error('Talimat kaydı bulunamadı veya saklama süresi doldu.');const {data,...meta}=row;return {...meta,...JSON.parse(data)};}
 history(id,{worker='',session='',profile='',before=Number.MAX_SAFE_INTEGER}={}){
  this.workspaces.get(id);if(typeof worker!=='string'||typeof session!=='string'||typeof profile!=='string'||!Number.isSafeInteger(before)||before<1)throw Error('Geçersiz talimat filtresi');
  const rows=this.db.prepare("SELECT seq FROM workspace_instruction_events WHERE workspace_id=? AND (?='' OR worker_id=?) AND (?='' OR session_id=?) AND (?='' OR json_extract(data,'$.agentProfileId')=?) AND seq<? ORDER BY seq DESC LIMIT 101").all(id,worker,worker,session,session,profile,profile,before);
  const events=rows.slice(0,100).map(({seq})=>{const event=this.detail(id,seq);return {...event,parts:event.parts.map(({text,...meta})=>meta)};});
  return {events,next:rows.length>100?events.at(-1).seq:null};
 }
 sessions(id,{profile=''}={}){this.workspaces.get(id);return this.db.prepare("SELECT session_id AS id,worker_id AS workerId,min(at) AS startedAt,max(seq) AS latest FROM workspace_instruction_events WHERE workspace_id=? AND (?='' OR json_extract(data,'$.agentProfileId')=?) GROUP BY session_id,worker_id ORDER BY latest DESC LIMIT 100").all(id,profile,profile);}
 status(id,parts,{worker='',session='',profile=''}={}){
  this.workspaces.get(id);
  const rows=this.db.prepare("SELECT kind,data FROM workspace_instruction_events WHERE workspace_id=? AND (?='' OR worker_id=?) AND (?='' OR session_id=?) AND (?='' OR json_extract(data,'$.agentProfileId')=?) ORDER BY seq DESC").all(id,worker,worker,session,session,profile,profile),latest=new Map(),launches=[];
  for(const row of rows){const event=JSON.parse(row.data);if(event.status==='failed')continue;if(row.kind==='launch')launches.push(...event.parts.filter(p=>!p.truncated).map(p=>p.text));for(const part of event.parts)if(!latest.has(part.key))latest.set(part.key,{...part,status:event.status});}
  return parts.map(part=>{const match=latest.get(part.key),text=instructionText(part.text);return {...part,hash:hash(text),state:!match?(text&&launches.some(prompt=>prompt.includes(text))?'recorded':'unrecorded'):match.hash!==hash(text)?'changed':match.status==='available'?'available':'recorded'};});
 }
 tool(grant,{name,result,kind='tool_result'}){
  const context=/(?:^get_.*context$)/.test(name);
  // Capture context and browser responses, never credential-vault tool results.
  if(kind!=='tool_catalog'&&/(?:credential|password|secret|token)/i.test(name))return;
  if(kind!=='tool_catalog'&&!context&&!name.startsWith('browser_')&&!name.startsWith('research_')&&name!=='report_scan_page')return;
  let value=result;
  if(context&&result?.content?.length===1&&result.content[0].type==='text'){try{value=JSON.parse(result.content[0].text);}catch{}}
  const parts=kind==='tool_catalog'?result.tools.map(t=>instructionPart(`tool-definition:${t.name}`,t.name,'tool',t)):
   context?contextInstructionParts(name,value):[instructionPart(`response:${name}`,name,'tool',{...result,content:result.content?.map(p=>p.type==='image'||p.type==='audio'?{type:p.type,mimeType:p.mimeType,note:'İkili içerik kaydedilmedi'}:p)})];
  return this.record({workspaceId:grant.workspaceId,workerId:grant.workerId,sessionId:grant.sessionId,agentProfileId:grant.agentProfileId,kind,title:kind==='tool_catalog'?'Araç tanımları':name,status:result?.isError?'failed':'returned',parts});
 }
}
