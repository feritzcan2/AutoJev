import {templateFields} from './template-fields.js';
import {XtermSurface} from '@termloop/terminal-surface/xterm';
import {automationProgress,runKindLabel} from '../app/automation-progress.mjs';
import {prepareAutomationChat} from './automation-chat.js';
import {automationResultsTable} from './automation-results.js';
import {automationSourcesPanel} from './automation-sources.js';
import './automations.css';

const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const statusNames={draft:'Kurulum',ready:'Denemeye hazır',enabled:'Düzenli çalışıyor',paused:'Duraklatıldı',blocked:'Yardım bekliyor',complete:'Tamamlandı',running:'Çalışıyor',completed:'Tamamlandı',partial:'Kısmi · devam edecek',failed:'Tamamlanamadı',interrupted:'Durduruldu',timeout:'Süre doldu',found:'Bulundu',prepared:'İşlem taslağı',executing:'İşleniyor',uncertain:'Sonuç doğrulanmalı',dismissed:'Atlandı'};
const time=value=>value?new Date(value).toLocaleString('tr-TR'):'—';
const modeNames={observe:'Bul ve bildir',prepare:'Hazırla, onayımı bekle',auto:'Sınırlarım içinde uygula'};
const dateInput=value=>{if(!value)return '';const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};

export function automationsPage(api,{notice,getCatalog,startJob,navigate,onSnapshot=()=>{},focusAgent=()=>{}}){
 let sourcePanel;
 const host=el('section',null,'automations-page');host.id='automations';host.hidden=true;document.querySelector('main').append(host);
 const agentConversation=el('div',null,'workspace-conversation');agentConversation.dataset.webOnly='';document.querySelector('#now-panel').after(agentConversation);
 const progressBox=el('div',null,'workspace-progress');progressBox.dataset.webOnly='';progressBox.innerHTML='<ol id="automation-steps" aria-label="Kurulum ilerlemesi"></ol><p id="automation-next-step"></p><div id="automation-next-actions" class="actions"></div><section id="automation-agent-reply" aria-label="Agent’ın son yanıtı"><b>Agent’ın yanıtı</b><p></p></section>';
 document.querySelector('#now-history').before(progressBox);
 const find=selector=>host.querySelector(selector)??agentConversation.querySelector(selector);
 let progressSignature='';
 const templateNav=el('button');templateNav.type='button';templateNav.dataset.view='templates';templateNav.innerHTML='<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg><span>Template’ler</span>';document.querySelector('aside nav button[data-view=config]').before(templateNav);
 let templates=[],selected=null,data=null,pane=null,generation=0,busy=false,dirty=false,formRevision='',terminal=null,selectedRun=null,terminalGeneration=0,terminalLoading=false,terminalRunId=null,pendingOutput=[],chatSending=false,chatError='',resultsTable=null;
 const hasUnsaved=()=>dirty;
 const attempt=fn=>async(...args)=>{args[0]?.preventDefault?.();if(busy)return;busy=true;setBusy();notice('');try{return await fn(...args);}catch(error){notice(error.message);}finally{busy=false;setBusy();}};
 const button=(label,fn,cls='quiet')=>{const b=el('button',label,cls);b.type='button';b.onclick=attempt(fn);return b;};
 const badge=(status)=>el('span',statusNames[status]??status,'automation-badge '+status);
 const sectionTitle=(title,description)=>{const head=el('div',null,'automation-section-head');head.append(el('h2',title));if(description)head.append(el('p',description));return head;};
 function setBusy(){for(const b of [...host.querySelectorAll('button[data-idle]'),...agentConversation.querySelectorAll('button[data-idle]')])b.disabled=busy||Boolean(data?.activeRun);host.setAttribute('aria-busy',String(busy));agentConversation.setAttribute('aria-busy',String(busy));if(selected&&data){renderControls();renderChatStatus();}}
 async function catalog(){if(!templates.length)templates=await api.automationTemplates();}
 async function loadList(){const current=++generation;await catalog();if(current!==generation||selected)return;renderList();}
 async function create(template){if(template.kind==='jobs'){await startJob(template);return;}const a=await api.workspaceCreate(template.id,{});await select(a.id);}
 function renderList(){
  if(selected||host.hidden)return;host.replaceChildren();
  const heading=el('div',null,'automation-heading');heading.append(sectionTitle('Bir template ile başla','Hazır bir işleyiş seç; agent sorularla çalışma alanını sana göre düzenlesin.'));
  heading.append(button('Template içe aktar',async()=>{const result=await api.automationTemplateImport();if(result){templates=[];await loadList();notice('Template eklendi. Başlamak için kartını seç.');}}));host.append(heading);
  const grid=el('div',null,'automation-grid template-grid');for(const t of templates){const card=el('article',null,'automation-card template-card');card.append(el('span',t.icon,'automation-icon'),el('h3',t.title),el('p',t.description));const steps=el('ol');for(const step of t.steps)steps.append(el('li',step));card.append(steps);const choose=button(t.id==='custom'?'Ne istediğini anlat →':'Bu template ile başla →',()=>create(t),'primary');choose.dataset.template=t.id;card.append(choose);card.append(button('Template’i dışa aktar',()=>api.automationTemplateExport(t.id),'automation-export-template'));grid.append(card);}host.append(grid);
  host.append(el('p','Bu bilgisayarda çalışır. Düzenli kontroller için uygulamayı ve bilgisayarı açık tut.','automation-local-note'));
 }
 async function select(id){selected=id;data=null;host.hidden=false;localStorage.setItem('selected-automation',id);pane=null;formRevision='';dirty=false;selectedRun=null;terminalRunId=null;terminalGeneration++;terminalLoading=false;if(terminal){terminal.dispose();terminal=null;}buildDetail();navigate('board');await refresh();if(selected!==id)return;if(!data){data=await api.workspaceSnapshot(id);if(selected!==id)return;renderDetail();}if(!data.automation.goal)openConversation();}
 function createBlank(){
  const providers=getCatalog().filter(provider=>provider.supported&&['codex','claude'].includes(provider.id));
  if(!providers.length)throw Error('Kurulum agent’ı için kullanılabilir bir sağlayıcı bulunamadı.');
  const provider=startDialog.querySelector('[name=provider]'),saved=data?.automation?.agentSettings;
  provider.replaceChildren(...providers.map(item=>new Option(item.label,item.id)));
  provider.value=providers.some(item=>item.id===saved?.provider)?saved.provider:providers.some(item=>item.id==='codex')?'codex':providers[0].id;
  fillStartModels(saved?.provider===provider.value?saved?.model:null);
  startDialog.querySelector('[role=alert]').textContent='';
  startDialog.showModal();
 }
 function buildDetail(){
  agentConversation.replaceChildren();progressSignature='';
  host.innerHTML=`<div id="automation-controls" class="actions"></div><p id="automation-runtime-note" class="automation-runtime-note" role="status"></p>
<div class="automation-setup-grid"><section class="automation-conversation"><div class="automation-section-head"><h2>Asistanla kur</h2><p>İhtiyacını anlat, soruları yanıtla veya yapmak istediğin değişikliği yaz.</p></div><div id="automation-messages" class="automation-messages" role="log" aria-label="Kurulum konuşması"></div><form id="automation-chat"><label for="automation-message">Mesajın</label><textarea id="automation-message" placeholder="Örneğin: Berlin’de 1.500 euroya kadar iki odalı ev arıyorum…" maxlength="12000" required></textarea><div class="actions"><button id="automation-send" data-idle type="submit" class="primary">Gönder</button><button id="automation-add-document" data-idle type="button" class="quiet">Belge ekle</button></div><small>Değişiklik konuşması düzenli çalışmayı duraklatır. Yeni bilgiler çalışma alanı profilinde görünür.</small></form></section>
<section class="automation-plan"><div class="automation-section-head"><h2>Kurulum kartı</h2><p>Asistanın hazırladıklarını incele ve düzenle. Yetkiyi buradan sen seçersin.</p></div><form id="automation-plan-form"><label>Ad<input name="title" required maxlength="150"></label><label>Amaç<textarea name="goal" required maxlength="6000"></textarea></label><div id="automation-criteria"></div><label>Kaynak adresleri<textarea name="sources" required placeholder="Her satıra bir adres. Mümkünse doğrudan arama sonuçları bağlantısını kullan."></textarea></label><label>İşleyiş ve bitiş koşulu<textarea name="instructions" maxlength="12000"></textarea></label><details><summary>Kişisel bilgiler ve belgeler</summary><label>Bu otomasyonun kullanabileceği bilgiler<textarea name="facts" maxlength="12000" placeholder="Yalnızca bu iş için gereken bilgiler. Şifreleri burada paylaşma."></textarea></label><div id="automation-documents"></div></details><label>İşlem yetkisi<select name="mode"><option value="observe">Bul ve bildir</option><option value="prepare">Hazırla, onayımı bekle</option><option value="auto">Sınırlarım içinde uygula</option></select></label><div class="automation-form-grid"><label>Kontrol aralığı (dakika)<input type="number" name="intervalMinutes" min="1" max="10080" required></label><label>Günlük işlem sınırı<input type="number" name="maxActionsPerDay" min="1" max="1000" required></label><label>Tur süresi (dakika)<input type="number" name="timeoutMinutes" min="1" max="60" required></label><label>Tur başına tarayıcı adımı<input type="number" name="maxBrowserSteps" min="5" max="500" required></label></div><label>Bitiş tarihi (isteğe bağlı)<input type="datetime-local" name="endAt"></label><div class="automation-plan-footer"><small id="automation-save-state" role="status"></small><button data-idle type="submit" class="primary">Kurulumu kaydet</button></div></form></section></div>
<section class="automation-results-section"><div class="automation-heading"><div><h2>Sonuçlar</h2><p id="automation-results-summary"></p></div><button id="automation-export" type="button" class="quiet">Sonuçları dışa aktar</button></div><div id="automation-results"></div></section>
<section class="automation-history-section"><div class="automation-section-head"><h2>Çalışma geçmişi</h2><p>Her turun sonucu ve gerektiğinde agent ekranı.</p></div><div id="automation-runs"></div></section><div class="automation-bottom-actions"><button id="automation-delete" type="button" class="quiet danger">Otomasyonu sil</button></div>`;
 const $=id=>find('#'+id),form=$('automation-plan-form');
  resultsTable=automationResultsTable($('automation-results'),{button,badge,time,api,refresh,statusNames});
  chatError='';chatSending=false;
  const chatFeedback=el('p',null,'automation-chat-feedback');chatFeedback.id='automation-chat-feedback';chatFeedback.setAttribute('role','status');chatFeedback.setAttribute('aria-live','polite');$('automation-chat').querySelector('.actions').after(chatFeedback);
  const agentLink=button('Agent ekranını aç',()=>{navigate('agent');focusAgent();});agentLink.id='automation-chat-agent';agentLink.hidden=true;chatFeedback.after(agentLink);
  $('automation-chat').querySelector('small').textContent='Soruları buradan yanıtla veya bir değişiklik iste. Gönderdiğinde agent yeni bir konuşma turu açar. Düzenli takip varsa duraklatılır.';
  $('automation-message').placeholder='Agent’ın sorularını yanıtla veya neyi değiştirmek istediğini yaz…';
  form.elements.sources.placeholder='Web adreslerini veya kaynak isteğini yaz. Henüz bilmiyorsan boş bırakıp asistana sorabilirsin.';
  const saveTemplate=button('Template olarak kaydet',()=>{const a=data.automation;templateDialog.querySelector('[name=title]').value=a.title+' template';templateDialog.querySelector('[name=description]').value=templates.find(t=>t.id===a.templateId).description;templateDialog.querySelector('[name=guidance]').value=a.instructions;templateDialog.showModal();});find('.automation-bottom-actions').prepend(saveTemplate);
  form.addEventListener('input',()=>{dirty=true;$('automation-save-state').textContent='Kaydedilmemiş değişiklikler';renderControls();onSnapshot(data);});
  form.onsubmit=attempt(async()=>{const input=readForm();await api.automationSave(selected,input);await api.automationReview(selected);dirty=false;formRevision='';await refresh();notice('Kurulum kaydedildi. Deneme ile kaynakları kontrol edebilirsin.');});
  $('automation-chat').onsubmit=attempt(async()=>{const input=$('automation-message');if(!input.value.trim())return;await sendMessage(input.value);input.value='';});
  $('automation-add-document').onclick=attempt(async()=>{await api.pickDocument(selected);await refresh();});
  $('automation-export').onclick=attempt(()=>api.automationExportResults(selected));
  $('automation-delete').onclick=attempt(async()=>{if(!confirm(`“${data.automation.title}” otomasyonu, belgeleri ve geçmişi silinsin mi?`))return;await api.deleteWorkspace(selected);selected=null;await show('templates');});
  const setupGrid=find('.automation-setup-grid'),plan=find('.automation-plan'),conversation=find('.automation-conversation'),results=find('.automation-results-section'),history=find('.automation-history-section');
  plan.dataset.automationPane='profile';plan.className='profile automation-plan';plan.querySelector('h2').textContent='Çalışma alanı profili';form.classList.add('profile-form');
  results.dataset.automationPane='board';history.dataset.automationPane='background';
  const agent=agentConversation;
  conversation.hidden=true;conversation.querySelector('.automation-section-head').remove();
  const chat=$('automation-chat');chat.className='background-chat';chat.querySelector('label').textContent='Yanıtın veya değişiklik isteğin';
  const messages=$('automation-messages'),conversationHistory=el('details',null,'automation-conversation-history');conversationHistory.append(el('summary','Konuşma geçmişi'),messages);chat.after(conversationHistory);agent.append(conversation);
  const profileHead=plan.querySelector('.automation-section-head'),profileCopy=el('div');profileCopy.append(...profileHead.children);profileHead.replaceChildren(profileCopy);profileHead.className='profile-head';
  const improve=button('Agent ile geliştir',openConversation);plan.querySelector('.profile-head').append(improve);
  const sections=[['Çalışma alanı','Bu otomasyonun adı ve amacı.',['title','goal']],['Ne arıyorsun','Agent sonuçları bu kriterlere göre değerlendirir.',['criteria']],['Kaynaklar ve işleyiş','Taranacak adresler ve takip edilecek adımlar.',['sources','instructions']],['Kişisel bilgiler','Agent yalnızca burada verdiğin bilgileri kullanır.',['facts']],['İşlem yetkisi','Hangi işlemleri yapabileceğini sen seçersin.',['mode']],['Çalışma düzeni','Kontrol sıklığı, tur sınırları ve bitiş tarihi.',['intervalMinutes','maxActionsPerDay','timeoutMinutes','maxBrowserSteps','endAt']]];
  const profileSections=[];for(const [title,description,names] of sections){const section=el('div',null,'profile-section'),copy=el('div',null,'profile-section-copy'),fields=el('div',null,'profile-fields');copy.append(el('h3',title),el('p',description));for(const name of names){const field=name==='criteria'?$('automation-criteria'):form.elements[name].closest('label');fields.append(field);}if(names.includes('facts'))fields.append($('automation-documents'));section.append(copy,fields);profileSections.push(section);}
  const mode=profileSections.flatMap(section=>[...section.querySelectorAll('select[name=mode]')])[0],authorization=el('div',null,'authorization');for(const [value,title,description] of [['observe','Bul ve bildir','Ara, filtrele ve uygun sonuçları kaydet; mesaj veya başvuru gönderme.'],['prepare','Hazırla, onayımı bekle','İşlem taslağını hazırla; göndermeden önce onayımı al.'],['auto','Sınırlarım içinde uygula','Kaydettiğim kurallara ve günlük sınıra göre işlemleri uygula.']]){const choice=el('label',null,'choice'),input=el('input'),copy=el('span');input.type='radio';input.name='mode';input.value=value;copy.append(el('b',title),el('small',description));choice.append(input,copy);authorization.append(choice);}mode.closest('label').replaceWith(authorization);
  const footer=form.querySelector('.automation-plan-footer');footer.className='profile-foot';footer.querySelector('button').textContent='Profili kaydet';form.replaceChildren(...profileSections,footer);
  history.className='automation-history-section';history.innerHTML='<div class="background-head"><h2>Arka plan işleri</h2><p>Çalışma alanının turları ve agent çıktıları.</p></div><section class="background-history"><div class="section-title"><h2>Çalışma geçmişi</h2></div><div class="background-history-grid"><div id="automation-runs" class="run-list"></div><div class="background-terminal-frame"><div class="background-terminal-head"><span class="dot"></span><b id="automation-run-title">Agent çıktısı</b><span id="automation-run-output-label"></span></div><div id="automation-history-output"><div id="automation-terminal" class="automation-terminal"></div></div></div></div></section>';
  const pipeline=el('div',null,'pipeline');pipeline.id='automation-pipeline';const top=el('div',null,'pipeline-top');$('automation-runtime-note').className='campaign-state';top.append($('automation-runtime-note'),$('automation-controls'));pipeline.append(top,el('div',null,'automation-metrics'));results.prepend(pipeline);
  results.querySelector('.automation-heading').className='section-title';results.querySelector('h2').id='automation-table-title';
  const sources=el('section');sources.dataset.automationPane='sources';sourcePanel=automationSourcesPanel(sources,api,{refresh,notice});
  const files=el('section');files.dataset.automationPane='files';files.innerHTML='<div class="section-title"><h2>Dosyalar</h2><span>Çalışma alanının belgeleri</span></div><div id="automation-file-list"></div>';files.querySelector('.section-title').append(button('Belge ekle',async()=>{await api.pickDocument(selected);await refresh();}));
  host.append(results,history,files,sources,plan,find('.automation-bottom-actions'));setupGrid.remove();
  find('.automation-bottom-actions').dataset.automationPane='profile';

 }
 const templateDialog=el('dialog');templateDialog.className='automation-template-dialog';templateDialog.innerHTML='<form><h2>Tekrar kullanılabilir template</h2><p>Sorular ve aşağıdaki işleyiş yeni otomasyonlarda kullanılacak. Paylaşılacak metni kontrol et.</p><label>Template adı<input name="title" maxlength="150" required></label><label>Açıklama<textarea name="description" maxlength="1000" required></textarea></label><label>Paylaşılacak işleyiş<textarea name="guidance" maxlength="12000"></textarea></label><small>Kriter cevapları, kişisel bilgiler, kaynak adresleri, belgeler ve hesaplar template’e eklenmez. İşleyiş metnindeki kişisel ayrıntıları kendin çıkar.</small><div class="actions"><button type="button" class="quiet" data-cancel>Vazgeç</button><button type="submit" class="primary">Template’i kaydet</button></div></form>';document.body.append(templateDialog);templateDialog.querySelector('[data-cancel]').onclick=()=>templateDialog.close();templateDialog.querySelector('form').onsubmit=attempt(async event=>{const input=Object.fromEntries(new FormData(event.target));await api.automationTemplateSave(selected,input);templateDialog.close();templates=[];await catalog();notice('Template kaydedildi. Template’ler sayfasından kullanabilir veya dışa aktarabilirsin.');});
 const startDialog=el('dialog');startDialog.className='automation-start-dialog';startDialog.innerHTML='<form><h2>Agent modelini seç</h2><p>Çalışma alanı açılınca ilk mesajını yaz. Kurulum agent’ı mesajını gönderdiğinde başlar.</p><label>Sağlayıcı<select name="provider" required></select></label><label>Model<select name="model" required></select></label><p role="alert"></p><div class="actions"><button type="button" class="quiet" data-cancel>Vazgeç</button><button type="submit" class="primary">Çalışma alanını oluştur</button></div></form>';document.body.append(startDialog);
 const startForm=startDialog.querySelector('form'),startProvider=startForm.elements.provider,startModel=startForm.elements.model,startButton=startForm.querySelector('[type=submit]');
 function fillStartModels(saved){const provider=getCatalog().find(item=>item.id===startProvider.value),models=provider?.models??[];startModel.replaceChildren(...models.map(model=>new Option(model,model)));startModel.value=models.includes(saved)?saved:models.includes('default')?'default':models[0]??'';}
 startProvider.onchange=()=>fillStartModels();startDialog.querySelector('[data-cancel]').onclick=()=>startDialog.close();
 startForm.onsubmit=async event=>{
  event.preventDefault();if(busy)return;busy=true;startButton.disabled=true;startDialog.querySelector('[role=alert]').textContent='';setBusy();
  try{
   const agentSettings={provider:startProvider.value,model:startModel.value,permission:'default',reasoning:'default',network:null};
   const a=await api.workspaceCreate('custom',{title:'Yeni çalışma alanı',agentSettings});
   startDialog.close();await select(a.id);
  }catch(error){if(startDialog.open)startDialog.querySelector('[role=alert]').textContent=error.message;else notice(error.message);}
  finally{busy=false;startButton.disabled=false;setBusy();}
 };
 function setPane(name){const page=({results:'board',setup:'profile',history:'background'})[name]??name;pane=page;localStorage.setItem('selected-view',page);for(const b of document.querySelectorAll('aside nav button'))b.classList.toggle('selected',b.dataset.view===page);for(const section of host.querySelectorAll('[data-automation-pane]'))section.hidden=section.dataset.automationPane!==page;}
 function renderShell(){
  if(!selected||!data)return;const p=renderProgress(),a=data.automation,active=Boolean(data.activeRun)||a.status==='enabled',ready=a.trial?.status==='passed'&&a.trial.revision===a.revision;
  document.querySelector('#heading').textContent=a.title;const workspaces=document.querySelector('#candidates'),value='automation:'+a.id;if(![...workspaces.options].some(o=>o.value===value))workspaces.add(new Option(a.title,value));workspaces.value=value;const state=document.querySelector('#agent-state');state.textContent=p.label;state.dataset.active=String(active);
  const start=document.querySelector('#start'),stop=document.querySelector('#stop'),restart=document.querySelector('#restart-agent');start.hidden=active;stop.hidden=!active;start.disabled=busy||hasUnsaved();stop.disabled=busy;restart.disabled=busy||hasUnsaved()||!ready;start.textContent=p.primary?.label??'Çalışıyor';stop.textContent=data.activeRun?'Turu durdur':'Takibi duraklat';restart.hidden=true;
  for(const id of ['candidates','new'])document.querySelector('#'+id).disabled=busy;
  for(const id of ['rename-workspace','delete-workspace'])document.querySelector('#'+id).disabled=busy||Boolean(data.activeRun);
  const status=document.querySelector('#agent-nav-status');status.textContent=state.textContent;status.dataset.tone=active?'active':p.tone;document.querySelector('#question-badge').hidden=true;document.querySelector('#background-badge').hidden=true;
  document.querySelector('[data-view=profile] span').textContent='Çalışma alanı profili';
  const chrome=document.querySelector('.chrome-status'),connection=data.browserStatus??{};chrome.hidden=a.browserMode!=='jev';chrome.dataset.state=connection.state??'idle';chrome.querySelector('b').textContent=connection.ready?'Chrome bağlı':connection.state==='connecting'?'Chrome’a bağlanıyor…':'Chrome bağlantısı';chrome.querySelector('small').textContent=connection.message??(connection.ready?'Seçili Chrome profiline bağlı.':'Chrome’da chrome://inspect/#remote-debugging bağlantısını aç ve bağlantı isteğine izin ver.');chrome.querySelector('button').hidden=Boolean(connection.ready);chrome.querySelector('button').disabled=connection.state==='connecting';
 }
 async function performAction(id){
  if(!data)return;
  if(id==='message')return openConversation();
  if(id==='profile'){navigate('profile');find('#automation-plan-form').scrollIntoView({block:'start'});return;}
  if(id==='results')return navigate('board');
  if(id==='sources')return navigate('sources');
  if(id==='terminal'){navigate('agent');focusAgent();document.querySelector('#agent #terminal').scrollIntoView({block:'center'});return;}
  if(id==='browser')return api.automationBrowser(selected);
  if(id==='stop')return stop();
  if(hasUnsaved()){navigate('profile');notice('Önce profil değişikliklerini kaydet.');return;}
  if(id==='enable')await api.workspaceStart(selected);
  else if(id==='trial'||id==='run')await api.automationRun(selected,id);
  await refresh();navigate('agent');document.querySelector('#now-panel').scrollIntoView({block:'start',behavior:'smooth'});
 }
 async function start(){if(!data||busy)return;const next=automationProgress(data,{dirty:hasUnsaved()}).primary;if(next)return attempt(()=>performAction(next.id))();}
 function renderProgress(){
  if(!data)return;const p=automationProgress(data,{dirty:hasUnsaved()});
  const steps=document.querySelector('#automation-steps'),key=JSON.stringify(p.steps);
  if(steps.dataset.signature!==key){steps.dataset.signature=key;steps.replaceChildren(...p.steps.map((step,i)=>{const li=el('li',null,step.state);li.append(el('span',step.state==='done'?'✓':String(i+1)),document.createTextNode(step.label));if(step.state==='current')li.setAttribute('aria-current','step');return li;}));}
  document.querySelector('#automation-next-step').textContent=p.next;
  const actions=document.querySelector('#automation-next-actions'),signature=JSON.stringify([p.primary,p.secondary,busy,Boolean(data.activeRun)]);
  if(signature!==progressSignature){progressSignature=signature;actions.replaceChildren();for(const [i,item] of [p.primary,...p.secondary].filter(Boolean).entries()){const b=button(item.label,()=>performAction(item.id),i===0?'primary':'quiet');b.dataset.progressAction=item.id;b.disabled=busy;actions.append(b);}}
  const reply=document.querySelector('#automation-agent-reply');reply.hidden=!p.reply||p.reply.text===p.detail||Boolean(data.runs[0]&&p.reply.at<data.runs[0].startedAt);if(!reply.hidden)reply.querySelector('p').textContent=p.reply.text;
  const conversation=find('.automation-conversation');if(conversation)conversation.hidden=false;
  return p;
 }
 async function stop(){await api.workspaceStop(selected);await refresh();}
 async function restart(){await api.workspaceRestart(selected);await refresh();}
 function deselect(){agentConversation.replaceChildren();selected=null;data=null;localStorage.removeItem('selected-automation');host.hidden=true;terminalGeneration++;terminal?.dispose();terminal=null;onSnapshot(null);document.body.classList.remove('automation-workspace');document.querySelector('[data-view=profile] span').textContent='Aday profili';}
 function readForm(){const f=find('#automation-plan-form').elements,t=templates.find(t=>t.id===data.automation.templateId);return {title:f.title.value,goal:f.goal.value,criteria:Object.fromEntries(t.fields.map(field=>[field.id,f['criteria-'+field.id].value])),sources:f.sources.value.split('\n').map(v=>v.trim()).filter(Boolean),instructions:f.instructions.value,facts:f.facts.value,mode:f.mode.value,intervalMinutes:Number(f.intervalMinutes.value),timeoutMinutes:Number(f.timeoutMinutes.value),maxActionsPerDay:Number(f.maxActionsPerDay.value),maxBrowserSteps:Number(f.maxBrowserSteps.value),endAt:f.endAt.value?new Date(f.endAt.value).getTime():null};}
 function fillForm(){
  const a=data.automation,key=JSON.stringify([a.id,a.revision,a.updatedAt]);if(hasUnsaved()||formRevision===key)return;formRevision=key;
  const f=find('#automation-plan-form').elements,criteria=find('#automation-criteria');criteria.replaceChildren();
  templateFields(criteria,data.definition?.fields??templates.find(t=>t.id===a.templateId).fields,a.criteria);
  for(const key of ['title','goal','instructions','facts','mode','intervalMinutes','timeoutMinutes','maxActionsPerDay','maxBrowserSteps'])f[key].value=a[key];f.sources.value=a.sources.join('\n');f.endAt.value=dateInput(a.endAt);

 }
 function renderChatStatus(){
  const feedback=find('#automation-chat-feedback'),send=find('#automation-send'),link=find('#automation-chat-agent');if(!feedback||!send||!data)return;
  const latest=data.runs[0],interview=data.activeRun?.kind==='interview',needsInput=interview&&latest?.state==='AwaitingInput';
  send.textContent=chatSending?'Gönderiliyor…':needsInput?'Giriş / onay bekliyor':interview?'Yanıt hazırlanıyor…':'Gönder';
  feedback.textContent=chatError|| (chatSending?'Mesajın iletiliyor…':needsInput?'Sağlayıcı giriş veya araç izni bekliyor. Devam etmek için agent ekranını aç.':interview?'Asistan yanıt hazırlıyor. Giriş veya izin gerekiyorsa agent ekranını aç.':latest?.kind==='interview'?latest.summary:'');
  feedback.hidden=!feedback.textContent;feedback.classList.toggle('error',Boolean(chatError)||needsInput||(!data.activeRun&&latest?.kind==='interview'&&['failed','blocked','timeout'].includes(latest.status)));
  link.hidden=!(interview||latest?.kind==='interview');
 }
 function renderControls(){
  if(!data||!find('#automation-controls'))return;const a=data.automation,controls=find('#automation-controls');controls.replaceChildren();
  const action=(label,fn,id,disabled)=>{const b=button(label,fn);b.id=id;b.disabled=Boolean(disabled||busy||data.activeRun);controls.append(b);};
  action('Tarayıcıyı aç',()=>api.automationBrowser(selected),'automation-browser',!a.sources.length||hasUnsaved());
  action('Deneme çalıştır',()=>performAction('trial'),'automation-trial',hasUnsaved()||a.reviewedRevision!==a.revision);
  action('Bir kez çalıştır',()=>performAction('run'),'automation-run',hasUnsaved()||a.trial?.status!=='passed'||a.trial.revision!==a.revision);
  const p=automationProgress(data,{dirty:hasUnsaved()});if(p.primary&&!['trial','run'].includes(p.primary.id))action(p.primary.label,()=>performAction(p.primary.id),'automation-next',hasUnsaved());
  renderShell();
 }
 function renderDetail(){
  if(!data||host.hidden)return;const a=data.automation,$=id=>find('#'+id);
  const p=automationProgress(data,{dirty:hasUnsaved()});find('#automation-runtime-note').textContent=p.title+' · '+p.next;
  fillForm();renderControls();$('automation-plan-form').inert=Boolean(data.activeRun);$('automation-save-state').textContent=hasUnsaved()?'Kaydedilmemiş değişiklikler':a.reviewedRevision===a.revision?'Kurulum kaydedildi':data.missing.length?'Eksikler: '+data.missing.join(', '):'Profili kontrol edip kaydet';
  const messages=$('automation-messages'),signature=JSON.stringify(data.messages);if(messages.dataset.signature!==signature){messages.dataset.signature=signature;messages.replaceChildren();for(const m of data.messages){const bubble=el('div',null,'automation-message '+m.role);bubble.append(el('b',m.role==='user'?'Sen':m.role==='assistant'?'Asistan':'Bilgi'),el('p',m.text));messages.append(bubble);}messages.scrollTop=messages.scrollHeight;}
  const docs=$('automation-documents');docs.replaceChildren();for(const doc of data.documents){const b=button(doc.name+' ↗',()=>api.openDocument(selected,doc.path));docs.append(b);}if(!data.documents.length)docs.append(el('small','Bu otomasyona henüz belge eklenmedi.'));
  renderResults();renderRuns();renderWorkspacePages();setPane(pane??'board');setBusy();onSnapshot(data);
 }
 function renderWorkspacePages(){
  const a=data.automation,counts=data.resultCounts;find('#automation-table-title').textContent=a.table?.title??'Başvuru akışı';find('#automation-pipeline').dataset.status=data.activeRun?'running':a.status;
  const metrics=find('.automation-metrics');metrics.replaceChildren();const bar=el('div',null,'pipeline-bar'),legend=el('div',null,'pipeline-legend');for(const [key,value,label] of [['submitted',counts.completedCount,'tamamlandı'],['waiting',counts.pendingCount+counts.uncertainCount,'bekliyor'],['found',Math.max(0,counts.resultCount-counts.completedCount-counts.pendingCount-counts.uncertainCount),'bulundu']]){if(value){const segment=el('span');segment.dataset.key=key;segment.style.flex=String(value);bar.append(segment);}const entry=el('span');entry.dataset.key=key;entry.append(el('b',String(value)),document.createTextNode(' '+label));legend.append(entry);}const samples=Math.max(0,counts.storedCount-counts.resultCount);if(samples){const entry=el('span');entry.append(el('b',String(samples)),document.createTextNode(' araştırma / deneme örneği'));legend.append(entry);}metrics.append(bar,legend);
  sourcePanel.update(data,selected);
  const files=find('#automation-file-list');files.replaceChildren();for(const doc of data.documents){const row=el('div',null,'document-row');row.append(el('strong',doc.name),button('Aç ↗',()=>api.openDocument(selected,doc.path)));files.append(row);}if(!data.documents.length)files.append(el('p','Çalışma alanına eklediğin belgeler burada görünür.','empty'));
 }
 function renderResults(){
  const summary=find('#automation-results-summary');summary.hidden=data.resultCounts.storedCount<=data.results.length;summary.textContent=`Son ${data.results.length} kayıt gösteriliyor; dışa aktarma tüm kayıtları içerir.`;
  resultsTable.update(data,busy);
 }
 async function sendMessage(text){
  const owner=selected,form=find('#automation-plan-form'),pending=prepareAutomationChat(text,hasUnsaved()?{...readForm(),title:form.elements.title.value.trim()||data.automation.title}:null);chatError='';chatSending=true;renderChatStatus();
  try{
   if(pending.draft){await api.automationSave(owner,pending.draft);if(owner===selected){dirty=false;formRevision='';}}
   const run=await api.automationMessage(owner,pending.message);if(owner===selected){await refresh();navigate('agent');focusAgent();}
  }catch(error){chatError=error.message;throw error;}finally{chatSending=false;renderChatStatus();}
 }
 function openConversation(){navigate('agent');const conversation=find('.automation-conversation');conversation.hidden=false;find('#automation-message').focus();conversation.scrollIntoView({block:'center',behavior:'smooth'});}
 function renderRuns(){
  const root=find('#automation-runs');root.replaceChildren();for(const run of data.runs){const row=button('',()=>selectRun(run.id,'background'),'run-row');row.dataset.status=run.status;row.classList.toggle('selected',run.id===selectedRun);row.setAttribute('aria-pressed',String(run.id===selectedRun));const head=el('div',null,'run-head');head.append(el('b',runKindLabel(run.kind)+' · '+(statusNames[run.status]??run.status)),el('time',time(run.startedAt)));row.append(head,el('span',run.summary||({interview:'Kurulum sohbeti',trial:'Deneme',run:'Çalışma'})[run.kind],'run-summary'));root.append(row);}
  if(!data.runs.length)root.append(el('p','Henüz çalışma yok.','background-empty'));
  if(!selectedRun&&data.runs.length)selectedRun=data.runs[0].id;
  const shown=data.runs.find(r=>r.id===selectedRun);find('#automation-run-title').textContent=shown?runKindLabel(shown.kind)+' · '+statusNames[shown.status]:'Agent çıktısı';find('#automation-run-output-label').textContent=shown?.status==='running'?'Canlı agent terminali':'Kayıtlı çıktı · oturum kapalı';
  const desired=selectedRun;if(pane==='background'&&(!terminal||terminalRunId!==desired)&&!terminalLoading)selectRun(desired,pane).catch(e=>notice(e.message));
 }
 async function selectRun(runId,destination='background'){
  setPane(destination);selectedRun=runId;const id=selected,version=++terminalGeneration,hostNode=find('#automation-terminal');
  const run=data.runs.find(r=>r.id===runId);find('#automation-run-title').textContent=run?runKindLabel(run.kind)+' · '+statusNames[run.status]:'Agent çıktısı';find('#automation-run-output-label').textContent=run?.status==='running'?'Canlı agent terminali':'Kayıtlı çıktı · oturum kapalı';
  if(terminal&&terminalRunId===runId){renderRuns();return;}
  terminalLoading=true;pendingOutput=[];
  try{
   const bytes=runId?await api.automationTerminal(id,runId):[];if(id!==selected||version!==terminalGeneration)return;
   if(!terminal){terminal=new XtermSurface(()=>{},()=>{},()=>{});await terminal.mount(hostNode,false);}


   if(id!==selected||version!==terminalGeneration)return;
   terminal.write(new TextEncoder().encode('\x1b[2J\x1b[3J\x1b[H'),()=>{});if(bytes.length)terminal.write(new Uint8Array(bytes),()=>{});else terminal.writeln('Görev başladığında agent çıktısı burada görünecek.');
   terminalRunId=runId;for(const chunk of pendingOutput)terminal.write(new Uint8Array(chunk),()=>{});
  }finally{if(version===terminalGeneration){terminalLoading=false;pendingOutput=[];}}
  renderRuns();
 }
 async function refresh(){const id=selected,version=++generation;await catalog();if(!id)return loadList();const snapshot=await api.workspaceSnapshot(id);if(id!==selected||version!==generation)return;data=snapshot;renderDetail();}
 async function show(name='templates',{detail=false}={}){
  host.hidden=false;if(detail&&selected)return;
  agentConversation.replaceChildren();selected=null;data=null;dirty=false;formRevision='';selectedRun=null;terminalRunId=null;terminalGeneration++;if(terminal){terminal.dispose();terminal=null;}localStorage.removeItem('selected-automation');navigate('templates',{detail:true});await loadList();
 }
 api.onAutomationChange(event=>{if(!event.automationId)templates=[];if(!host.hidden&&!selected)loadList().catch(e=>notice(e.message));});
 api.onAutomationOutput(event=>{if(event.automationId!==selected||event.runId!==selectedRun)return;if(terminalLoading)pendingOutput.push(event.bytes);else terminal?.write(new Uint8Array(event.bytes),()=>{});});
 api.onLogsCleared?.(()=>{pendingOutput=[];terminal?.write(new TextEncoder().encode('\x1b[2J\x1b[3J\x1b[H'),()=>{});});
 return {element:host,show,select,createBlank,refresh,start,stop,restart,reconnectBrowser:async()=>{await api.automationBrowser(selected);await refresh();},renderShell,deselect,showPane(name){setPane(name);if(name==='background'&&data){const runId=selectedRun??data.runs[0]?.id??null;if(!terminalLoading)selectRun(runId,name).catch(e=>notice(e.message));}},sendMessage,get dirty(){return hasUnsaved();},get data(){return data;},hide(){host.hidden=true;},get selected(){return selected;}};
}
