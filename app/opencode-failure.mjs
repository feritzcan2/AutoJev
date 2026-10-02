import {DatabaseSync} from 'node:sqlite';
import {realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

// Read the provider's structured terminal error, never a page or TUI substring.
// Retain only a safe classification; response bodies/headers may contain secrets.
export async function readOpenCodeFailure({nativeId,cwd,since=0,file=path.join(process.env.XDG_DATA_HOME||path.join(homedir(),'.local','share'),'opencode','opencode.db')}){
 if(!/^ses_[A-Za-z0-9_-]{16,80}$/.test(nativeId??''))return null;
 let db;
 try{
  db=new DatabaseSync(file,{readOnly:true});
  const session=db.prepare('SELECT directory FROM session WHERE id=?').get(nativeId);
  if(!session||await realpath(session.directory)!==await realpath(cwd))return null;
  const row=db.prepare('SELECT id,time_created,data FROM message WHERE session_id=? ORDER BY time_created DESC,id DESC LIMIT 1').get(nativeId);
  if(!row||row.time_created<since)return null;
  const message=JSON.parse(row.data),error=message.error;
  if(message.role!=='assistant'||!message.time?.completed||!error||error.name==='MessageAbortedError'||error.data?.isRetryable===true)return null;
  const code=Number(error.data?.statusCode),unsupported=/content part type ["']file["'] is not supported/i.test(error.data?.message??'');
  return {messageId:row.id,at:message.time.completed,kind:unsupported?'unsupported_file':'provider_error',
   summary:unsupported?'Model PDF dosya ekini kabul etmedi. CV, read_scoring_profile aracıyla metin olarak okunmalı. Görev durduruldu; yeniden deneme yeni bir oturum açacak.':`Model sağlayıcısı isteği tamamlayamadı${Number.isInteger(code)&&code>=400&&code<=599?` (HTTP ${code})`:''}. Görev durduruldu; agent terminalindeki hatayı kontrol et.`};
 }catch{return null;}finally{db?.close();}
}
