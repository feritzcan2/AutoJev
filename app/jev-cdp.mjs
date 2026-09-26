// Playwright normally auto-attaches every personal tab and waits for all of them
// to initialize. Expose only task-owned windows to its CDP connection instead.
export class JevCdpTransport {
  constructor(socket){
    this.socket=socket;this.owned=new Set();this.attached=new Set();this.pending=new Map();this.sequence=1000000000;
    socket.onmessage=event=>this.receive(JSON.parse(event.data));
    socket.onclose=()=>{for(const {reject,timer} of this.pending.values()){clearTimeout(timer);reject(Error('Chrome bağlantısı kapandı.'));}this.pending.clear();this.onclose?.();};
  }
  static async connect(endpoint){
    const socket=new WebSocket(endpoint);
    await new Promise((resolve,reject)=>{
      const fail=message=>{clearTimeout(timer);socket.onerror=()=>{};socket.onclose=null;reject(Error(message));socket.close();};
      const timer=setTimeout(()=>fail('Chrome bağlantı izni beklenirken zaman aşımı.'),30000);
      socket.onopen=()=>{clearTimeout(timer);socket.onerror=()=>{};socket.onclose=null;resolve();};
      socket.onerror=()=>fail('Chrome bağlantısı kurulamadı.');
      socket.onclose=()=>fail('Chrome bağlantısı kurulmadan kapandı.');
    });
    return new JevCdpTransport(socket);
  }
  call(method,params={}){
    if(this.socket.readyState!==WebSocket.OPEN)return Promise.reject(Error('Chrome bağlantısı kapandı.'));
    return new Promise((resolve,reject)=>{
      const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`Chrome ${method} zaman aşımı.`));},15000);
      this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));
    });
  }
  async ownWindow(marker){
    for(let i=0;i<100;i++){
      const {targetInfos}=await this.call('Target.getTargets');
      const target=targetInfos.find(target=>target.type==='page'&&target.url===marker);
      if(target){this.owned.add(target.targetId);if(this.ready)await this.attach(target.targetId);return target.targetId;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Yeni Jev penceresi bulunamadı; mevcut sekmeler korunuyor.');
  }
  async attach(targetId){
    if(this.attached.has(targetId))return;
    this.attached.add(targetId);
    try{await this.call('Target.attachToTarget',{targetId,flatten:true});}catch(error){this.attached.delete(targetId);throw error;}
  }
  receive(message){
    const pending=this.pending.get(message.id);
    if(pending){clearTimeout(pending.timer);this.pending.delete(message.id);message.error?pending.reject(Error(message.error.message)):pending.resolve(message.result);return;}
    if(!message.sessionId&&['Target.targetCreated','Target.targetInfoChanged'].includes(message.method)){
      const target=message.params.targetInfo;
      if(target.type==='page'&&this.owned.has(target.openerId)&&!this.owned.has(target.targetId)){
        this.owned.add(target.targetId);if(this.ready)this.attach(target.targetId).catch(()=>{});
      }
      return;
    }
    this.onmessage?.(message);
  }
  send(message){
    // Browser-level auto-attach is replaced by explicit attachment to owned tabs.
    if(!message.sessionId&&message.method==='Target.setAutoAttach'){
      (async()=>{
        this.ready=true;
        await this.call('Target.setDiscoverTargets',{discover:true});
        for(const targetId of this.owned)await this.attach(targetId);
        this.onmessage?.({id:message.id,result:{}});
      })().catch(error=>this.onmessage?.({id:message.id,error:{code:-32000,message:error.message}}));
      return;
    }
    if(!message.sessionId&&message.method==='Browser.close'){this.close();return;}
    this.socket.send(JSON.stringify(message));
  }
  close(){this.socket.close();}
}
