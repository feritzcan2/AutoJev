import {jevConfig} from './jev-policy.mjs';

const unreadable='Kayıtlı Jev anahtarı açılamadı. Sistem anahtarlığını aç veya anahtarı yeniden kaydet.';
const validModel=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(value);
const validKey=value=>typeof value==='string'&&value.length>=8&&value.length<=4096&&!/\s/.test(value);

// Application-wide configuration. The renderer and agent only receive status;
// plaintext is decrypted in the main process immediately before an API request.
export class JevSettings {
 constructor(db,{encrypt,decrypt,config=jevConfig,fetchImpl=fetch,now=Date.now}){
  Object.assign(this,{db,encrypt,decrypt,legacyConfig:config,fetchImpl,now});this.lastCheck=null;this.revision=0;
  db.exec('CREATE TABLE IF NOT EXISTS jev_settings(id INTEGER PRIMARY KEY CHECK(id=1),ciphertext TEXT NOT NULL,model TEXT NOT NULL)');
 }
 row(){return this.db.prepare('SELECT ciphertext,model FROM jev_settings WHERE id=1').get();}
 async config(){
  const row=this.row();
  if(!row)return this.legacyConfig();
  try{const apiKey=this.decrypt(row.ciphertext);if(!validKey(apiKey))throw Error();return {apiKey,model:row.model};}catch{throw Error(unreadable);}
 }
 async status(){
  const row=this.row();let config,error=null;
  try{config=await this.config();}catch{error=unreadable;}
  return {configured:Boolean(config?.apiKey?.trim()),saved:Boolean(row),source:row?'secure':config?.apiKey?'environment':'none',model:row?.model??config?.model??'jev-latest',error,lastCheck:this.lastCheck};
 }
 async save(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['apiKey','model'].includes(key)))throw Error('Geçersiz Jev ayarı.');
  const previous=this.row(),model=input.model??previous?.model??'jev-latest';
  if(!validModel(model))throw Error('Geçerli bir Jev model adı gir.');
  if(input.apiKey!==undefined&&typeof input.apiKey!=='string')throw Error('Geçerli bir TypeSafe API anahtarı gir.');
  const key=input.apiKey?.trim();let ciphertext=previous?.ciphertext;
  if(key){if(!validKey(key))throw Error('Geçerli bir TypeSafe API anahtarı gir.');ciphertext=this.encrypt(key);}
  if(!ciphertext)throw Error('TypeSafe API anahtarını gir.');
  this.db.prepare('INSERT INTO jev_settings(id,ciphertext,model) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,model=excluded.model').run(ciphertext,model);
  this.lastCheck=null;this.revision++;return this.status();
 }
 async remove(){this.db.prepare('DELETE FROM jev_settings WHERE id=1').run();this.lastCheck=null;this.revision++;return this.status();}
 async testConnection(){
  if(this.checking)throw Error('Jev bağlantısı kontrol ediliyor.');
  this.checking=true;const revision=this.revision;
  // Pin this non-inference endpoint: https://api.typesafe.ai/openapi.json.
  // No candidate data, page state, model task or browser operation is sent.
  try{
   const {apiKey,model}=await this.config();if(!apiKey?.trim())throw Error('Önce TypeSafe API anahtarını kaydet.');
   let response;
   try{response=await this.fetchImpl('https://api.typesafe.ai/v1/models',{method:'GET',headers:{Authorization:`Bearer ${apiKey}`,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});}catch{throw Error('TypeSafe bağlantısı 10 saniye içinde tamamlanamadı. İnternet bağlantını kontrol et.');}
   if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error(response.status===401||response.status===403?'TypeSafe anahtarı kabul edilmedi. Anahtarı ve hesap erişimini kontrol et.':`TypeSafe bağlantısı tamamlanamadı (HTTP ${response.status}). Daha sonra tekrar dene.`);}
   let result;
   try{
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>131072)throw Error();chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!Array.isArray(result.models)||result.models.length>1000||!result.models.every(item=>validModel(item?.name)))throw Error();
   }catch{throw Error('TypeSafe model listesi okunamadı. Daha sonra tekrar dene.');}
   const check={ok:true,checkedAt:this.now(),modelListed:result.models.some(item=>item.name===model),message:result.models.some(item=>item.name===model)?'Bağlantı ve anahtar doğrulandı. Seçili model kullanılabilir.':'Bağlantı ve anahtar doğrulandı; seçili model dönen listede yok. Model adını kontrol et.'};
   if(this.revision===revision)this.lastCheck=check;return check;
  }catch(error){const check={ok:false,checkedAt:this.now(),message:error.message};if(this.revision===revision)this.lastCheck=check;return check;}
  finally{this.checking=false;}
 }
}
