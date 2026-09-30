import {automationTrialReady} from '../app/automation-trial.mjs';
import {defaultPermission} from '../app/agent-settings.mjs';
import {templateFields} from './template-fields.js';
import {automationProgress,runKindLabel} from '../app/automation-progress.mjs';
import {prepareAutomationChat} from './automation-chat.js';
import {automationResultsTable} from './automation-results.js';
import {automationSourcesPanel} from './automation-sources.js';
import {automationOverview} from './automation-overview.js';
import {automationAttentionPanel} from './automation-attention.js';
import {renderMessageText} from './message-text.js';
import './automation-attention.css';
import './automations.css';

const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
const statusNames={draft:'Kurulum',ready:'Denemeye hazır',enabled:'Düzenli çalışıyor',paused:'Duraklatıldı',blocked:'Yardım bekliyor',complete:'Tamamlandı',running:'Çalışıyor',completed:'Tamamlandı',partial:'Kısmi · devam edecek',failed:'Tamamlanamadı',interrupted:'Durduruldu',timeout:'Süre doldu',found:'Bulundu',prepared:'İşlem taslağı',executing:'İşleniyor',uncertain:'Sonuç doğrulanmalı',dismissed:'Atlandı'};
const time=value=>value?new Date(value).toLocaleString('tr-TR'):'—';
const modeNames={observe:'Bul ve bildir',prepare:'Hazırla, onayımı bekle',auto:'Sınırlarım içinde uygula'};
const dateInput=value=>{if(!value)return '';const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};

export function automationsPage(api,{notice,getCatalog,navigate,deleteWorkspace,isDeleting=()=>false,onSnapshot=()=>{},focusAgent=()=>{},syncWorkspaceMenu=()=>{},refreshWorkspaces=async()=>{}}){
 let sourcePanel,overview;
 const host=el('section',null,'automations-page');host.id='automations';host.hidden=true;document.querySelector('main').append(host);
 const agentConversation=el('div',null,'workspace-conversation');agentConversation.dataset.webOnly='';document.querySelector('#now-history').before(agentConversation);
 const progressBox=el('div',null,'workspace-progress');progressBox.dataset.webOnly='';progressBox.innerHTML='<ol id="automation-steps" aria-label="Kurulum ilerlemesi"></ol><p id="automation-next-step"></p><div id="automation-next-actions" class="actions"></div><section id="automation-agent-reply" aria-label="Agent’ın son yanıtı"><b>Agent’ın yanıtı</b><p></p></section>';
 document.querySelector('#now-history').before(progressBox);
 const steps=progressBox.querySelector('#automation-steps');steps.dataset.webOnly='';document.querySelector('#now-panel').prepend(steps);
 agentConversation.before(progressBox);
 const find=selector=>host.querySelector(selector)??agentConversation.querySelector(selector);
 let progressSignature='';
 const templateNav=el('button');templateNav.type='button';templateNav.dataset.view='templates';templateNav.innerHTML='<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg><span>Template’ler</span>';document.querySelector('aside nav button[data-view=config]').before(templateNav);
 let templates=[],selected=null,data=null,pane=null,generation=0,busy=false,dirty=false,formRevision='',chatSending=false,chatError='',resultsTable=null,composerOpen=false,composerState='';
 const attention=automationAttentionPanel(api,{navigate,refresh});
 const hasUnsaved=()=>dirty;
 const attempt=fn=>async(...args)=>{args[0]?.preventDefault?.();if(busy||isDeleting())return;busy=true;setBusy();notice('');try{return await fn(...args);}catch(error){notice(error.message);}finally{busy=false;setBusy();}};
 const button=(label,fn,cls='quiet')=>{const b=el('button',label,cls);b.type='button';b.onclick=attempt(fn);return b;};
 const badge=(status)=>el('span',statusNames[status]??status,'automation-badge '+status);
 const sectionTitle=(title,description)=>{const head=el('div',null,'automation-section-head');head.append(el('h2',title));if(description)head.append(el('p',description));return head;};
 function setBusy(){for(const b of [...host.querySelectorAll('button[data-idle]'),...agentConversation.querySelectorAll('button[data-idle]')])b.disabled=busy||Boolean(data?.activeRun);host.setAttribute('aria-busy',String(busy));agentConversation.setAttribute('aria-busy',String(busy));if(selected&&data){renderControls();renderChatStatus();}}
 async function catalog(){if(!templates.length)templates=await api.automationTemplates();}
 async function loadList(){const current=++generation;await catalog();if(current!==generation||selected)return;renderList();}
 // A blank workspace has nothing in it yet, so picking a template replaces it instead of leaving an empty one behind.
 async function replaceBlank(template){
  const blank=selected,agentSettings=data.automation.agentSettings;
  const a=await api.workspaceCreate(template.id,agentSettings?{agentSettings}:{});await select(a.id);
  await api.deleteWorkspace(blank);await refreshWorkspaces();
 }
 async function create(template){const a=await api.workspaceCreate(template.id,{});await select(a.id);}
 function renderList(){
  if(selected||host.hidden)return;host.replaceChildren();
  const heading=el('div',null,'automation-heading');heading.append(sectionTitle('Bir template ile başla','Hazır bir işleyiş seç; agent sorularla çalışma alanını sana göre düzenlesin.'));
  heading.append(button('Template içe aktar',async()=>{const result=await api.automationTemplateImport();if(result){templates=[];await loadList();notice('Template eklendi. Başlamak için kartını seç.');}}));host.append(heading);
  const grid=el('div',null,'automation-grid template-grid');for(const t of templates){const card=el('article',null,'automation-card template-card');card.append(el('span',t.icon,'automation-icon'),el('h3',t.title),el('p',t.description));const steps=el('ol');for(const step of t.steps)steps.append(el('li',step));card.append(steps);const choose=button(t.id==='custom'?'Ne istediğini anlat →':'Bu template ile başla →',()=>create(t),'primary');choose.dataset.template=t.id;card.append(choose);card.append(button('Template’i dışa aktar',()=>api.automationTemplateExport(t.id),'automation-export-template'));grid.append(card);}host.append(grid);
  host.append(el('p','Bu bilgisayarda çalışır. Düzenli kontroller için uygulamayı ve bilgisayarı açık tut.','automation-local-note'));
 }
 async function select(id){notice('');selected=id;data=null;host.hidden=false;localStorage.setItem('selected-workspace',id);pane=null;formRevision='';dirty=false;buildDetail();navigate('board');await refresh();if(selected!==id)return;if(!data){data=await api.workspaceSnapshot(id);if(selected!==id)return;renderDetail();}if(automationProgress(data).fresh){openConversation();if(data.automation.templateId!=='custom'){await api.automationSetup(id);if(selected===id)await refresh();}}}
 const setupProviders=()=>getCatalog().filter(provider=>provider.supported&&['codex','claude'].includes(provider.id));
 const defaultModel=(provider,saved)=>{const models=provider?.models??[];return models.includes(saved)?saved:models.includes('default')?'default':models[0]??'';};
 async function createBlank(){
  const providers=setupProviders();
  if(!providers.length)throw Error('Kurulum agent’ı için kullanılabilir bir sağlayıcı bulunamadı.');
  const provider=providers.find(item=>item.id==='codex')??providers[0];
  const agentSettings={provider:provider.id,model:defaultModel(provider),permission:defaultPermission(provider.id),reasoning:'default',network:null};
  const a=await api.workspaceCreate('custom',{title:'Yeni çalışma alanı',agentSettings});
  await select(a.id);
 }
 function buildDetail(){
  agentConversation.replaceChildren();progressSignature='';
  host.innerHTML=`<div id="automation-controls" class="actions"></div><p id="automation-runtime-note" class="automation-runtime-note" role="status"></p>
<div class="automation-setup-grid"><section class="automation-conversation"><div class="automation-section-head"><h2>Asistanla kur</h2><p>İhtiyacını anlat, soruları yanıtla veya yapmak istediğin değişikliği yaz.</p></div><div id="automation-messages" class="automation-messages" role="log" aria-label="Kurulum konuşması"></div><form id="automation-chat"><label for="automation-message">Mesajın</label><textarea id="automation-message" placeholder="Örneğin: Berlin’de 1.500 euroya kadar iki odalı ev arıyorum…" maxlength="12000" required></textarea><div class="actions"><button id="automation-send" data-idle type="submit" class="primary">Gönder</button><button id="automation-add-document" data-idle type="button" class="quiet">Belge ekle</button></div><small>Değişiklik konuşması düzenli çalışmayı duraklatır. Yeni bilgiler çalışma alanı profilinde görünür.</small></form></section>
<section class="automation-plan"><div class="automation-section-head"><h2>Kurulum kartı</h2><p>Asistanın hazırladıklarını incele ve düzenle. Yetkiyi buradan sen seçersin.</p></div><form id="automation-plan-form"><label>Ad<input name="title" required maxlength="150"></label><label>Amaç<textarea name="goal" required maxlength="6000"></textarea></label><div id="automation-criteria"></div><label>Kaynak adresleri<textarea name="sources" required placeholder="Her satıra bir adres. Mümkünse doğrudan arama sonuçları bağlantısını kullan."></textarea></label><label>İşleyiş ve bitiş koşulu<textarea name="instructions" maxlength="12000"></textarea></label><details><summary>Kişisel bilgiler ve belgeler</summary><label>Bu otomasyonun kullanabileceği bilgiler<textarea name="facts" maxlength="12000" placeholder="Yalnızca bu iş için gereken bilgiler. Şifreleri burada paylaşma."></textarea></label><div id="automation-documents"></div></details><label>İşlem yetkisi<select name="mode"><option value="observe">Bul ve bildir</option><option value="prepare">Hazırla, onayımı bekle</option><option value="auto">Sınırlarım içinde uygula</option></select></label><div class="automation-form-grid"><label>Kontrol aralığı (dakika)<input type="number" name="intervalMinutes" min="1" max="10080" required></label><label>Günlük işlem sınırı<input type="number" name="maxActionsPerDay" min="1" max="1000" required></label></div><label>Toplam işlem sınırı (isteğe bağlı)<input type="number" name="maxActionsTotal" min="1" max="10000"></label><label>Bitiş tarihi (isteğe bağlı)<input type="datetime-local" name="endAt"></label><div class="automation-plan-footer"><small id="automation-save-state" role="status"></small><button data-idle type="submit" class="primary">Kurulumu kaydet</button></div></form></section></div>
<section class="automation-results-section"><div class="automation-heading"><div><h2>Sonuçlar</h2><p id="automation-results-summary"></p></div><button id="automation-export" type="button" class="quiet">Sonuçları dışa aktar</button></div><div id="automation-results"></div></section>
<section class="automation-history-section"><div class="automation-section-head"><h2>Çalışma geçmişi</h2><p>Her turun sonucu ve gerektiğinde agent ekranı.</p></div><div id="automation-runs"></div></section><div class="automation-bottom-actions"><button id="automation-delete" type="button" class="quiet danger">Otomasyonu sil</button></div>`;
 const $=id=>find('#'+id),form=$('automation-plan-form');
  resultsTable=automationResultsTable($('automation-results'),{button,badge,time,api,refresh,statusNames});
  chatError='';chatSending=false;
  const chatFeedback=el('p',null,'automation-chat-feedback');chatFeedback.id='automation-chat-feedback';chatFeedback.setAttribute('role','status');chatFeedback.setAttribute('aria-live','polite');$('automation-chat').querySelector('.actions').after(chatFeedback);
  const compose=el('button','Tercihlerimi düzenle','quiet automation-compose');compose.type='button';compose.onclick=()=>{openComposer();$('automation-message').focus();};$('automation-chat').prepend(compose);
  form.elements.sources.placeholder='Web adreslerini veya kaynak isteğini yaz. Henüz bilmiyorsan boş bırakıp asistana sorabilirsin.';
  const saveTemplate=button('Template olarak kaydet',()=>{const a=data.automation;templateDialog.querySelector('[name=title]').value=a.title+' template';templateDialog.querySelector('[name=description]').value=templates.find(t=>t.id===a.templateId).description;templateDialog.querySelector('[name=guidance]').value=a.instructions;templateDialog.showModal();});find('.automation-bottom-actions').prepend(saveTemplate);
  form.addEventListener('input',()=>{dirty=true;$('automation-save-state').textContent='Kaydedilmemiş değişiklikler';renderControls();onSnapshot(data);});
  form.onsubmit=attempt(async()=>{const input=readForm();await api.automationSave(selected,input);await api.automationReview(selected);dirty=false;formRevision='';await refresh();notice('Kurulum kaydedildi. Deneme ile kaynakları kontrol edebilirsin.');});
  $('automation-chat').onsubmit=attempt(async()=>{const input=$('automation-message');if(!input.value.trim())return;await sendMessage(input.value);input.value='';composerOpen=false;renderIntro();});
  $('automation-add-document').onclick=attempt(async()=>{await api.pickDocument(selected);await refresh();});
  $('automation-export').onclick=attempt(()=>api.automationExportResults(selected));
  $('automation-delete').onclick=()=>deleteWorkspace({id:selected,title:data.automation.title});
  const setupGrid=find('.automation-setup-grid'),plan=find('.automation-plan'),conversation=find('.automation-conversation'),results=find('.automation-results-section'),history=find('.automation-history-section');
  plan.dataset.automationPane='profile';plan.className='profile automation-plan';plan.querySelector('h2').textContent='Çalışma alanı profili';form.classList.add('profile-form');
  results.dataset.automationPane='board';history.dataset.automationPane='background';
  const agent=agentConversation;
  conversation.hidden=true;conversation.querySelector('.automation-section-head').remove();
  const chat=$('automation-chat');chat.className='background-chat';
  const messages=$('automation-messages'),conversationHistory=el('details',null,'automation-conversation-history');conversationHistory.append(el('summary','Konuşma geçmişi'),messages);chat.after(conversationHistory);agent.append(conversation);
  conversation.prepend(buildIntro(chat));
  const profileHead=plan.querySelector('.automation-section-head'),profileCopy=el('div');profileCopy.append(...profileHead.children);profileHead.replaceChildren(profileCopy);profileHead.className='profile-head';
  const improve=button('Agent ile geliştir',openConversation);plan.querySelector('.profile-head').append(improve);
  const sections=[['Çalışma alanı','Bu otomasyonun adı ve amacı.',['title','goal']],['Ne arıyorsun','Agent sonuçları bu kriterlere göre değerlendirir.',['criteria']],['Kaynaklar ve işleyiş','Taranacak adresler ve takip edilecek adımlar.',['sources','instructions']],['Kişisel bilgiler','Agent yalnızca burada verdiğin bilgileri kullanır.',['facts']],['İşlem yetkisi','Hangi işlemleri yapabileceğini sen seçersin.',['mode']],['Çalışma düzeni','Kontrol sıklığı, günlük işlem yetkisi ve bitiş tarihi.',['intervalMinutes','maxActionsPerDay','maxActionsTotal','endAt']]];
  const profileSections=[];for(const [title,description,names] of sections){const section=el('div',null,'profile-section'),copy=el('div',null,'profile-section-copy'),fields=el('div',null,'profile-fields');copy.append(el('h3',title),el('p',description));for(const name of names){const field=name==='criteria'?$('automation-criteria'):form.elements[name].closest('label');fields.append(field);}if(names.includes('facts'))fields.append($('automation-documents'));section.append(copy,fields);profileSections.push(section);}
  const mode=profileSections.flatMap(section=>[...section.querySelectorAll('select[name=mode]')])[0],authorization=el('div',null,'authorization');for(const [value,title,description] of [['observe','Bul ve bildir','Ara, filtrele ve uygun sonuçları kaydet; mesaj veya başvuru gönderme.'],['prepare','Hazırla, onayımı bekle','İşlem taslağını hazırla; göndermeden önce onayımı al.'],['auto','Sınırlarım içinde uygula','Kaydettiğim kurallara ve günlük sınıra göre işlemleri uygula.']]){const choice=el('label',null,'choice'),input=el('input'),copy=el('span');input.type='radio';input.name='mode';input.value=value;copy.append(el('b',title),el('small',description));choice.append(input,copy);authorization.append(choice);}mode.closest('label').replaceWith(authorization);
  const footer=form.querySelector('.automation-plan-footer');footer.className='profile-foot';footer.querySelector('button').textContent='Profili kaydet';form.replaceChildren(...profileSections,footer);
  history.className='automation-history-section';history.innerHTML='<div class="background-head"><h2>Otomasyon geçmişi</h2><p>Çalışma alanının turları ve sonuçları.</p></div><section class="background-history"><div class="section-title"><h2>Çalışma geçmişi</h2></div><div id="automation-runs" class="run-list"></div></section>';
  const pipeline=el('div',null,'pipeline');pipeline.id='automation-pipeline';const top=el('div',null,'pipeline-top');$('automation-runtime-note').className='campaign-state';top.append($('automation-runtime-note'),$('automation-controls'));pipeline.append(top,el('div',null,'automation-metrics'));results.prepend(pipeline);
  results.querySelector('.automation-heading').className='section-title';results.querySelector('h2').id='automation-table-title';
  const summary=el('section');summary.id='automation-overview';results.prepend(summary);overview=automationOverview(summary,{button,navigate,performAction});
  const sources=el('section');sources.dataset.automationPane='sources';sourcePanel=automationSourcesPanel(sources,api,{refresh,notice,ask:()=>{openConversation();const input=find('#automation-message');if(!input.value.trim())input.value='Hedefime uygun kaynakları araştırıp öner ve takip planımı hazırlamama yardımcı ol.';}});
  const files=el('section');files.dataset.automationPane='files';files.innerHTML='<div class="section-title"><h2>Dosyalar</h2><span>Çalışma alanının belgeleri</span></div><div id="automation-file-list"></div>';files.querySelector('.section-title').append(button('Belge ekle',async()=>{await api.pickDocument(selected);await refresh();}));
  host.append(results,history,files,sources,plan,find('.automation-bottom-actions'));setupGrid.remove();
  find('.automation-bottom-actions').dataset.automationPane='profile';

 }
 const templateDialog=el('dialog');templateDialog.className='automation-template-dialog';templateDialog.innerHTML='<form><h2>Tekrar kullanılabilir template</h2><p>Sorular ve aşağıdaki işleyiş yeni otomasyonlarda kullanılacak. Paylaşılacak metni kontrol et.</p><label>Template adı<input name="title" maxlength="150" required></label><label>Açıklama<textarea name="description" maxlength="1000" required></textarea></label><label>Paylaşılacak işleyiş<textarea name="guidance" maxlength="12000"></textarea></label><small>Kriter cevapları, kişisel bilgiler, kaynak adresleri, belgeler ve hesaplar template’e eklenmez. İşleyiş metnindeki kişisel ayrıntıları kendin çıkar.</small><div class="actions"><button type="button" class="quiet" data-cancel>Vazgeç</button><button type="submit" class="primary">Template’i kaydet</button></div></form>';document.body.append(templateDialog);templateDialog.querySelector('[data-cancel]').onclick=()=>templateDialog.close();templateDialog.querySelector('form').onsubmit=attempt(async event=>{const input=Object.fromEntries(new FormData(event.target));await api.automationTemplateSave(selected,input);templateDialog.close();templates=[];await catalog();notice('Template kaydedildi. Template’ler sayfasından kullanabilir veya dışa aktarabilirsin.');});
 // Setup conversation stays inside the shared Agent page.
 function buildIntro(chat){
  const intro=el('div',null,'workspace-intro');intro.hidden=true;
  intro.append(el('p','Tek cümle yeter. Agent eksik olanı sorar; kaynakları, kriterleri ve işlem yetkisini birlikte belirlersiniz.'));
  const examples=el('div',null,'workspace-intro-examples');examples.setAttribute('aria-label','Örnekler');
  for(const text of ['Berlin’de 1.500 €’ya kadar iki odalı kiralık ev bul, uygun olanları listele.','İstanbul’da uzaktan çalışılabilen ürün yöneticisi ilanlarını takip et ve puanla.','Tokyo–İstanbul uçuşlarında fiyat 600 €’nun altına düşünce haber ver.']){const chip=el('button',text);chip.type='button';chip.onclick=()=>{const input=chat.querySelector('#automation-message');input.value=text;input.focus();input.setSelectionRange(text.length,text.length);};examples.append(chip);}
  const agentRow=el('div',null,'workspace-intro-agent'),provider=el('select'),model=el('select');provider.name='provider';model.name='model';provider.setAttribute('aria-label','Sağlayıcı');model.setAttribute('aria-label','Model');
  agentRow.append(el('span','Agent'),provider,model,el('small','Sonradan Agent ayarlarından değiştirebilirsin.'));
  const fillModels=saved=>{const item=setupProviders().find(entry=>entry.id===provider.value);model.replaceChildren(...(item?.models??[]).map(name=>new Option(name,name)));model.value=defaultModel(item,saved);};
  const persist=attempt(async()=>{const saved=data.automation.agentSettings??{};await api.workspaceSettings(selected,{agentSettings:{...saved,provider:provider.value,model:model.value,permission:defaultPermission(provider.value)}});await refresh();});
  provider.onchange=()=>{fillModels();persist();};model.onchange=persist;
  const gallery=el('details',null,'workspace-intro-templates');gallery.append(el('summary','Hazır bir template kullan'));const cards=el('div');gallery.append(cards);
  intro.append(examples,gallery,agentRow);
  intro.sync=()=>{const providers=setupProviders(),saved=data.automation.agentSettings??{};if(provider.dataset.catalog!==String(providers.length)){provider.dataset.catalog=String(providers.length);provider.replaceChildren(...providers.map(item=>new Option(item.label,item.id)));}if(providers.some(item=>item.id===saved.provider))provider.value=saved.provider;fillModels(saved.model);
   const offered=templates.filter(t=>t.id!=='custom');gallery.hidden=!offered.length;if(cards.dataset.catalog!==offered.map(t=>t.id).join()){cards.dataset.catalog=offered.map(t=>t.id).join();cards.replaceChildren(...offered.map(t=>{const card=button('',()=>replaceBlank(t),'workspace-template');card.dataset.introTemplate=t.id;card.dataset.idle='';card.append(el('span',t.icon,'automation-icon'),el('b',t.title),el('small',t.description));return card;}));}};
  return intro;
 }
 function renderIntro(){
  const intro=find('.workspace-intro'),chat=find('#automation-chat');if(!intro||!data)return;
  const fresh=automationProgress(data).fresh;document.body.classList.toggle('workspace-fresh',fresh);intro.hidden=!fresh;
  const history=find('.automation-conversation-history');if(history)history.hidden=fresh;
  // The reply box is for answering the agent; without a question it stays behind a button.
  const progress=automationProgress(data,{dirty:hasUnsaved()}),asking=progress.primary?.id==='message',input=find('#automation-message'),working=Boolean(data.activeRun);
  if(composerState!==progress.title){composerState=progress.title;composerOpen=false;}
  chat.classList.toggle('composer-closed',working||!(fresh||asking||composerOpen||chatError||input.value.trim()));
  chat.querySelector('.automation-compose').hidden=working;
  input.disabled=working||chatSending;
  chat.querySelector('label').textContent=fresh?'Mesajın':asking?'Yanıtın':'Değişiklik isteğin';
  input.placeholder=fresh?'Örneğin: Berlin’de 1.500 euroya kadar iki odalı ev arıyorum…':asking?'Asistanın sorularını buradan yanıtla…':'Tercihlerinde neyi değiştirmek istiyorsun?';
  chat.querySelector('small').textContent=fresh?'İhtiyacını anlat; asistan gerekli bilgileri sana soracak.':data.automation.status==='enabled'?'Değişiklik gönderdiğinde düzenli takip duraklatılır.':'';
  chat.querySelector('small').hidden=!chat.querySelector('small').textContent;
  if(fresh)intro.sync();
 }
 function setPane(name){const page=({results:'board',setup:'profile',history:'background'})[name]??name;pane=page;localStorage.setItem('selected-view',page);for(const b of document.querySelectorAll('aside nav button'))b.classList.toggle('selected',b.dataset.view===page);for(const section of host.querySelectorAll('[data-automation-pane]'))section.hidden=section.dataset.automationPane!==page;}
 function renderShell(){
  if(!selected||!data)return;const locked=busy||isDeleting(),p=renderProgress(),a=data.automation,active=Boolean(data.activeRun)||a.status==='enabled',ready=automationTrialReady(a);
  document.querySelector('#heading').textContent=a.title;const workspaces=document.querySelector('#candidates'),value=a.id;if(![...workspaces.options].some(o=>o.value===value))workspaces.add(new Option(a.title,value));workspaces.value=value;const state=document.querySelector('#agent-state');state.textContent=p.label;state.dataset.active=String(active);
  const start=document.querySelector('#start'),stop=document.querySelector('#stop'),restart=document.querySelector('#restart-agent');start.hidden=active||!p.primary;stop.hidden=!active;start.disabled=locked||hasUnsaved();stop.disabled=locked;restart.disabled=locked||hasUnsaved()||!ready;start.textContent=p.primary?.label??'Çalışıyor';stop.textContent=data.activeRun?'Turu durdur':'Takibi duraklat';restart.hidden=true;
  for(const id of ['candidates','new'])document.querySelector('#'+id).disabled=locked;
  document.querySelector('#rename-workspace').disabled=locked||Boolean(data.activeRun);
  document.querySelector('#delete-workspace').disabled=locked;
  find('#automation-delete').disabled=locked;
  const helpCount=attention.update(selected,data);
  const status=document.querySelector('#agent-nav-status');status.textContent=helpCount?`${helpCount} müdahale`:p.fresh?'1/3':state.textContent;status.dataset.tone=helpCount?'waiting':active?'active':p.tone;agentNavLabel(p.fresh);document.querySelector('#question-badge').hidden=true;document.querySelector('#background-badge').hidden=true;
  document.querySelector('[data-view=profile] span').textContent='Çalışma alanı profili';
  document.querySelector('[data-view=board] span').textContent='Takip tablosu';
  const chrome=document.querySelector('.chrome-status'),connection=data.browserStatus??{};chrome.hidden=a.browserMode!=='jev';chrome.dataset.state=connection.state??'idle';chrome.querySelector('b').textContent=connection.ready?'Chrome bağlı':connection.state==='connecting'?'Chrome’a bağlanıyor…':'Chrome bağlantısı';chrome.querySelector('small').textContent=connection.ready?(a.chromeProfile?.name??'Seçili Chrome oturumu'):(connection.message??'Chrome’da chrome://inspect/#remote-debugging bağlantısını aç ve bağlantı isteğine izin ver.');chrome.querySelector('.chrome-reconnect').hidden=Boolean(connection.ready);chrome.querySelector('.chrome-reconnect').disabled=locked||connection.state==='connecting';chrome.querySelector('.chrome-profile-change').disabled=locked;
  syncWorkspaceMenu();
 }
 async function performAction(id){
  if(!data)return;
  if(id==='message')return openConversation();
  if(id==='questions'){navigate('agent');document.querySelector('.automation-attention')?.scrollIntoView({block:'start'});return;}
  if(id==='setup'){await api.automationSetup(selected);await refresh();navigate('agent');return;}
  if(id==='profile'){navigate('profile');find('#automation-plan-form').scrollIntoView({block:'start'});return;}
  if(id==='results')return navigate('board');
  if(id==='sources')return navigate('sources');
  if(id==='terminal'){navigate('agent');focusAgent({view:'terminal'});document.querySelector('#agent #terminal').scrollIntoView({block:'center'});return;}
  if(id==='browser')return api.automationBrowser(selected);
  if(id==='stop')return stop();
  if(hasUnsaved()){navigate('profile');notice('Önce profil değişikliklerini kaydet.');return;}
  if(id==='enable')await api.workspaceStart(selected);
  else if(id==='skip-trial')await api.automationSkipTrial(selected);
  else if(id==='trial'||id==='run')await api.automationRun(selected,id);
  await refresh();navigate('agent');document.querySelector('#now-panel').scrollIntoView({block:'start',behavior:'smooth'});
 }
 async function start(){if(!data||busy)return;const next=automationProgress(data,{dirty:hasUnsaved()}).primary;if(next)return attempt(()=>performAction(next.id))();}
 function renderProgress(){
  if(!data)return;const p=automationProgress(data,{dirty:hasUnsaved()});
  const steps=document.querySelector('#automation-steps'),key=JSON.stringify(p.steps);
  // Once setup and trial are done the workspace is simply running; the stepper has nothing left to guide.
  steps.hidden=p.steps.slice(0,-1).every(step=>step.state==='done');
  if(steps.dataset.signature!==key){steps.dataset.signature=key;steps.replaceChildren(...p.steps.map((step,i)=>{const li=el('li',null,step.state);li.append(el('span',step.state==='done'?'✓':String(i+1)),document.createTextNode(step.label));if(step.state==='current')li.setAttribute('aria-current','step');return li;}));}
  const next=document.querySelector('#automation-next-step');next.textContent=p.next;next.hidden=p.primary?.id==='message';
  const actions=document.querySelector('#automation-next-actions'),signature=JSON.stringify([p.primary,p.secondary,busy,Boolean(data.activeRun)]);
  if(signature!==progressSignature){progressSignature=signature;actions.replaceChildren();for(const item of [p.primary,...p.secondary].filter(item=>item&&item.id!=='message')){const b=button(item.label,()=>performAction(item.id),item===p.primary?'primary':'quiet');b.dataset.progressAction=item.id;b.disabled=busy;actions.append(b);}}
  const reply=document.querySelector('#automation-agent-reply');reply.hidden=p.fresh||p.running||!p.reply||p.reply.text===p.detail||Boolean(data.runs[0]&&p.reply.at<data.runs[0].startedAt);if(!reply.hidden)renderMessageText(reply.querySelector('p'),p.reply.text);
  const conversation=find('.automation-conversation');if(conversation)conversation.hidden=false;
  return p;
 }
 async function stop(){await api.workspaceStop(selected);await refresh();}
 async function restart(){await api.workspaceRestart(selected);await refresh();}
 function agentNavLabel(){const nav=document.querySelector('aside nav button[data-view=agent]');nav.querySelector('span').textContent='Agent';}
 function deselect(){attention.update(null,null);agentNavLabel(false);agentConversation.replaceChildren();document.body.classList.remove('workspace-fresh');selected=null;data=null;localStorage.removeItem('selected-workspace');host.hidden=true;onSnapshot(null);document.body.classList.remove('automation-workspace');document.querySelector('[data-view=profile] span').textContent='Çalışma alanı profili';document.querySelector('[data-view=board] span').textContent='Takip tablosu';}
 function readForm(){const f=find('#automation-plan-form').elements,t=templates.find(t=>t.id===data.automation.templateId);return {title:f.title.value,goal:f.goal.value,criteria:Object.fromEntries(t.fields.map(field=>[field.id,f['criteria-'+field.id].value])),sources:f.sources.value.split('\n').map(v=>v.trim()).filter(Boolean),instructions:f.instructions.value,facts:f.facts.value,mode:f.mode.value,intervalMinutes:Number(f.intervalMinutes.value),maxActionsPerDay:Number(f.maxActionsPerDay.value),maxActionsTotal:f.maxActionsTotal.value?Number(f.maxActionsTotal.value):null,endAt:f.endAt.value?new Date(f.endAt.value).getTime():null};}
 function fillForm(){
  const a=data.automation,key=JSON.stringify([a.id,a.revision,a.updatedAt]);if(hasUnsaved()||formRevision===key)return;formRevision=key;
  const f=find('#automation-plan-form').elements,criteria=find('#automation-criteria');criteria.replaceChildren();
  templateFields(criteria,data.definition?.fields??templates.find(t=>t.id===a.templateId).fields,a.criteria);
  for(const key of ['title','goal','instructions','facts','mode','intervalMinutes','maxActionsPerDay'])f[key].value=a[key];f.sources.value=a.sources.join('\n');f.endAt.value=dateInput(a.endAt);f.maxActionsTotal.value=a.maxActionsTotal??'';

 }
 function renderChatStatus(){
  const feedback=find('#automation-chat-feedback'),send=find('#automation-send');if(!feedback||!send||!data)return;
  send.textContent=chatSending?'Gönderiliyor…':'Gönder';
  feedback.textContent=chatError||(chatSending?'Mesajın iletiliyor…':'');
  feedback.hidden=!feedback.textContent;feedback.classList.toggle('error',Boolean(chatError));
 }
 function renderControls(){
  if(!data||!find('#automation-controls'))return;const a=data.automation,controls=find('#automation-controls');controls.replaceChildren();
  const action=(label,fn,id,disabled)=>{const b=button(label,fn);b.id=id;b.disabled=Boolean(disabled||busy||data.activeRun);controls.append(b);};
  action('Tarayıcıyı aç',()=>api.automationBrowser(selected),'automation-browser',!a.sources.length||hasUnsaved());
  action('Deneme çalıştır',()=>performAction('trial'),'automation-trial',hasUnsaved()||a.reviewedRevision!==a.revision);
  action('Bir kez çalıştır',()=>performAction('run'),'automation-run',hasUnsaved()||!automationTrialReady(a));
  const p=automationProgress(data,{dirty:hasUnsaved()});if(p.primary&&!['trial','run'].includes(p.primary.id))action(p.primary.label,()=>performAction(p.primary.id),'automation-next',hasUnsaved());
  overview?.update(data,p,{busy:busy||isDeleting()});
  renderShell();
 }
 function renderDetail(){
  if(!data||host.hidden)return;const a=data.automation,$=id=>find('#'+id);
  const p=automationProgress(data,{dirty:hasUnsaved()});find('#automation-runtime-note').textContent=p.title+' · '+p.next;
  fillForm();renderControls();$('automation-plan-form').inert=Boolean(data.activeRun);$('automation-save-state').textContent=hasUnsaved()?'Kaydedilmemiş değişiklikler':a.reviewedRevision===a.revision?'Kurulum kaydedildi':data.missing.length?'Eksikler: '+data.missing.join(', '):'Profili kontrol edip kaydet';
  const messages=$('automation-messages'),signature=JSON.stringify(data.messages);if(messages.dataset.signature!==signature){messages.dataset.signature=signature;messages.replaceChildren();for(const m of data.messages){const bubble=el('div',null,'automation-message '+m.role),text=el('p');renderMessageText(text,m.text);bubble.append(el('b',m.role==='user'?'Sen':m.role==='assistant'?'Asistan':'Bilgi'),text);messages.append(bubble);}messages.scrollTop=messages.scrollHeight;}
  const docs=$('automation-documents');docs.replaceChildren();for(const doc of data.documents){const b=button(doc.name+' ↗',()=>api.openDocument(selected,doc.path));docs.append(b);}if(!data.documents.length)docs.append(el('small','Bu otomasyona henüz belge eklenmedi.'));
  renderResults();renderRuns();renderWorkspacePages();renderIntro();setPane(pane??'board');setBusy();onSnapshot(data);
 }
 function renderWorkspacePages(){
  const a=data.automation,counts=data.resultCounts;find('#automation-table-title').textContent=a.table?.title??'Takip akışı';find('#automation-pipeline').dataset.status=data.activeRun?'running':a.status;
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
 function openComposer(){if(data)composerState=automationProgress(data,{dirty:hasUnsaved()}).title;composerOpen=true;renderIntro();}
 function openConversation(){openComposer();navigate('agent');const conversation=find('.automation-conversation');conversation.hidden=false;find('#automation-message').focus();conversation.scrollIntoView({block:'center',behavior:'smooth'});}
 function renderRuns(){
  const root=find('#automation-runs');root.replaceChildren();for(const run of data.runs){const row=el('div',null,'run-row');row.dataset.status=run.status;const head=el('div',null,'run-head');head.append(el('b',runKindLabel(run.kind)+' · '+(statusNames[run.status]??run.status)),el('time',time(run.startedAt)));row.append(head,el('span',run.summary||({interview:'Kurulum sohbeti',trial:'Deneme',run:'Çalışma'})[run.kind],'run-summary'));root.append(row);}
  if(!data.runs.length)root.append(el('p','Henüz çalışma yok.','background-empty'));
 }
 async function refresh(){
  if(isDeleting())return;const id=selected,version=++generation;
  const stale=()=>isDeleting()||id!==selected||version!==generation;
  try{await catalog();if(stale())return;if(!id)return loadList();const snapshot=await api.workspaceSnapshot(id);if(stale())return;data=snapshot;renderDetail();}
  catch(error){if(!stale())throw error;}
 }
 async function show(name='templates',{detail=false}={}){
  host.hidden=false;if(detail&&selected)return;
  agentNavLabel(false);agentConversation.replaceChildren();document.body.classList.remove('workspace-fresh');selected=null;data=null;dirty=false;formRevision='';localStorage.removeItem('selected-workspace');navigate('templates',{detail:true});await loadList();
 }
 api.onAutomationChange(event=>{if(!event.automationId)templates=[];if(!host.hidden&&!selected)loadList().catch(e=>notice(e.message));});
 return {element:host,show,select,createBlank,refresh,start,stop,restart,reconnectBrowser:async()=>{await api.automationBrowser(selected);await refresh();},renderShell,deselect,showPane(name){setPane(name);},sendMessage,get busy(){return busy;},get dirty(){return hasUnsaved();},get data(){return data;},hide(){host.hidden=true;},get selected(){return selected;}};
}
