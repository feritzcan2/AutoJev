import {WorkerTerminalSurface} from './worker-terminal-surface.js';
import './worker-terminals.css';
import {workerPane} from './worker-pane.js';
import {terminalConversation} from './terminal-conversation.js';
import {scanPageLabel} from '../app/scan-page.mjs';
import {workerConversation,conversationSignature} from './worker-conversation.js';
import {terminalAttention} from './agent-attention.js';
import {providerLimitAttention} from '../app/provider-limit.mjs';

const states={Working:'Çalışıyor',Idle:'Hazır',AwaitingInput:'Giriş bekliyor',Compacting:'Özetliyor',Failed:'Hata',Interrupted:'Kesildi',Unknown:'Bağlanıyor'};
const clear=new TextEncoder().encode('\x1b[2J\x1b[3J\x1b[H');
const node=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls;if(text!==undefined)el.textContent=text;return el;};
const viewKey=(candidate,worker)=>`worker-view:${candidate}:${worker}`;
const savedView=(candidate,worker)=>{try{return localStorage.getItem(viewKey(candidate,worker))==='chat'?'chat':'terminal';}catch{return 'terminal';}};
const saveView=(candidate,worker,view)=>{try{localStorage.setItem(viewKey(candidate,worker),view);}catch{}};
const roleNames={user:'Sen',agent:'Agent',system:'Kayıt',task:'Görev'};
const clock=value=>{const at=Date.parse(value??'');return Number.isFinite(at)?new Date(at).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}):'';};

export function workerTerminals(api,{container,notice,refresh,beforeAction=async()=>{},sendMessage=(id,text,worker)=>api.terminalMessage(id,text,worker)}){
  let candidate=null,snapshot=null,adding=false;
  const panes=new Map();
  container.classList.add('worker-terminals');
  container.innerHTML='<div class="worker-toolbar"><div><h2>Agent worker’ları</h2><p>Her worker arama, puanlama ve başvuru işlerini ortak kuyruktan alır.</p></div><div class="worker-add"><button id="worker-add" class="primary" type="button">＋ Worker ekle</button></div></div><div class="worker-splits" aria-label="Worker terminalleri"></div>';
  const splits=container.querySelector('.worker-splits'),add=container.querySelector('#worker-add');
  add.onclick=async()=>{if(!candidate||adding)return;const id=candidate;adding=true;add.disabled=true;try{await api.addWorker(id);await refresh();}catch(error){notice(error.message);}finally{adding=false;add.disabled=!candidate||panes.size>=8;}};
  function dispose(){for(const pane of panes.values()){pane.dead=true;pane.surface.dispose();pane.host.remove();}panes.clear();splits.replaceChildren();}
  function syncSize(pane){
    if(!pane.size||pane.dead||pane.loading)return;
    const {rows,cols}=pane.size,session=pane.worker.active?.sessionId,key=`${session??'idle'}:${rows}:${cols}`;
    if(pane.sentSize===key)return;pane.sentSize=key;
    api.resize(pane.candidate,rows,cols,pane.id,session).catch(()=>{pane.sentSize=null;});
  }
  async function replay(pane){
    const version=++pane.version;pane.loading=true;pane.pending=[];pane.promptAttention=null;pane.dismissedPrompt=false;
    try{
      await pane.ready;
      const output=await api.terminalOutput(pane.candidate,pane.id);
      if(pane.dead||version!==pane.version)return;
      await pane.surface.restore(output);
      if(pane.dead||version!==pane.version)return;
      if(output.bytes.length)sampleAttention(pane);
      else pane.surface.writeln('Görev başladığında agent çıktısı burada görünecek.');
      pane.hasOutput=output.bytes.length>0;pane.sequence=output.sequence;pane.promptShown=false;
      while(pane.pending.length){
        const pending=pane.pending;pane.pending=[];
        for(const event of pending)if(event.sequence>pane.sequence){pane.surface.write(new Uint8Array(event.bytes),()=>sampleAttention(pane));pane.sequence=event.sequence;}
        await pane.surface.flush();
        if(pane.dead||version!==pane.version)return;
      }
    }catch(error){if(!pane.dead&&version===pane.version)notice(error.message);}
    finally{if(!pane.dead&&version===pane.version){pane.loading=false;pane.pending=[];pane.surface.finishRestore();syncSize(pane);showPrompt(pane);render(pane);}}
  }
  async function action(pane,method){
    if(pane.busy||pane.dead)return;pane.busy=true;render(pane);
    try{if(await beforeAction(pane.candidate,method,pane.id)!==false)await api[method](pane.candidate,pane.id);await refresh();}catch(error){notice(error.message);}
    finally{pane.busy=false;if(!pane.dead)render(pane);}
  }
  function create(worker){
    const pane={id:worker.id,candidate,worker,version:0,sequence:0,pending:[],loading:true,dead:false,busy:false};
    Object.assign(pane,workerPane({id:worker.id,name:worker.name,terminalId:worker.id==='main'?'terminal':null,showChat:!snapshot?.automation,view:snapshot?.automation?'terminal':savedView(candidate,worker.id),onView:view=>{saveView(pane.candidate,pane.id,view);pane.chatSignature=null;pane.follow=true;if(!pane.dead){render(pane);requestAnimationFrame(()=>{pane.chatLog.scrollTop=pane.chatLog.scrollHeight;});void pollTranscript(pane);}},actions:{start:()=>action(pane,'startWorker'),stop:()=>action(pane,'stopWorker'),restart:()=>action(pane,'restartWorker'),remove:()=>action(pane,'removeWorker')}}));
    const {host}=pane;splits.append(pane.card);pane.local=[];pane.chatSignature=null;pane.follow=true;
    pane.idleHistory.onclick=()=>{pane.showHistory=!pane.showHistory;render(pane);};
    // Follow the newest message until the reader scrolls up; a jump pill brings them back.
    pane.chatLog.onscroll=()=>{const log=pane.chatLog;pane.follow=log.scrollHeight-log.scrollTop-log.clientHeight<40;if(pane.follow)pane.chatJump.hidden=true;};
    pane.chatJump.onclick=()=>{pane.follow=true;pane.chatJump.hidden=true;pane.chatLog.scrollTo({top:pane.chatLog.scrollHeight,behavior:'smooth'});};
    pane.chatForm.onsubmit=async event=>{
      event.preventDefault();const text=pane.chatInput.value.trim();if(!text||pane.sending||pane.dead)return;
      pane.sending=true;pane.chatSend.disabled=true;pane.chatInput.disabled=true;
      const echo={id:`local:${Date.now()}`,role:'user',text,at:new Date().toISOString(),local:true};pane.local.push(echo);pane.chatSignature=null;renderChat(pane);
      try{
        const active=pane.worker.active;
        if(active)await api.input(pane.candidate,text+'\r',pane.id,active.sessionId);else await sendMessage(pane.candidate,text,pane.id);
        pane.chatInput.value='';pane.chatInput.style.height='auto';await refresh();
      }catch(error){pane.local=pane.local.filter(m=>m!==echo);pane.chatSignature=null;notice(error.message);}
      finally{pane.sending=false;if(!pane.dead){pane.chatSend.disabled=false;pane.chatInput.disabled=false;renderChat(pane);pane.chatInput.focus();}}
    };
    pane.draft=terminalConversation({write:text=>pane.surface.write(new TextEncoder().encode(text),()=>{}),columns:()=>pane.size?.cols??80,submit:async text=>{await sendMessage(pane.candidate,text,pane.id);await refresh();pane.host.querySelector('.xterm-helper-textarea')?.focus();}});
    pane.surface=new WorkerTerminalSurface(text=>{if(pane.dead)return;const active=pane.worker.active;if(active){if((/[\r\n\x03]/.test(text)||text==='\x1b')&&pane.promptAttention){pane.dismissedPrompt=true;render(pane);}api.input(pane.candidate,text,pane.id,active.sessionId).catch(error=>notice(error.message));}else pane.draft.input(text);},(rows,cols)=>{pane.size={rows,cols};syncSize(pane);},()=>notice('Belge eklemek için Dosyalar sayfasını kullan.'));
    panes.set(worker.id,pane);pane.ready=pane.surface.mount(host,false);pane.session=worker.active?.sessionId??null;
    void replay(pane);render(pane);void pollTranscript(pane);return pane;
  }
  function renderChat(pane){
    if(pane.view()!=='chat')return;
    const saved=workerConversation(snapshot,pane.worker,pane.transcript??[]),texts=new Set(saved.filter(e=>e.role==='user').map(e=>e.text));
    pane.local=pane.local.filter(m=>!texts.has(m.text));
    const entries=[...saved,...pane.local],signature=conversationSignature(entries);
    if(signature===pane.chatSignature)return;pane.chatSignature=signature;
    const log=pane.chatLog;log.replaceChildren();
    if(!entries.length){const empty=node('div','worker-chat-empty');empty.append(node('strong','','Henüz kayıtlı konuşma yok'),node('span','',pane.worker.active?'Agent çalışırken bildirdiği adımlar ve gönderdiğin mesajlar burada sıralanır. Ham çıktı için Terminal görünümüne geç.':'Aşağıya yazarak konuşmayı başlat. Kayıtlı bildirimler ve mesajlar burada birikir.'));log.append(empty);return;}
    let lastDay=null;
    for(const entry of entries){
      const day=entry.at?new Date(entry.at).toDateString():null;
      if(day&&day!==lastDay){lastDay=day;log.append(node('div','worker-chat-day',new Date(entry.at).toLocaleDateString('tr-TR',{day:'numeric',month:'long'})));}
      const bubble=node('article','worker-chat-entry');bubble.dataset.role=entry.role;if(entry.pending)bubble.dataset.pending='true';if(entry.local)bubble.dataset.local='true';
      const meta=node('div','worker-chat-meta');meta.append(node('span','',entry.label??roleNames[entry.role]),node('time','',entry.local?'Gönderiliyor':clock(entry.at)));
      if(entry.role==='task'){const first=entry.text.split('\n')[0],details=node('details','worker-chat-task'),summary=node('summary','',first.length>110||entry.text.length>first.length?first.slice(0,110)+'…':first);details.append(summary,node('p','',entry.text));bubble.append(meta,details);}
      else bubble.append(meta,node('p','',entry.text));
      log.append(bubble);
    }
    if(pane.follow!==false)requestAnimationFrame(()=>{log.scrollTop=log.scrollHeight;});else pane.chatJump.hidden=false;
  }
  // Provider transcripts are polled only while a chat view is showing; the terminal view needs none of it.
  async function pollTranscript(pane){
    if(pane.dead||pane.view()!=='chat'||pane.polling)return;pane.polling=true;
    try{const result=await api.workerTranscript(pane.candidate,pane.id);if(pane.dead)return;if(JSON.stringify(result.messages)!==JSON.stringify(pane.transcript??[])){pane.transcript=result.messages;pane.chatSignature=null;renderChat(pane);}}
    catch{}finally{pane.polling=false;}
  }
  setInterval(()=>{for(const pane of panes.values())if(pane.worker.active)void pollTranscript(pane);},2500);
  function showPrompt(pane){if(!pane.loading&&!pane.dead&&!pane.worker.active&&!pane.promptShown){pane.promptShown=true;pane.draft.prompt();}}
  function sampleAttention(pane){
    if(pane.dead||!pane.worker.active)return;
    const visible=pane.surface.probe().text.split('\n').slice(-(pane.size?.rows??24)).join('\n');
    const found=terminalAttention(visible,pane.worker.active.state);
    pane.promptAttention=found?.kind==='trust'||found?.kind==='permission'?found:null;
    if(!pane.promptAttention)pane.dismissedPrompt=false;
    render(pane);
  }
  function render(pane){
    const {worker}=pane,c=worker.execution,active=worker.active,paused=worker.enabled===false&&!active;
    const prompt=pane.dismissedPrompt?null:pane.promptAttention;
    const attention=active?(providerLimitAttention(active.usageLimit)??prompt??terminalAttention('',active.state)):null;
    pane.attention.hidden=!attention;
    if(attention){pane.attentionTitle.textContent=attention.title;pane.attentionDetail.textContent=attention.detail;pane.attentionButton.textContent=attention.kind==='usage_limit'?'Terminali göster':'Terminalde yanıtla';}
    pane.status.textContent=attention?.kind==='usage_limit'?'Kullanım limiti':attention?'Yanıt bekliyor':paused?'Durduruldu':worker.presentation?.status??(active?(states[active.state]??'Bağlanıyor'):c?.status==='running'?'Görev bekliyor':c?.status==='complete'?'Tamamlandı':'Kapalı');
    pane.status.dataset.active=String(Boolean(active));
    pane.status.dataset.attention=String(Boolean(attention));
    pane.card.dataset.attention=String(Boolean(attention));
    pane.title.textContent=paused?'Worker durduruldu':worker.presentation?.title??'Sıradaki görev bekleniyor';
    const pageProgress=worker.presentation?.pageProgress;pane.pageProgress.textContent=scanPageLabel(pageProgress);pane.pageProgress.hidden=!pane.pageProgress.textContent;pane.pageProgress.title=pageProgress?`Son bildirilen sonuç sayfası; tamamlanma oranı değildir.\n${pageProgress.evidence}`:'';
    pane.title.title=pane.title.textContent;
    const usage=active?.contextUsage?.percent;
    pane.detail.textContent=paused?'Başlattığında sıradaki görevi alır.':[worker.presentation?.detail??c?.note??'Başlatıldığında uygun işi kuyruktan alır.',usage!=null?`Context %${usage.toLocaleString('tr-TR',{maximumFractionDigits:1})}`:null].filter(Boolean).join(' · ');
    pane.start.hidden=Boolean(active)||c?.status==='running';pane.stop.hidden=pane.start.hidden===false;
    pane.start.textContent=worker.presentation?.startLabel??'Başlat';pane.start.setAttribute('aria-label',worker.presentation?.startLabel??`${worker.name} başlat`);
    const web=Boolean(snapshot?.automation);
    pane.card.dataset.persistentTerminal=String(web);
    if(active)pane.showHistory=false;
    pane.card.dataset.closed=String(!active);pane.card.dataset.history=String(Boolean(pane.showHistory));
    pane.idle.hidden=Boolean(active);
    pane.idleTitle.textContent='Agent kapalı';
    pane.idleDetail.textContent=paused?'Şimdilik küçük bir mola. Hazır olduğunda devam edebiliriz.':'Şu an dinleniyorum. Hazır olduğunda buradayım.';
    pane.idleHistory.hidden=!pane.hasOutput||pane.view()==='chat';
    pane.idleHistory.textContent=pane.showHistory?'Çıktıyı gizle':'Son terminal çıktısı';
    pane.idleHistory.setAttribute('aria-expanded',String(Boolean(pane.showHistory)));
    pane.task.hidden=web&&!active&&!c?.task;
    if(web&&worker.id==='main'&&snapshot.progress?.primary?.id==='message')pane.start.hidden=true;
    const outcome=worker.presentation?.outcome;pane.outcome.hidden=web||!outcome;
    if(outcome){pane.outcomeTitle.textContent=outcome.title;pane.outcomeDetail.textContent=outcome.detail;pane.outcome.dataset.tone=outcome.tone;}
    pane.inputHint.hidden=!snapshot?.capabilities?.terminalConversation;pane.inputHint.textContent=active?'Canlı terminal · Giriş ve izin isteklerini burada yanıtlayabilirsin.':web?'Oturum kapalı · Yeni bir mesaj için yukarıdaki yanıt alanını kullanabilirsin.':'Oturum kapalı · Yukarıdaki çıktı önceki oturuma ait. Yeni mesaj yazıp Enter’a basarak agent ile konuşabilirsin.';
    pane.start.disabled=pane.busy||!(snapshot?.capabilities?.canStart??false);pane.stop.disabled=pane.busy;pane.restart.disabled=pane.busy||!(snapshot?.capabilities?.canRestart??false);pane.remove.disabled=pane.busy;
    pane.restart.hidden=!snapshot?.capabilities?.workerRestart;pane.card.setAttribute('aria-busy',String(pane.busy));syncSize(pane);showPrompt(pane);
    const blocked=Boolean(prompt),closed=!active&&!snapshot?.capabilities?.terminalConversation;
    pane.chatInput.placeholder=blocked?'Önce terminaldeki onayı yanıtla':active?'Agent’a yaz…':'Agent’a mesaj bırak…';pane.chatSend.disabled=pane.sending||blocked||closed;pane.chatInput.disabled=pane.sending||blocked||closed;
    pane.chatForm.title=blocked?'Agent terminalde bir onay bekliyor. Yukarıdaki düğmeyle terminale geç ve seçimini yap.':closed?'Bu çalışma alanında kapalı oturuma mesaj bırakılamaz; worker’ı başlat.':'';renderChat(pane);
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
    for(const worker of workers){let pane=panes.get(worker.id);if(!pane){pane=create(worker);changed=true;}else{const ended=pane.worker.active&&!worker.active;pane.worker=worker;if(worker.active?.sessionId&&pane.session!==worker.active.sessionId){pane.session=worker.active.sessionId;pane.transcript=[];pane.chatSignature=null;void replay(pane);void pollTranscript(pane);}if(ended){pane.promptShown=false;pane.promptAttention=null;pane.dismissedPrompt=false;if(snapshot?.capabilities?.terminalConversation)pane.surface.writeln('\r\n── Oturum sona erdi · Sonuç ve sonraki adım yukarıda ──');}render(pane);}}
    if(changed)separators();
    const main=panes.get('main');if(main){const home=value?.setup?.status==='running'?document.getElementById('setup-terminal'):main.card;if(home&&main.host.parentElement!==home)home.append(main.host);}
    const maxWorkers=value?.capabilities?.maxWorkers??8;add.hidden=maxWorkers===1;
    container.querySelector('.worker-toolbar h2').textContent=value?.automation?'Terminal':'Agent worker’ları';
    container.querySelector('.worker-toolbar p').textContent=value?.automation?'Asistanın çalışmasını izle; giriş ve izin isteklerini burada yanıtla.':value?.capabilities?.workerDescription??'Worker’lar çalışma alanının görevlerini ortak kuyruktan alır.';
    add.disabled=adding||!id||workers.length>=maxWorkers||Boolean(value?.setup&&value.setup.status!=='complete');
  }
  function event(event){
    if(event.candidateId!==candidate)return;
    const pane=panes.get(event.workerId??'main');if(!pane||pane.dead)return;
    if(event.event==='output'){
      if(event.bytes?.length)pane.hasOutput=true;
      if(pane.loading)pane.pending.push(event);
      else if(event.sequence>pane.sequence){pane.surface.write(new Uint8Array(event.bytes),()=>sampleAttention(pane));pane.sequence=event.sequence;}
    }else if(event.event==='gap')pane.surface.writeln('\r\n[Terminal çıktısının bir kısmı atlandı]');
    else if(event.event==='state'&&pane.worker.active?.sessionId===event.sessionId){pane.worker.active.state=event.state.replace(/^Some\((.*)\)$/,'$1');render(pane);}
  }
  api.onLogsCleared?.(()=>{for(const pane of panes.values()){pane.version++;pane.loading=false;pane.pending=[];pane.promptAttention=null;pane.dismissedPrompt=false;pane.hasOutput=false;pane.showHistory=false;pane.surface.write(clear,()=>sampleAttention(pane));render(pane);}});
  return {update,event,dispose,focus({view}={}){const main=panes.get('main');if(!main)return;if(view)main.setView(view);if(main.view()==='chat')main.chatInput.focus();else main.host.querySelector('.xterm-helper-textarea')?.focus();}};
}
