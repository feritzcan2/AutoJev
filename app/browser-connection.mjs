// Connection work belongs to the app, not to an agent turn. One in-flight
// handshake per candidate, with bounded backoff and no polling model calls.
export const browserWaitResult=()=>({status:'browser_wait',nextAction:'end_turn',message:'Chrome bağlantısı uygulama tarafından bekleniyor. Soru, blocked durumu veya görev raporu oluşturma. Turu bitir; bağlantı hazır olunca aynı görev otomatik sürdürülecek.'});
export class BrowserConnections {
  constructor({connect,changed=()=>{},now=()=>Date.now()}){Object.assign(this,{connect,changed,now});this.states=new Map();this.pending=new Map();this.epochs=new Map();this.closed=false;}
  status(id){return this.states.get(id)??{state:'idle',ready:false,attempts:0};}
  set(id,state){if(this.closed)return;this.states.set(id,state);this.changed(id,state);return state;}
  disconnected(id){this.epochs.set(id,(this.epochs.get(id)??0)+1);const old=this.status(id);this.set(id,{...old,state:'waiting',ready:false,retryAt:this.now()+2000,message:'Chrome bağlantısı kesildi. Aynı görev bağlantıyı bekliyor.'});}
  prepare(id,{force=false}={}){
    const state=this.status(id);
    if(this.closed||state.ready||this.pending.has(id)||!force&&state.retryAt>this.now())return state;
    const epoch=this.epochs.get(id)??0;const publish=state=>{if((this.epochs.get(id)??0)===epoch)this.set(id,state);};
    const attempt=(state.attempts??0)+1;
    this.set(id,{state:'connecting',ready:false,attempts:attempt,message:'Chrome bağlantısı kuruluyor…'});
    const pending=Promise.resolve().then(()=>this.connect(id)).then(()=>publish({state:'ready',ready:true,attempts:0,connectedAt:this.now()}),error=>publish({state:'waiting',ready:false,attempts:attempt,retryAt:this.now()+Math.min(30000,2000*2**Math.min(attempt-1,4)),message:String(error.message).split('\n')[0].slice(0,600)})).finally(()=>this.pending.delete(id));
    this.pending.set(id,pending);return this.status(id);
  }
  reset(id){this.epochs.set(id,(this.epochs.get(id)??0)+1);this.states.delete(id);}
  close(){this.closed=true;}
}
