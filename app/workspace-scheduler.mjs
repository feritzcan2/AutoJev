// One application clock. Template policies select eligible work; task and agent
// services own lifecycle/locking. Dispatch never overlaps another scheduler tick.
export class WorkspaceScheduler {
 constructor({available=()=>true,onError=()=>{},now=()=>Date.now()}={}){Object.assign(this,{available,onError,now});this.entries=[];this.busy=false;this.closed=false;}
 register(name,tick,{interval=1000}={}){this.entries.push({name,tick,interval,next:0});}
 async tick(){if(this.closed||this.busy||!this.available())return;this.busy=true;try{for(const entry of this.entries){if(this.closed||!this.available())break;if(entry.next>this.now())continue;entry.next=this.now()+entry.interval;try{await entry.tick();}catch(error){this.onError(error,entry.name);}}}finally{this.busy=false;}}
 start(){if(!this.timer)this.timer=setInterval(()=>{void this.tick();},1000);}
 close(){this.closed=true;clearInterval(this.timer);this.timer=null;}
}
