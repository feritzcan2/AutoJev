// Serialize disk-wide operations against IPC, schedulers and live agents.
export class Maintenance {
 constructor({assertIdle,stop,resume}){Object.assign(this,{assertIdle,stop,resume});this.busy=false;this.pending=new Set();}
 assertAvailable(){if(this.busy)throw Error('Yedekleme, geri yükleme veya güncelleme sürüyor. İşlem bitince tekrar dene.');}
 async invoke(name,fn){
  this.assertAvailable();
  if(['data-backup','data-restore','data-clear-logs','update-install'].includes(name))return fn();
  const token={name};this.pending.add(token);
  try{return await fn();}finally{this.pending.delete(token);}
 }
 async run(fn,{hold=false}={}){
  this.assertAvailable();this.busy=true;let stopped=false,completed=false;
  try{
   if(this.pending.size)throw Error('Devam eden işlemin bitmesini bekle ve tekrar dene.');
   this.assertIdle();stopped=true;await this.stop();this.assertIdle();
   const result=await fn();completed=true;return result;
  }finally{
   if(!completed||!(typeof hold==='function'?hold():hold)){try{if(stopped)await this.resume();}finally{this.busy=false;}}
  }
 }
 async release(){try{await this.resume();}finally{this.busy=false;}}
}
