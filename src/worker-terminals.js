import {XtermSurface} from '@termloop/terminal-surface/xterm';
import './worker-terminals.css';
import {workerPane} from './worker-pane.js';
import {terminalConversation} from './terminal-conversation.js';

const states={Working:'Çalışıyor',Idle:'Hazır',AwaitingInput:'Giriş bekliyor',Compacting:'Özetliyor',Failed:'Hata',Interrupted:'Kesildi',Unknown:'Bağlanıyor'};
const clear=new TextEncoder().encode('\x1b[2J\x1b[3J\x1b[H');
const node=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls;if(text!==undefined)el.textContent=text;return el;};

export function workerTerminals(api,{container,notice,refresh,beforeAction=async()=>{},sendMessage=(id,text,worker)=>api.terminalMessage(id,text,worker)}){
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
      pane.sequence=output.sequence;pane.promptShown=false;
      for(const event of pane.pending)if(event.sequence>pane.sequence){pane.surface.write(new Uint8Array(event.bytes),()=>{});pane.sequence=event.sequence;}
    }catch(error){if(!pane.dead&&version===pane.version)notice(error.message);}
    finally{if(version===pane.version){pane.loading=false;pane.pending=[];showPrompt(pane);}}
  }
  async function action(pane,method){
    if(pane.busy||pane.dead)return;pane.busy=true;render(pane);
    try{if(await beforeAction(pane.candidate,method,pane.id)!==false)await api[method](pane.candidate,pane.id);await refresh();}catch(error){notice(error.message);}
    finally{pane.busy=false;if(!pane.dead)render(pane);}
  }
  function create(worker){
    const pane={id:worker.id,candidate,worker,version:0,sequence:0,pending:[],loading:true,dead:false,busy:false};
    Object.assign(pane,workerPane({id:worker.id,name:worker.name,terminalId:worker.id==='main'?'terminal':null,actions:{start:()=>action(pane,'startWorker'),stop:()=>action(pane,'stopWorker'),restart:()=>action(pane,'restartWorker'),remove:()=>action(pane,'removeWorker')}}));
    const {host}=pane;splits.append(pane.card);
    pane.draft=terminalConversation({write:text=>pane.surface.write(new TextEncoder().encode(text),()=>{}),columns:()=>pane.size?.cols??80,submit:async text=>{await sendMessage(pane.candidate,text,pane.id);await refresh();pane.host.querySelector('.xterm-helper-textarea')?.focus();}});
    pane.surface=new XtermSurface(text=>{if(pane.dead)return;const active=pane.worker.active;if(active)api.input(pane.candidate,text,pane.id,active.sessionId).catch(error=>notice(error.message));else pane.draft.input(text);},(rows,cols)=>{pane.size={rows,cols};syncSize(pane);},()=>notice('Belge eklemek için Dosyalar sayfasını kullan.'));
    panes.set(worker.id,pane);pane.ready=pane.surface.mount(host,false);pane.session=worker.active?.sessionId??null;
    void replay(pane);render(pane);return pane;
  }
  function showPrompt(pane){if(!pane.loading&&!pane.dead&&!pane.worker.active&&!pane.promptShown){pane.promptShown=true;pane.draft.prompt();}}
  function render(pane){
    const {worker}=pane,c=worker.execution,active=worker.active,paused=worker.enabled===false&&!active;
    pane.status.textContent=paused?'Durduruldu':worker.presentation?.status??(active?(states[active.state]??'Bağlanıyor'):c?.status==='running'?'Görev bekliyor':c?.status==='complete'?'Tamamlandı':'Kapalı');
    pane.status.dataset.active=String(Boolean(active));
    pane.title.textContent=paused?'Worker durduruldu':worker.presentation?.title??'Sıradaki görev bekleniyor';
    pane.title.title=pane.title.textContent;
    const usage=active?.contextUsage?.percent;
    pane.detail.textContent=paused?'Başlattığında sıradaki görevi alır.':[worker.presentation?.detail??c?.note??'Başlatıldığında uygun işi kuyruktan alır.',usage!=null?`Context %${usage.toLocaleString('tr-TR',{maximumFractionDigits:1})}`:null].filter(Boolean).join(' · ');
    pane.start.hidden=Boolean(active)||c?.status==='running';pane.stop.hidden=pane.start.hidden===false;
    pane.start.textContent=worker.presentation?.startLabel??'Başlat';pane.start.setAttribute('aria-label',worker.presentation?.startLabel??`${worker.name} başlat`);
    const outcome=worker.presentation?.outcome;pane.outcome.hidden=!outcome;
    if(outcome){pane.outcomeTitle.textContent=outcome.title;pane.outcomeDetail.textContent=outcome.detail;pane.outcome.dataset.tone=outcome.tone;}
    pane.inputHint.hidden=!snapshot?.capabilities?.terminalConversation;pane.inputHint.textContent=active?'Canlı terminal · Yazdıkların çalışan agent’a iletilir.':'Oturum kapalı · Yukarıdaki çıktı önceki oturuma ait. Yeni mesaj yazıp Enter’a basarak agent ile konuşabilirsin.';
    pane.start.disabled=pane.busy||!(snapshot?.capabilities?.canStart??false);pane.stop.disabled=pane.busy;pane.restart.disabled=pane.busy||!(snapshot?.capabilities?.canRestart??false);pane.remove.disabled=pane.busy;
    pane.restart.hidden=!snapshot?.capabilities?.workerRestart;pane.card.setAttribute('aria-busy',String(pane.busy));syncSize(pane);showPrompt(pane);
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
    const workers=value?.workers??(id?[{id:'main',name:'Worker 1',execution:value?.execution,active:value?.active}]:[]);
    let changed=false;
    for(const [worker,pane] of panes)if(!workers.some(w=>w.id===worker)){pane.dead=true;pane.surface.dispose();pane.host.remove();pane.card.remove();panes.delete(worker);changed=true;}
    for(const worker of workers){let pane=panes.get(worker.id);if(!pane){pane=create(worker);changed=true;}else{const ended=pane.worker.active&&!worker.active;pane.worker=worker;if(worker.active?.sessionId&&pane.session!==worker.active.sessionId){pane.session=worker.active.sessionId;void replay(pane);}if(ended){pane.promptShown=false;if(snapshot?.capabilities?.terminalConversation)pane.surface.writeln('\r\n── Oturum sona erdi · Sonuç ve sonraki adım aşağıda ──');}render(pane);}}
    if(changed)separators();
    const main=panes.get('main');if(main){const home=value?.setup?.status==='running'?document.getElementById('setup-terminal'):main.card;if(home&&main.host.parentElement!==home)home.append(main.host);}
    const maxWorkers=value?.capabilities?.maxWorkers??8;add.hidden=maxWorkers===1;container.querySelector('.worker-toolbar p').textContent=value?.capabilities?.workerDescription??'Worker’lar çalışma alanının görevlerini ortak kuyruktan alır.';
    add.disabled=adding||!id||workers.length>=maxWorkers||Boolean(value?.setup&&value.setup.status!=='complete');
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
  return {update,event,dispose,focus(){panes.get('main')?.host.querySelector('.xterm-helper-textarea')?.focus();}};
}
