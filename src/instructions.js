import {instructionExplanation} from './instruction-explanations.js';
import './instructions.css';
const labels={system:'Sistem',template:'Template',workspace:'Çalışma alanı',user:'Kullanıcı',skill:'Beceri',tool:'Araç'};
const states={unrecorded:'Seçili kapsamda kayıt yok',changed:'Güncel sürüm kayıttakinden farklı',available:'Dosyada mevcut · okunması doğrulanmadı',recorded:'Aynı içerik kayıtta var'};
const statuses={available:'Dosyadan erişilebilir',requested:'Gönderim istendi',accepted:'İstek kabul edildi',returned:'Araç yanıtı döndü',observed:'Sağlayıcı bildirimi',failed:'Başarısız'};
const fieldLabels={goal:'Hedef',criteria:'Kriterler',instructions:'Özel talimatlar',facts:'Kullanıcı bilgileri',mode:'İşlem yetkisi',sources:'Kaynaklar',guidance:'Template kuralları',workflow:'Görev adımları',fields:'Kurulum soruları',preferences:'Tercihler',authorization:'İşlem yetkisi',applicationPolicy:'Başvuru kuralları',maxActionsPerDay:'Günlük işlem sınırı',maxBrowserSteps:'Tarayıcı adım sınırı',timeoutMinutes:'Süre sınırı',title:'Başlık'};
const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const time=value=>new Date(value).toLocaleString('tr-TR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit'});
const title=part=>fieldLabels[part.key.split(':').at(-1)]??part.title;
const workerName=id=>id==='main'?'Worker 1':id==='background'?'Arka plan':id;
function textBody(part){
 const wrap=node('div','instruction-text'),head=node('div','instruction-text-head'),copy=node('button','quiet','Kopyala');copy.type='button';
 copy.onclick=async()=>{try{await navigator.clipboard.writeText(part.text);copy.textContent='Kopyalandı';}catch{copy.textContent='Kopyalanamadı';}};
 head.append(node('small','',`${(part.characters??part.text.length).toLocaleString('tr-TR')} karakter`),copy);wrap.append(head);
 if(part.truncated)wrap.append(node('p','instruction-warning','Bu uzun içerik kayıt sınırında kesildi; aşağıdaki metin tam içerik değildir.'));
 wrap.append(node('pre','',part.text||'(Boş)'));return wrap;
}
export function instructionsPanel(api,agent){
 const tabs=node('div','agent-view-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Agent görünümleri');
 const live=node('button','','Çalışma alanı'),inspect=node('button','','Talimatlar');
 for(const [button,name] of [[live,'work'],[inspect,'instructions']]){button.type='button';button.id='agent-tab-'+name;button.setAttribute('role','tab');button.setAttribute('aria-controls',name==='instructions'?'agent-instructions':'agent');button.onclick=()=>show(name);tabs.append(button);}
 const root=node('section','instruction-panel');root.id='agent-instructions';root.hidden=true;root.setAttribute('aria-labelledby',inspect.id);root.setAttribute('role','tabpanel');
 root.innerHTML=`<div class="instruction-heading"><div><span class="instruction-eyebrow">AGENT BAĞLAMI</span><h2>Hangi talimat, hangi oturum?</h2><p>Güncel kuralları incele; oturuma sunulan içerikle karşılaştır.</p></div><button type="button" class="quiet" data-refresh>Yenile</button></div>
 <div class="instruction-agents" role="tablist" aria-label="Agent türleri"></div><div class="instruction-agent-summary"></div>
 <div class="instruction-filters"><label>Worker<select data-worker aria-label="Talimat worker filtresi"></select></label><label>Oturum<select data-session aria-label="Talimat oturum filtresi"></select></label><label class="instruction-search">Metinde ara<input type="search" data-search placeholder="Sekme, bütçe, yetki…" aria-label="Talimatlarda ara"></label></div>
 <p class="instruction-error" role="alert" hidden></p><div class="instruction-stats"></div>
 <div class="instruction-modes" role="tablist" aria-label="Talimat görünümü"><button type="button" role="tab" data-mode="parts">Talimat parçaları</button><button type="button" role="tab" data-mode="history">Gönderim geçmişi</button></div>
 <details class="instruction-guide"><summary>Talimatlar agent’a nasıl ulaşır?</summary><ol><li><strong>Oturum açılır:</strong> Seçilen agent’ın talimatı sistem/geliştirici mesajı olarak verilir. Başlangıç mesajı iletilir, ortak talimat ve beceri dosyaları erişime açılır. Dosyanın okunması ayrı bir adımdır.</li><li><strong>Bir görev başlar:</strong> Agent kayıtlı planı ve görev bilgilerini ister; kriterlerin, özel talimatların ve işlem yetkisi bu yanıtın içinde verilir.</li><li><strong>Agent çalışır:</strong> Açtığı sayfalar ve kullandığı araçların sonuçları geldikçe yeni bilgi alır. Planın tamamı her işlemde yeniden gönderilmez.</li></ol><p>Bu sayfa güncel tanımları gösterir. Bir ayarı değiştirmen, çalışan agent’ın değişikliği hemen gördüğü anlamına gelmez. Belirli bir oturumun ne aldığını <strong>Gönderim geçmişi</strong> bölümünde kontrol et.</p></details>
 <p class="instruction-scope"></p><div class="instruction-sources"></div><div class="instruction-content"></div><button type="button" class="quiet instruction-more" hidden>Daha eski kayıtlar</button>
 <p class="instruction-footnote">Dosyanın oturumda bulunması okunduğunu, mesajın kuyruğa alınması modelin onu işlediğini kanıtlamaz. Terminalde doğrudan yazılan tuşlar, sağlayıcının kendi talimatları ve harici araçların yanıtları bu geçmişte izlenmez. Kayıtlar bu özellik etkinleştirildikten sonra oluşur; 30 gün ve kayıt sınırları uygulanır.</p>`;
 agent.prepend(tabs);agent.append(root);
 const find=q=>root.querySelector(q),content=find('.instruction-content'),search=find('[data-search]'),worker=find('[data-worker]'),session=find('[data-session]'),error=find('.instruction-error');
 let owner=null,visible=false,mode='parts',source='',profile='',data=null,version=0,timer=null,loading=false;
 const detailCache=new Map();
 let editing=null;
 function renderAgents(){
  const strip=find('.instruction-agents');strip.replaceChildren();
  strip.onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const buttons=[...strip.querySelectorAll('button')],index=buttons.indexOf(document.activeElement),next=buttons[(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length];next?.click();next?.focus();};
  for(const item of [...(data?.profiles??[]),{id:'all',name:'Tüm kayıtlar'}]){const button=node('button','',item.name);button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-selected',String(profile===item.id));button.tabIndex=profile===item.id?0:-1;button.onclick=()=>{if(editing&&editing.value!==editing.original&&!window.confirm('Kaydedilmeyen agent talimatı silinsin mi?'))return;editing=null;profile=item.id;worker.value='';session.value='';source='';if(profile==='all')mode='history';void refresh();};strip.append(button);}
  strip.hidden=!data?.profiles?.length;
  const summary=find('.instruction-agent-summary'),selected=data?.profiles?.find(a=>a.id===profile);summary.replaceChildren();if(!selected)return;
  summary.append(node('h3','',selected.name+' agent'),node('p','',selected.description),node('p','',selected.when),node('small','',`Sürüm ${selected.version} · ${selected.agent_id} · ${selected.selection.model}. Sağlayıcı ve model ${selected.role==='background'?'arka plan görevi':'çalışma alanı'} ayarlarından alınır.`));
  const edit=node('details','instruction-profile-editor');edit.append(node('summary','','Agent talimatını düzenle'));
  const note=node('p','','Kaydedilen talimat sonraki oturum açılışında sistem/geliştirici talimatı olarak verilir. Açık oturum kendi sürümüyle devam eder. Ortak kurallar aşağıda ayrıca gösterilir.');
  const input=node('textarea');input.setAttribute('aria-label','Agent talimatı');input.value=editing?.id===profile?editing.value:selected.instructions;input.rows=10;
  if(editing?.id===profile)edit.open=true;input.oninput=()=>{if(!editing)editing={id:profile,revision:data.profileRevision,original:selected.instructions};editing.value=input.value;};
  const save=node('button','','Talimatı kaydet');save.type='button';save.onclick=async()=>{save.disabled=true;try{await api.saveAgentProfile(owner,selected.role,{instructions:input.value,expectedRevision:editing?.revision??data.profileRevision});editing=null;await refresh();}catch(e){fail(e);}finally{save.disabled=false;}};
  edit.append(note,input,save);summary.append(edit);
 }
 const workerLabel=id=>data?.workers?.find(w=>w.id===id)?.name??workerName(id);
 const fail=e=>{error.textContent=e.message;error.hidden=false;};
 function show(name){visible=name==='instructions';agent.dataset.panel=name;root.hidden=!visible;for(const [button,selected]of [[live,!visible],[inspect,visible]]){button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}if(visible)void refresh();}
 tabs.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();show(visible?'work':'instructions');(visible?inspect:live).focus();}};
 function filters(){
  const selectedWorker=worker.value,selectedSession=session.value,workers=[...new Set([...(data?.sessions??[]).map(s=>s.workerId),...(data?.activeSessions??[]).map(s=>s.workerId)])];
  worker.replaceChildren(new Option('Tüm worker’lar',''),...workers.map(id=>new Option(workerLabel(id),id)));worker.value=workers.includes(selectedWorker)?selectedWorker:'';
  const all=new Map((data?.sessions??[]).map(s=>[s.id,s]));for(const active of data?.activeSessions??[])if(!all.has(active.id))all.set(active.id,active);
  const sessions=[...all.values()].filter(s=>!worker.value||s.workerId===worker.value);
  session.replaceChildren(new Option('Tüm oturumlar',''),...sessions.map(s=>new Option(`${data.activeSessions.some(a=>a.id===s.id)?'● Açık · ':''}${s.startedAt?time(s.startedAt)+' · ':''}${workerLabel(s.workerId)} · ${s.id.slice(0,8)}`,s.id)));session.value=sessions.some(s=>s.id===selectedSession)?selectedSession:'';
 }
 async function refresh({older=false}={}){
  if(!visible||!owner){if(visible)render();return;}
  const id=owner,request=++version;loading=true;error.hidden=true;find('[data-refresh]').disabled=true;
  try{const next=await api.instructionSnapshot(id,{profile,worker:worker.value,session:session.value,...(older&&data?.next?{before:data.next}:{})});if(request!==version||owner!==id)return;
   data=older?{...next,events:[...data.events,...next.events]}:next;profile=next.selectedProfileId??(profile==='all'?'all':'');filters();render();
  }catch(e){if(request===version)fail(e);}finally{if(request===version){loading=false;find('[data-refresh]').disabled=false;}}
 }
 function schedule(){if(!visible||agent.hidden||loading)return;clearTimeout(timer);timer=setTimeout(()=>void refresh(),400);}
 function render(){
  renderAgents();
  find('[data-mode=parts]').disabled=profile==='all';
  const open=new Set([...content.querySelectorAll('details[open][data-key]')].map(n=>n.dataset.key));content.replaceChildren();
  for(const button of root.querySelectorAll('[data-mode]'))button.setAttribute('aria-selected',String(button.dataset.mode===mode));
  find('.instruction-more').hidden=mode!=='history'||!data?.next;
  const stats=find('.instruction-stats');stats.replaceChildren();
  for(const [value,label]of [[data?.parts.length??0,'Tanımlı parça'],[data?.activeSessions.length??0,'Açık oturum'],[data?.events.length??0,'Görüntülenen olay']]){const card=node('div');card.append(node('strong','',String(value)),node('span','',label));stats.append(card);}
  find('.instruction-scope').textContent=mode==='parts'?'Şu anda tanımlı içerik · Durumlar seçtiğin worker ve oturumun saklanan son içerikleriyle karşılaştırılır.':'Gerçek çalışma kayıtları · En yeni olay üstte. Açık oturumda yeni kayıtlar otomatik görünür. Arama, yüklenen olay başlıklarını ve parça adlarını tarar.';
  const sources=find('.instruction-sources');sources.replaceChildren();sources.hidden=mode==='history';
  for(const [id,label]of [['','Tümü'],...Object.entries(labels)]){const b=node('button',source===id?'selected':'',label);b.type='button';b.setAttribute('aria-pressed',String(source===id));b.onclick=()=>{source=id;render();};sources.append(b);}
  if(!owner){content.append(node('p','instruction-empty','Talimatları görmek için bir çalışma alanı seç.'));return;}
  if(!data){content.append(node('p','instruction-empty','Talimatlar yükleniyor…'));return;}
  const query=search.value.toLocaleLowerCase('tr-TR');
  if(mode==='parts'){
   for(const part of data.parts){if(source&&part.source!==source||query&&!`${title(part)} ${part.text}`.toLocaleLowerCase('tr-TR').includes(query))continue;
    const card=node('details','instruction-card');card.dataset.key=part.key;card.open=open.has(part.key);const summary=node('summary'),main=node('div');
    const explanation=instructionExplanation(part);
    main.append(node('small','instruction-source',labels[part.source]??part.source),node('strong','',title(part)),node('span','instruction-purpose',explanation.purpose));
    const timing=node('span','instruction-when');timing.append(node('b','','Ne zaman verilir? '),document.createTextNode(explanation.timing));main.append(timing);
    const help=node('div','instruction-change');help.append(node('strong','','Değiştirirsen ne olur?'),node('p','',explanation.change));

    const state=node('span','instruction-state',states[part.state]);state.dataset.state=part.state;summary.append(main,state);card.append(summary,help,textBody(part));content.append(card);
   }
  }else{
   for(const event of data.events){if(query&&!`${event.title} ${event.detail??''} ${event.parts.map(p=>p.title).join(' ')}`.toLocaleLowerCase('tr-TR').includes(query))continue;
    const card=node('details','instruction-event');card.dataset.key=String(event.seq);const summary=node('summary'),main=node('div');
    main.append(node('small','',`${time(event.at)} · ${workerLabel(event.workerId)} · ${event.sessionId.slice(0,8)}`),node('strong','',event.title),node('span','instruction-when',event.detail??`${event.parts.length} içerik parçası`));
    const status=node('span','instruction-state',statuses[event.status]??event.status);status.dataset.state=event.status;summary.append(main,status);card.append(summary);
    const body=node('div','instruction-event-body');card.append(body);
    let loaded=false;const load=async()=>{if(loaded)return;loaded=true;body.textContent='İçerik yükleniyor…';const id=owner;try{let full=detailCache.get(event.seq);if(!full){full=await api.instructionEvent(id,event.seq);if(owner!==id)return;detailCache.set(event.seq,full);}body.replaceChildren();if(!full.parts.length)body.append(node('p','',full.detail??'Bu olay yeni bir içerik göndermedi.'));for(const part of full.parts){const item=node('details','instruction-part');item.append(node('summary','',`${labels[part.source]??part.source} · ${title(part)}`),textBody(part));body.append(item);}}catch(e){loaded=false;body.textContent=e.message;}};
    card.ontoggle=()=>{if(card.open)void load();};if(open.has(card.dataset.key)){card.open=true;void load();}content.append(card);
   }
  }
  if(!content.children.length)content.append(node('p','instruction-empty',query||source?'Bu filtreyle eşleşen içerik yok.':mode==='history'?'Henüz kayıt yok. Yeni agent oturumları ve araç yanıtları burada görünecek.':'Bu template için tanımlı talimat parçası yok.'));
 }
 worker.onchange=()=>{session.value='';void refresh();};session.onchange=()=>void refresh();search.oninput=render;
 for(const button of root.querySelectorAll('[data-mode]'))button.onclick=()=>{mode=button.dataset.mode;search.value='';render();};
 find('[data-refresh]').onclick=()=>void refresh();find('.instruction-more').onclick=()=>void refresh({older:true});
 api.onInstructionsChange?.(({workspaceId})=>{if(workspaceId===owner)schedule();});
 api.onLogsCleared?.(()=>{detailCache.clear();data=null;void refresh();});
 show('work');
 return {select(id){if(id===owner){schedule();return;}owner=id;profile='';editing=null;version++;loading=false;find('[data-refresh]').disabled=false;data=null;detailCache.clear();worker.replaceChildren(new Option('Tüm worker’lar',''));session.replaceChildren(new Option('Tüm oturumlar',''));error.hidden=true;if(visible){render();void refresh();}},show:()=>show('instructions')};
}
