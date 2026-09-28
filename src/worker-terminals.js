import {XtermSurface} from '@termloop/terminal-surface/xterm';
import './worker-terminals.css';

const states={Working:'Çalışıyor',Idle:'Hazır',AwaitingInput:'Giriş bekliyor',Compacting:'Özetliyor',Failed:'Hata',Interrupted:'Kesildi',Unknown:'Bağlanıyor'};
const clear=new TextEncoder().encode('\x1b[2J\x1b[3J\x1b[H');
const node=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls;if(text!==undefined)el.textContent=text;return el;};

export function workerTerminals(api,{container,notice,refresh}){
  let candidate=null,snapshot=null,adding=false;
  const panes=new Map();
  container.classList.add('worker-terminals');
  container.innerHTML='<div class="worker-toolbar"><div><h2>Agent worker’ları</h2><p>Her worker arama, puanlama ve başvuru işlerini ortak kuyruktan alır.</p></div><div class="worker-add"><button id="worker-add" class="primary" type="button">＋ Worker ekle</button></div></div><div class="worker-splits" aria-label="Worker terminalleri"></div>';
  const splits=container.querySelector('.worker-splits'),add=container.querySelector('#worker-add');
  add.onclick=async()=>{if(!candidate||adding)return;const id=candidate;adding=true;add.disabled=true;try{await api.addWorker(id);await refresh();}catch(error){notice(error.message);}finally{adding=false;add.disabled=!candidate||panes.size>=8;}};
  function dispose(){for(const pane of panes.values()){pane.dead=true;pane.surface.dispose();pane.host.remove();}panes.clear();splits.replaceChildren();}
  function syncSize(pane){
    if(!pane.size||!pane.worker.active||pane.dead)return;
    const {rows,cols}=pane.size,session=pane.worker.active.sessionId,key=`${session}:${pane.worker.active.state}:${rows}:${cols}`;
    if(pane.sentSize===key)return;pane.sentSize=key;
    api.resize(pane.candidate,rows,cols,pane.id,session).catch(()=>{pane.sentSize=null;});
  }
  async function replay(pane){
    const version=++pane.version;pane.loading=true;pane.pending=[];
    try{
      await pane.ready;
      const output=await api.terminalOutput(pane.candidate,pane.id);
      if(pane.dead||version!==pane.version)return;
      pane.surface.write(clear,()=>{});
      if(output.bytes.length)pane.surface.write(new Uint8Array(output.bytes),()=>{});
      else pane.surface.writeln('Görev başladığında agent çıktısı burada görünecek.');
      pane.sequence=output.sequence;
      for(const event of pane.pending)if(event.sequence>pane.sequence){pane.surface.write(new Uint8Array(event.bytes),()=>{});pane.sequence=event.sequence;}
    }catch(error){if(!pane.dead&&version===pane.version)notice(error.message);}
    finally{if(version===pane.version){pane.loading=false;pane.pending=[];}}
  }
  async function action(pane,method){
    if(pane.busy||pane.dead)return;pane.busy=true;render(pane);
    try{await api[method](pane.candidate,pane.id);await refresh();}catch(error){notice(error.message);}
    finally{pane.busy=false;if(!pane.dead)render(pane);}
  }
  function create(worker){
    const pane={id:worker.id,candidate,worker,version:0,sequence:0,pending:[],loading:true,dead:false,busy:false};
    const card=node('section','worker-pane');card.dataset.workerId=worker.id;card.setAttribute('aria-label',`${worker.name} terminali`);
    const top=node('div','worker-pane-head'),identity=node('div','worker-identity'),name=node('h3','',worker.name),status=node('span','worker-status');
    identity.append(name,status);const controls=node('div','worker-controls');
    const start=node('button','quiet','Başlat'),stop=node('button','quiet','Durdur'),restart=node('button','quiet','Yenile'),remove=node('button','quiet worker-remove','×');
    for(const [button,method,label] of [[start,'startWorker','başlat'],[stop,'stopWorker','durdur'],[restart,'restartWorker','yeniden başlat'],[remove,'removeWorker','kaldır']]){button.type='button';button.setAttribute('aria-label',`${worker.name} ${label}`);button.title=`${worker.name} ${label}`;button.onclick=()=>action(pane,method);controls.append(button);}
    remove.hidden=worker.id==='main';top.append(identity,controls);
    const task=node('div','worker-task'),title=node('strong','worker-task-title'),detail=node('small','worker-task-detail');task.append(title,detail);
    const host=node('div','worker-terminal');if(worker.id==='main')host.id='terminal';
    card.append(top,task,host);splits.append(card);
    Object.assign(pane,{card,host,status,title,detail,start,stop,restart,remove});
    pane.surface=new XtermSurface(text=>{const active=pane.worker.active;if(!pane.dead&&active)api.input(pane.candidate,text,pane.id,active.sessionId).catch(error=>notice(error.message));},(rows,cols)=>{pane.size={rows,cols};syncSize(pane);},()=>notice('Belge eklemek için aday profilindeki CV seç düğmesini kullan.'));
    panes.set(worker.id,pane);pane.ready=pane.surface.mount(host,false);pane.session=worker.active?.sessionId??null;
    void replay(pane);render(pane);return pane;
  }
  function render(pane){
    const {worker}=pane,c=worker.campaign,task=c?.task,active=worker.active;
    const job=snapshot?.jobs?.find(j=>j.id===task?.jobId),source=snapshot?.sources?.find(s=>s.id===task?.sourceId);
    pane.status.textContent=active?(states[active.state]??'Bağlanıyor'):c?.status==='running'?'Görev bekliyor':c?.status==='complete'?'Tamamlandı':'Kapalı';
    pane.status.dataset.active=String(Boolean(active));
    pane.title.textContent=task?.kind==='search'?`${source?.name??'Kaynak'} taranıyor`:job?`${job.company} · ${job.role}`:c?.status==='running'?'Sıradaki görev bekleniyor':'Arama, puanlama ve başvuru';
    pane.title.title=pane.title.textContent;
    const usage=active?.contextUsage?.percent;
    pane.detail.textContent=[task?({search:'İlan arama',rank:'İlan puanlama',application:'Başvuru',preparation:'Başvuru hazırlığı',verify:'Gönderim kontrolü'}[task.kind]):c?.note??'Başlatıldığında uygun işi kuyruktan alır.',usage!=null?`Context %${usage.toLocaleString('tr-TR',{maximumFractionDigits:1})}`:null].filter(Boolean).join(' · ');
    pane.start.hidden=Boolean(active)||c?.status==='running';pane.stop.hidden=pane.start.hidden===false;
    pane.start.disabled=pane.busy||!snapshot?.profile.cvPath;pane.stop.disabled=pane.busy;pane.restart.disabled=pane.busy||!snapshot?.profile.cvPath;pane.remove.disabled=pane.busy;
    pane.card.setAttribute('aria-busy',String(pane.busy));syncSize(pane);
  }
  function separators(){
    splits.querySelectorAll('.worker-divider').forEach(el=>el.remove());
    const cards=[...panes.values()].map(p=>p.card);
    for(let i=1;i<cards.length;i++){
      const left=cards[i-1],right=cards[i],divider=node('div','worker-divider');divider.tabIndex=0;divider.setAttribute('role','separator');divider.setAttribute('aria-orientation','vertical');divider.setAttribute('aria-label','Terminal genişliğini ayarla');divider.setAttribute('aria-valuemin','20');divider.setAttribute('aria-valuemax','80');divider.setAttribute('aria-valuenow','50');
      const resize=(delta,a=left.getBoundingClientRect().width,b=right.getBoundingClientRect().width)=>{const size=Math.max(320,Math.min(a+b-320,a+delta));left.style.flex=`0 0 ${size}px`;right.style.flex=`0 0 ${a+b-size}px`;divider.setAttribute('aria-valuenow',String(Math.round(size/(a+b)*100)));};
      divider.onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();resize(event.key==='ArrowLeft'?-24:24);};
      divider.onpointerdown=event=>{event.preventDefault();const x=event.clientX,a=left.getBoundingClientRect().width,b=right.getBoundingClientRect().width;divider.setPointerCapture(event.pointerId);divider.onpointermove=move=>resize(move.clientX-x,a,b);divider.onpointerup=()=>{divider.onpointermove=null;divider.releasePointerCapture(event.pointerId);};divider.onpointercancel=()=>{divider.onpointermove=null;};};
      right.before(divider);
    }
  }
  function update(id,value){
    if(candidate!==id){dispose();candidate=id;}snapshot=value;
    const workers=value?.workers??(id?[{id:'main',name:'Worker 1',campaign:value?.campaign,active:value?.active}]:[]);
    let changed=false;
    for(const [worker,pane] of panes)if(!workers.some(w=>w.id===worker)){pane.dead=true;pane.surface.dispose();pane.host.remove();pane.card.remove();panes.delete(worker);changed=true;}
    for(const worker of workers){let pane=panes.get(worker.id);if(!pane){pane=create(worker);changed=true;}else{pane.worker=worker;if(worker.active?.sessionId&&pane.session!==worker.active.sessionId){pane.session=worker.active.sessionId;void replay(pane);}render(pane);}}
    if(changed)separators();
    const main=panes.get('main');if(main){const home=value?.setup?.status==='running'?document.getElementById('setup-terminal'):main.card;if(home&&main.host.parentElement!==home)home.append(main.host);}
    add.disabled=adding||!id||workers.length>=8||Boolean(value?.setup&&value.setup.status!=='complete');
  }
  function event(event){
    if(event.candidateId!==candidate)return;
    const pane=panes.get(event.workerId??'main');if(!pane||pane.dead)return;
    if(event.event==='output'){
      if(pane.loading)pane.pending.push(event);
      else if(event.sequence>pane.sequence){pane.surface.write(new Uint8Array(event.bytes),()=>{});pane.sequence=event.sequence;}
    }else if(event.event==='gap')pane.surface.writeln('\r\n[Terminal çıktısının bir kısmı atlandı]');
    else if(event.event==='state'&&pane.worker.active?.sessionId===event.sessionId){pane.worker.active.state=event.state.replace(/^Some\((.*)\)$/,'$1');render(pane);}
  }
  api.onLogsCleared?.(()=>{for(const pane of panes.values()){pane.version++;pane.loading=false;pane.pending=[];pane.surface.write(clear,()=>{});}});
  return {update,event,dispose};
}
