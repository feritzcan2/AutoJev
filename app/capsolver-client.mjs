import {setTimeout as delay} from 'node:timers/promises';

const messages={ERROR_ZERO_BALANCE:'CapSolver bakiyesi yetersiz.',ERROR_KEY_DOES_NOT_EXIST:'CapSolver anahtarı kabul edilmedi.',ERROR_CAPTCHA_UNSOLVABLE:'CapSolver bu doğrulamayı çözemedi.',ERROR_INVALID_TASK_DATA:'Doğrulama bilgileri CapSolver tarafından kabul edilmedi.'};
export class CaptchaError extends Error {
 constructor(code,message){super(message);this.code=code;}
}
// The endpoint is fixed. Neither page content nor agent input can redirect a key.
export class CapsolverClient {
 constructor({fetchImpl=fetch,pollMs=3000,requestMs=15000}={}){Object.assign(this,{fetchImpl,pollMs,requestMs});}
 async request(method,apiKey,input={},signal){
  signal?.throwIfAborted();
  const timeout=AbortSignal.timeout(this.requestMs),abort=signal?AbortSignal.any([signal,timeout]):timeout;
  try{
   const response=await this.fetchImpl(`https://api.capsolver.com/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientKey:apiKey,...input}),redirect:'error',signal:abort});
   if(!response.ok){await response.body?.cancel().catch(()=>{});throw new CaptchaError('CAPTCHA_HTTP',`CapSolver bağlantısı tamamlanamadı (HTTP ${response.status}).`);}
   const reader=response.body.getReader(),parts=[];let size=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144)throw new CaptchaError('CAPTCHA_RESPONSE','CapSolver yanıtı geçersiz.');parts.push(value);}}
   finally{await reader.cancel().catch(()=>{});}
   let value;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new CaptchaError('CAPTCHA_RESPONSE','CapSolver yanıtı okunamadı.');}
   if(!value||typeof value!=='object'||!Number.isInteger(value.errorId))throw new CaptchaError('CAPTCHA_RESPONSE','CapSolver yanıtı geçersiz.');
   // Never echo server errorDescription: it can contain submitted data/secrets.
   if(value.errorId!==0)throw new CaptchaError(Object.hasOwn(messages,value.errorCode)?value.errorCode:'CAPTCHA_PROVIDER',messages[value.errorCode]??'CapSolver çözüm isteğini tamamlayamadı.');
   return value;
  }catch(error){signal?.throwIfAborted();if(error instanceof CaptchaError)throw error;throw new CaptchaError('CAPTCHA_NETWORK','CapSolver bağlantısı zamanında tamamlanamadı.');}
 }
 async balance(apiKey,signal){const value=await this.request('getBalance',apiKey,{},signal);if(!Number.isFinite(value.balance)||value.balance<0)throw new CaptchaError('CAPTCHA_RESPONSE','CapSolver bakiye yanıtı geçersiz.');return value.balance;}
 async solve(apiKey,task,{signal,onTask=()=>{}}={}){
  let value=await this.request('createTask',apiKey,{task},signal);
  if(typeof value.taskId==='string'&&value.taskId.length<=200)onTask(value.taskId);
  for(let polls=0;;polls++){
   signal?.throwIfAborted();
   if(value.status==='ready'){
    if(!value.solution||typeof value.solution!=='object')throw new CaptchaError('CAPTCHA_RESPONSE','CapSolver çözüm yanıtı geçersiz.');
    return value.solution;
   }
   if(polls>=30||!['idle','processing',undefined].includes(value.status)||typeof value.taskId!=='string'||value.taskId.length>200)throw new CaptchaError('CAPTCHA_RESPONSE','CapSolver görev sonucu alınamadı.');
   await delay(this.pollMs,undefined,{signal});
   value={...await this.request('getTaskResult',apiKey,{taskId:value.taskId},signal),taskId:value.taskId};
  }
 }
}
