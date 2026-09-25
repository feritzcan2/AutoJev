import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
export class Engine {
  constructor(binary,directory,onEvent){
    this.pending=new Map();this.child=spawn(binary,[directory],{stdio:['pipe','pipe','pipe']});
    const lines=createInterface({input:this.child.stdout});
    lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}
      if(value.id){const p=this.pending.get(value.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(value.id);value.error?p.reject(Error(value.error)):p.resolve(value.result);}
      else onEvent(value);
    });
    this.child.stderr.on('data',data=>onEvent({event:'diagnostic',text:data.toString().slice(-4000)}));
    const fail=message=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(message));}this.pending.clear();onEvent({event:'engine_exit',message});};
    this.child.on('error',e=>fail(e.message));this.child.on('exit',(code,signal)=>fail(`Engine exited: ${code??signal}`));
  }
  request(op,args={}){return new Promise((resolve,reject)=>{
    const id=randomUUID();const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Motor yanıtı zaman aşımına uğradı; tekrar başlatmadan önce durumu kontrol et.'));},60000);
    this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,op,...args})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
  });}
  async close(){
    let timer;try{await Promise.race([this.request('stop'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Motor kapanma zaman aşımı')),8000);})]);}
    finally{clearTimeout(timer);this.child.stdin.end();if(this.child.exitCode===null){const child=this.child;const kill=setTimeout(()=>child.kill('SIGKILL'),3000);kill.unref();child.once('exit',()=>clearTimeout(kill));}}
  }
}
