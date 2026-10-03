import {CapsolverClient,CaptchaError} from './capsolver-client.mjs';

export class CaptchaSettings {
 constructor(db,{encrypt,decrypt,client=new CapsolverClient(),now=Date.now}){
  Object.assign(this,{db,encrypt,decrypt,client,now});this.revision=0;this.changes=new AbortController();this.lastCheck=null;
  db.exec('CREATE TABLE IF NOT EXISTS captcha_settings(id INTEGER PRIMARY KEY CHECK(id=1),ciphertext TEXT NOT NULL,enabled INTEGER NOT NULL,daily_limit INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS captcha_usage(day TEXT PRIMARY KEY,requests INTEGER NOT NULL)');
 }
 row(){return this.db.prepare('SELECT * FROM captcha_settings WHERE id=1').get();}
 day(){return new Date(this.now()).toISOString().slice(0,10);}
 used(){return this.db.prepare('SELECT requests FROM captcha_usage WHERE day=?').get(this.day())?.requests??0;}
 config(){const row=this.row();if(!row)return {enabled:false,dailyLimit:100};try{return {apiKey:this.decrypt(row.ciphertext),enabled:!!row.enabled,dailyLimit:row.daily_limit};}catch{throw new CaptchaError('CAPTCHA_KEY','CapSolver anahtarı açılamadı. Sistem anahtarlığını aç veya anahtarı yeniden kaydet.');}}
 status(){let config,error;try{config=this.config();}catch(e){error=e.message;}return {configured:!!config?.apiKey,saved:!!this.row(),enabled:config?.enabled??false,dailyLimit:config?.dailyLimit??100,usedToday:this.used(),day:this.day(),error,lastCheck:this.lastCheck};}
 changed(){this.revision++;this.changes.abort();this.changes=new AbortController();this.lastCheck=null;}
 save(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['apiKey','enabled','dailyLimit'].includes(k)))throw Error('Geçersiz CAPTCHA ayarı.');
  const previous=this.row(),enabled=input.enabled??!!previous?.enabled,dailyLimit=input.dailyLimit??previous?.daily_limit??100;
  if(typeof enabled!=='boolean'||!Number.isSafeInteger(dailyLimit)||dailyLimit<1||dailyLimit>10000)throw Error('Günlük çözüm isteği sınırı 1–10000 arasında olmalı.');
  if(input.apiKey!==undefined&&typeof input.apiKey!=='string')throw Error('Geçerli bir CapSolver anahtarı gir.');
  const key=input.apiKey?.trim();let ciphertext=previous?.ciphertext;
  if(key){if(key.length<8||key.length>4096||/\s/.test(key))throw Error('Geçerli bir CapSolver anahtarı gir.');ciphertext=this.encrypt(key);}
  if(!ciphertext)throw Error('CapSolver API anahtarını gir.');
  this.db.prepare('INSERT INTO captcha_settings VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,enabled=excluded.enabled,daily_limit=excluded.daily_limit').run(ciphertext,Number(enabled),dailyLimit);
  this.changed();return this.status();
 }
 remove(){this.db.exec('DELETE FROM captcha_settings');this.changed();return this.status();}
 // Count before sending, including uncertain network outcomes. A restart must
 // not reset the user's spending bound; image rounds each consume one request.
 reserve(){
  const config=this.config();if(!config.enabled||!config.apiKey)throw new CaptchaError('CAPTCHA_DISABLED','Otomatik CAPTCHA çözümü kapalı.');
  const result=this.db.prepare('INSERT INTO captcha_usage(day,requests) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET requests=requests+1 WHERE requests<?').run(this.day(),config.dailyLimit);
  if(!result.changes)throw new CaptchaError('CAPTCHA_LIMIT','Günlük CAPTCHA çözüm isteği sınırına ulaşıldı.');
  this.db.prepare('DELETE FROM captcha_usage WHERE day<?').run(new Date(this.now()-31*86400000).toISOString().slice(0,10));return config.apiKey;
 }
 async testConnection(){
  if(this.checking)throw Error('CapSolver bağlantısı kontrol ediliyor.');
  this.checking=true;const revision=this.revision;
  try{const {apiKey}=this.config();if(!apiKey)throw Error('Önce CapSolver anahtarını kaydet.');const balance=await this.client.balance(apiKey,this.changes.signal);const value={ok:true,balance,checkedAt:this.now(),message:`Bağlantı doğrulandı. Bakiye: $${balance.toFixed(2)}`};if(revision===this.revision)this.lastCheck=value;return value;}
  catch(error){const value={ok:false,checkedAt:this.now(),message:revision===this.revision?error.message:'Ayar değişti; bağlantıyı yeniden kontrol et.'};if(revision===this.revision)this.lastCheck=value;return value;}
  finally{this.checking=false;}
 }
}
