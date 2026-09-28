import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function sameBrowserInstance(a,b){
  try{const x=new URL(a),y=new URL(b);return /^wss?:$/.test(x.protocol)&&/^wss?:$/.test(y.protocol)&&/^\/devtools\/browser\/[^/]+$/.test(x.pathname)&&x.pathname===y.pathname;}catch{return false;}
}

export function restoredTargets(saved,checkpoints,live,contextId){
  if(!contextId)return [];
  const ids=new Set([...(saved?.targets??[]),...checkpoints.filter(c=>c?.browser==='Jev Chrome').map(c=>c.tabId)]);
  return [...ids].filter(id=>/^[A-Fa-f0-9]{32}$/.test(id)&&live.get(id)?.browserContextId===contextId);
}

// Candidate-owned metadata only: never discover a draft by matching its URL.
export class JevTabs {
  constructor(directory,profile){
    this.file=path.join(directory,`tabs-${encodeURIComponent(profile)}.json`);
    this.profile=profile;this.writes=Promise.resolve();
  }
  async read(){
    let saved;
    try{saved=JSON.parse(await readFile(this.file,'utf8'));}
    catch(error){if(error.code==='ENOENT')return null;throw Error('Jev sekme kaydı okunamadı; mevcut formlar korunuyor.');}
    if(saved.version!==1||saved.profile!==this.profile||typeof saved.endpoint!=='string'||typeof saved.contextId!=='string'||!Array.isArray(saved.targets)||!saved.targets.every(id=>/^[A-Fa-f0-9]{32}$/.test(id)))throw Error('Jev sekme kaydı geçersiz; mevcut formlar korunuyor.');
    return saved;
  }
  save(endpoint,contextId,targets,metadata={}){
    const data=JSON.stringify({version:1,profile:this.profile,endpoint,contextId,targets:[...new Set(targets)],...metadata});
    const write=async()=>{
      await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
      const temporary=`${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary,data,{mode:0o600});await rename(temporary,this.file);
    };
    this.writes=this.writes.catch(()=>{}).then(write);return this.writes;
  }
}
