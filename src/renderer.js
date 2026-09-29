import {instructionsPanel} from './instructions.js';
import {templateFields,templateValues} from './template-fields.js';
import {recordTable,recordCell,recordActions,recordState} from './record-table.js';
import {createPreparationUI,preparationLabel} from './preparation.js';
import {automationsPage} from './automations.js';
import {accountCredentials} from './account-credentials.js';
import {jobDisplayStatus} from './job-status.js';
import {browserWaitView,createBrowserWaitDialog} from './browser-status.js';
import {jobRankCell} from './job-rank.js';
import {createJobFilters} from './job-filters.js';
import {createRankSettings} from './rank-settings.js';
import {openSourcePanel} from './source-panel.js';
import {questionForm} from './question-form.js';
import {workerTerminals} from './worker-terminals.js';
import {activityPanels} from './activity-panels.js';
import './style.css';
import './browser-status.css';
import './termloop-theme.css';
import './sidebar.css';
import './activity.css';
import './sources.css';
import './board.css';
import './profile.css';
import {backgroundPage} from './background.js';
import {onboarding} from './onboarding.js';
import {configPage} from './config.js';
import {notificationsPage} from './notifications.js';
import {sourceResultView,applicationActivity,pendingQuestions,isQuestionRetryPending} from './activity.js';
const api=window.jobloop,$=id=>document.getElementById(id);
const JOBS_PER_PAGE=10;
const JOB_SORT_KEYS=['company','role','location','status','rank','updatedAt'];
const observedStates=new Map();
const pinnedRowObserver=new ResizeObserver(updatePinnedJobOffsets);
let chromeProfiles=[],chromeProfilesError='';
let catalog=[],jobPage=1,jobSort=loadJobSort();
let workspaceAgent=null,agentSettingsSignature='';
let candidate=localStorage.getItem('selected-candidate'),snapshot=null,running=false,busy=false,newCandidate=false;
const names={found:'Bulundu',working:'Üzerinde çalışıyor',prepared:'Gönderime hazır',submitting:'Gönderiliyor',submitted:'Gönderildi',already_submitted:'Gönderildi',blocked:'Bilgi / işlem bekliyor',uncertain:'Sonuç doğrulanmalı',skipped:'Elendi'};
const jobStatusLabel=job=>job.preparation?.hold&&!['submitted','already_submitted','skipped','uncertain','submitting'].includes(job.status)?preparationLabel(job.preparation):jobDisplayStatus(snapshot,job)==='queued'?'Başvuru sırasında':jobDisplayStatus(snapshot,job)==='working'&&job.status==='blocked'?'Üzerinde çalışıyor':isQuestionRetryPending(snapshot,job.id)?'Yeniden deneme sırasında':job.candidateSubmission&&job.status==='submitted'?'Gönderildi · Kullanıcı beyanı':job.missingDocuments&&job.status==='blocked'?'Belge bekliyor':job.followupStopped&&jobDisplayStatus(snapshot,job)!=='submitted'?(job.status==='uncertain'?'Takip bırakıldı · Sonuç belirsiz':'Takip bırakıldı'):({already_submitted:'Gönderildi',manual_submitted:'Manuel gönderildi',withdrawn:'Vazgeçildi'}[job.manualOutcome]??names[job.status]);
const setupUI=onboarding(api,{showProfile:()=>switchView('profile'),select:async id=>{candidate=id;newCandidate=false;await refresh();fillProfile();},refresh:async()=>{await refresh();fillProfile();},cancel:async()=>{candidate=null;newCandidate=false;await refresh();fillProfile();switchView('automations');}});
const notice=message=>{$('notice').textContent=message;$('notice').hidden=!message;};
const attempt=fn=>async(...args)=>{try{return await fn(...args);}catch(e){notice(e.message);}};
const workspaceActions=document.createElement('div');workspaceActions.className='workspace-actions';
workspaceActions.innerHTML='<button id="rename-workspace" class="quiet" type="button">Yeniden adlandır</button><button id="delete-workspace" class="quiet danger" type="button">Sil</button>';
$('new').after(workspaceActions);
const renameDialog=document.createElement('dialog');renameDialog.id='rename-workspace-dialog';
renameDialog.innerHTML='<form method="dialog"><h2>Çalışma alanını yeniden adlandır</h2><label>Yeni ad<input name="workspaceName" maxlength="150" required></label><div class="workspace-dialog-actions"><button class="quiet" type="button" data-cancel>Vazgeç</button><button class="primary" type="submit">Kaydet</button></div></form>';
document.body.append(renameDialog);
renameDialog.querySelector('[data-cancel]').onclick=()=>renameDialog.close();
const selectedWorkspace=()=>({id:automationUI?.selected??candidate,title:automationUI?.selected?automationUI.data.automation.title:snapshot?.profile.workspaceName||snapshot?.profile.name});
$('rename-workspace').onclick=()=>{const owner=selectedWorkspace();if(!owner.id)return;renameDialog.dataset.workspaceId=owner.id;renameDialog.querySelector('input').value=owner.title;renameDialog.showModal();renameDialog.querySelector('input').select();};
renameDialog.querySelector('form').onsubmit=attempt(async event=>{event.preventDefault();const owner=renameDialog.dataset.workspaceId,submit=renameDialog.querySelector('[type=submit]');submit.disabled=true;try{await api.renameWorkspace(owner,renameDialog.querySelector('input').value);renameDialog.close();await refresh();notice('Çalışma alanı yeniden adlandırıldı.');}finally{submit.disabled=false;}});
$('delete-workspace').onclick=attempt(async()=>{const owner=selectedWorkspace();if(!owner.id)return;if(!confirm(`“${owner.title}” çalışma alanı silinsin mi? Kayıtlar, belgeler ve çalışma geçmişi kalıcı olarak kaldırılacak.`))return;busy=true;controls();try{await api.deleteWorkspace(owner.id);if(automationUI?.selected===owner.id)automationUI.deselect();if(candidate===owner.id){candidate=null;localStorage.removeItem('selected-candidate');}await refresh();fillProfile();switchView(candidate?'board':'templates');notice(`“${owner.title}” çalışma alanı silindi.`);}finally{busy=false;controls();}});
const backgroundUI=backgroundPage(api,{notice,getCatalog:()=>catalog});
const notificationsUI=notificationsPage(api,{notice});
const configUI=configPage(api,{notice,relativeTime,openNotifications:()=>switchView('notifications')});
let newJobTemplate='job-search',newJobDefinition=null;
const automationUI=automationsPage(api,{notice,getCatalog:()=>catalog,navigate:(name,options)=>switchView(name,options),startJob:async template=>newJobWorkspace(template),onSnapshot:syncWorkspaceAgent,focusAgent:()=>terminals.focus()});
const accountUI=api.saveAccountCredentials?accountCredentials(api,{profile:$('profile-form'),board:$('board'),showProfile:()=>switchView('profile'),queue:(id,jobId)=>api.queueApplication(id,jobId)}):null;
if(api.telegramStatus){const card=document.createElement('section');card.className='profile-card profile-telegram';card.innerHTML='<div class="profile-section"><div class="profile-section-copy"><h3>Telegram</h3><p>Başvurularını takip et ve agent’ın sorularını telefondan yanıtla.</p></div><div class="profile-fields telegram-row"><button type="button" class="quiet">Telegram’a bağlan</button></div></div>';card.querySelector('button').onclick=()=>{switchView('notifications');};$('profile').append(card);}
await document.fonts.ready;
const terminalSection=document.querySelector('#agent .terminal-section');
$('agent-settings').before(terminalSection);
const terminals=workerTerminals(api,{container:terminalSection,notice,refresh:()=>refresh(),beforeAction:async(id,method,worker)=>{await settingsQueue;if(automationUI?.selected===id&&automationUI.dirty&&['startWorker','restartWorker'].includes(method)){switchView('profile');throw Error('Önce profil değişikliklerini kaydet.');}if(automationUI?.selected===id&&method==='startWorker'&&worker==='main'&&!(automationUI.data.progress.reviewed&&automationUI.data.progress.passed)){await automationUI.start();return false;}},sendMessage:async(id,text,worker)=>{await settingsQueue;if(automationUI?.selected===id)return automationUI.sendMessage(text);return api.terminalMessage(id,text,worker);}});
const instructionsUI=instructionsPanel(api,$('agent'));
function element(tag,cls,value){const el=document.createElement(tag);if(cls)el.className=cls;if(value!==undefined)el.textContent=value;return el;}
const limitWarning=element('section','campaign-limit-warning');limitWarning.id='campaign-limit-warning';limitWarning.hidden=true;limitWarning.tabIndex=-1;limitWarning.setAttribute('role','alert');limitWarning.setAttribute('aria-labelledby','campaign-limit-title');
let requestedLimit=null;
// An idle provider session may stay alive after the campaign reaches its limit.
function campaignControlsActive(){return snapshot?.campaign?.status==='running'||(running&&snapshot?.campaign?.status!=='complete');}
limitWarning.innerHTML='<span class="campaign-limit-icon" aria-hidden="true">!</span><div class="campaign-limit-copy"><h2 id="campaign-limit-title"></h2><p id="campaign-limit-counts"></p><p>Yeni başvurulara devam etmek için başvuru limitini artır.</p></div><button id="edit-campaign-limit" class="quiet" type="button">Limiti düzenle</button>';
$('notice').after(limitWarning);
$('edit-campaign-limit').onclick=()=>{switchView('board');$('campaign-target').scrollIntoView({block:'center'});$('campaign-target').focus();$('campaign-target').select();};
function renderCampaignLimit(){
 const target=requestedLimit?.candidateId===candidate?requestedLimit.target:snapshot?.campaign?.target,submitted=(snapshot?.jobs??[]).filter(j=>jobDisplayStatus(snapshot,j)==='submitted').length;
 limitWarning.hidden=!target||submitted<target;
 if(limitWarning.hidden)return;
 $('campaign-limit-title').textContent=submitted>target?'Başvuru limiti aşıldı':'Başvuru limitine ulaşıldı';
 $('campaign-limit-counts').textContent=`${submitted} başvuru gönderildi · Mevcut limit: ${target}`;
 $('edit-campaign-limit').disabled=busy||campaignControlsActive();
}
$('campaign-target').addEventListener('input',()=>{requestedLimit=null;renderCampaignLimit();});
const chromeStatus=element('div','chrome-status');chromeStatus.setAttribute('role','status');chromeStatus.setAttribute('aria-live','polite');
const chromeTitle=element('b'),chromeDetail=element('small'),chromeReconnect=element('button','quiet','Yeniden bağlan');chromeReconnect.type='button';
chromeStatus.append(chromeTitle,chromeDetail,chromeReconnect);document.querySelector('.sidebar-bottom').before(chromeStatus);
chromeReconnect.onclick=attempt(async()=>{chromeReconnect.disabled=true;if(automationUI?.selected){await automationUI.reconnectBrowser();return;}await api.browserReconnect(candidate);await refresh();});
const chromeApproval=createBrowserWaitDialog({
 reconnect:async id=>{await api.browserReconnect(id);await refresh();},
 cancel:async id=>{const state=await api.workspaceSnapshot(id);if(state.setup?.status==='running'&&state.setup.mode==='improve'){await api.finishProfileImprovement(id);switchView('profile');}else await api.workspaceStop(id);await refresh();}
});
document.body.append(chromeApproval.element,chromeApproval.reminder);
function renderChromeStatus(){
 if(automationUI?.selected){automationUI.renderShell();return;}
  const state=snapshot?.browserStatus??{state:'idle'};
  chromeApproval.update(snapshot,busy);
  const wait=browserWaitView(snapshot);if(wait?.starting)$('agent-state').textContent=wait.title;
  chromeStatus.hidden=!candidate||snapshot?.profile?.browserMode!=='jev';chromeStatus.dataset.state=state.state;
  chromeTitle.textContent=({ready:'Chrome bağlı',connecting:'Chrome’a bağlanıyor…',waiting:'Chrome bağlantısı bekleniyor',idle:'Chrome bağlantısı hazır değil'})[state.state]??'Chrome';
  chromeDetail.textContent=state.ready?(snapshot?.profile?.chromeProfile?.name??'Seçili Chrome oturumu'):state.state==='waiting'?(state.message||'Aynı iş korunuyor. Chrome açıkken bağlantı otomatik yeniden denenecek.'):state.state==='connecting'?'Chrome’da “Allow remote debugging?” penceresi görünürse Allow / İzin ver düğmesine bas. Aynı iş korunuyor.':'Agent başlamadan önce Chrome izni alınır.';
  chromeDetail.title=state.message??'';chromeReconnect.hidden=state.ready||state.state==='connecting';chromeReconnect.disabled=busy;
}
const jobSearch=element('input','job-search');jobSearch.id='job-search';jobSearch.type='search';jobSearch.placeholder='Şirket, pozisyon veya konum ara…';jobSearch.setAttribute('aria-label','Başvurularda ara');jobSearch.setAttribute('aria-controls','jobs');jobSearch.title='Şirket, pozisyon, konum, durum veya notlarda ara';$('filter').before(jobSearch);
const sourcesNav=element('button','');sourcesNav.dataset.view='sources';sourcesNav.innerHTML='<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>Kaynaklar</span>';document.querySelector('nav button[data-view="agent"]').before(sourcesNav);
const sourcesView=element('section');sourcesView.id='sources';sourcesView.hidden=true;sourcesView.innerHTML=`<div class="sources-head"><div><h2>Kaynaklar</h2><p id="sources-summary">Agent yalnızca etkin kaynakları, belirlediğin aralıklarla tarar.</p></div><button id="source-add-toggle" class="primary" type="button" aria-expanded="false" aria-controls="source-add">＋ Kaynak ekle</button></div><form id="source-add" class="source-add" hidden><label>Kaynak adı<input name="name" required maxlength="120" placeholder="Örn. Berlin AI şirketleri"></label><label>Başlangıç adresi<input name="url" type="url" required placeholder="https://…"></label><label class="source-query">Arama kapsamı<textarea name="query" required maxlength="2000" placeholder="Hangi roller, hangi şehirler, nelere dikkat edilmeli"></textarea></label><div class="source-add-foot"><label>Tarama aralığı<input name="intervalMinutes" type="number" min="1" max="10080" value="30" required aria-describedby="source-add-unit"></label><label>Başvuru modu<select name="applyMode"><option value="find_only">Sadece bul</option><option value="prepare">Hazırla</option><option value="auto" selected>Otomatik gönder</option></select></label><button id="source-add-cancel" class="quiet" type="button">Vazgeç</button><button class="primary" type="submit">Kaynağı ekle</button></div></form><ul id="source-rows" class="source-list"></ul><form id="application-policy" class="policy"><div class="policy-head"><h2>Otomatik cevap kuralları</h2><p>Başvuru formlarında agent yalnızca kayıtlı gerçekleri kullanır. Deneyim, kimlik, yetkinlik ve hukuki beyanlar asla uydurulmaz; emin olmadığı yerde aşağıdaki kurallara göre davranır.</p></div><label class="policy-row"><span><b>Kayıtlı profil cevaplarını otomatik kullan</b><small>Ad, iletişim, çalışma izni gibi bilinen alanlar sorulmadan doldurulur.</small></span><input class="switch" name="autoFillKnown" type="checkbox"></label><label class="policy-row"><span><b>Zorunlu gizlilik ve veri işleme bildirimlerini kabul et</b><small>Başvurunun gönderilmesi için şart koşulan onay kutuları işaretlenir.</small></span><input class="switch" name="acceptPrivacy" type="checkbox"></label><label class="policy-row"><span><b>Şirket grubu ve diğer roller için işe alım veri onayı</b><small>Başvuru bilgilerinin şirket ve aynı şirket grubundaki diğer pozisyonlar için saklanması, işlenmesi ve paylaşılmasını sormadan onayla. Pazarlama iznini kapsamaz.</small></span><input class="switch" name="groupRecruitmentConsent" type="checkbox"></label><label class="policy-row"><span><b>Opsiyonel demografik sorular</b><small>Cinsiyet, etnik köken, engellilik gibi isteğe bağlı alanlar.</small></span><select name="demographic"><option value="prefer_not_to_say">Belirtmek istemiyorum</option><option value="profile_only">Yalnızca profilde varsa cevapla</option></select></label><label class="policy-row"><span><b>Pazarlama onayları</b><small>Reklam, ürün tanıtımı ve işe alım dışındaki iletişim izinleri.</small></span><select name="marketing"><option value="decline">Reddet</option><option value="auto">Otomatik onayla</option><option value="profile_only">Yalnızca profilde varsa cevapla</option></select></label><label class="policy-row"><span><b>Bilinmeyen önemli bilgi</b><small>Maaş beklentisi, başlama tarihi gibi profilde olmayan zorunlu alanlar.</small></span><select name="unknownImportant"><option value="ask">Bana sor</option><option value="skip">İlanı atla</option></select></label><label class="policy-row"><span><b>Yeni sözleşme veya release agreement</b><small>Başvuru sırasında imza isteyen hukuki metinler.</small></span><select name="legalAgreements"><option value="ask">Bana sor</option><option value="auto">Otomatik onayla</option><option value="skip">İlanı atla</option></select></label><div class="policy-foot"><button class="primary" type="submit">Kuralları kaydet</button></div></form>`;document.querySelector('main').insertBefore(sourcesView,$('files'));
$('campaign-interval').closest('label').hidden=true;
const preparationUI=createPreparationUI(api,{refresh,notice});
const rankSettings=createRankSettings({save:async(id,input)=>{const result=await api.saveRankSettings(id,input);await refresh();return result;},notice});
$('pipeline').after(rankSettings.element);
$('filter').add(new Option('★ Yıldızlılar','starred'),1);
$('filter').add(new Option('Gizlenenler','hidden'));
for(const [value,label] of [['rank_pending','Puanlanacaklar'],['rank_below_threshold','Puan eşiğinin altında'],['rank_eligible','Başvuru puanı yeterli']])$('filter').add(new Option(label,value));
const jobFilters=createJobFilters($('filter'),()=>{jobPage=1;renderBoard();});

function switchView(name,options={}){
 const global=['automations','templates'].includes(name),workspace=Boolean(automationUI?.selected)&&!global;
 document.querySelector('main>header>.actions').hidden=global;document.body.classList.remove('automation-view');document.body.classList.toggle('automation-workspace',workspace);setupUI.setEnabled(!global&&!workspace);
 for(const id of ['notifications','config','background','profile','board','agent','files','sources'])$(id).hidden=workspace||global||id!==name;
 if(automationUI){automationUI.element.hidden=!global&&!workspace;
  if(global){$('heading').textContent='Yeni çalışma alanı';if(!options.detail)automationUI.show('templates').catch(e=>notice(e.message));}
  else if(workspace){automationUI.renderShell();if(name==='config'){automationUI.element.hidden=true;$('config').hidden=false;configUI.select(null);configUI.show();}else if(name==='notifications'){automationUI.element.hidden=true;$('notifications').hidden=false;notificationsUI.show(null);}else{automationUI.showPane(name);if(name==='agent')$('agent').hidden=false;}}
 }
 if(!workspace){document.querySelector('[data-view=profile] span').textContent='Aday profili';if(name==='notifications')notificationsUI.show(candidate);if(name==='config')configUI.show();}
 localStorage.setItem('selected-view',name);document.querySelectorAll('aside nav button').forEach(b=>b.classList.toggle('selected',b.dataset.view===name));
}

function settingsOptions(saved){const current=catalog.find(a=>a.id===$('provider').value);if(!current)return;$('agent-settings-form').elements.network.disabled=current.id!=='codex';for(const [key,list]of [['model',current.models],['permission',current.permissions],['reasoning',current.reasoning]]){$(key).replaceChildren(...list.map(value=>new Option(value,value)));$(key).value=list.includes(saved?.[key])?saved[key]:'default';}}
function chromeProfileOptions(selected=snapshot?.profile?.chromeProfile){
 const select=$('agent-settings-form').elements.chromeProfile;
 select.replaceChildren(new Option('Profil belirtme',''),...chromeProfiles.map(p=>new Option(`${p.name} — ${p.directory}`,p.directory)));
 if(selected&&!chromeProfiles.some(p=>p.directory===selected.directory))select.add(new Option(`${selected.name} — ${selected.directory} (bulunamadı)`,selected.directory));
 select.value=selected?.directory??'';
 chromeProfileVisibility();
}
function chromeProfileVisibility(){
 $('chrome-profile-field').hidden=!['existing','jev'].includes($('agent-settings-form').elements.browserMode.value);
 $('chrome-profile-hint').textContent=chromeProfilesError||(chromeProfiles.length?($('agent-settings-form').elements.browserMode.value==='jev'?'Jev mevcut girişini kullanır; ilanları tek Jobloop penceresinde sekmeler olarak açar.':'Seçimin agent’a talimat olarak iletilir.'):'Chrome profili bulunamadı.');
}
function fillAgentSettings(profile,id){
 const changedOwner=agentSettingsOwner!==id;agentSettingsOwner=id;
 const p=profile??{},key=JSON.stringify([id,p.agentSettings,p.browserMode,p.chromeProfile]);if(agentSettingsSignature===key)return;agentSettingsSignature=key;
 const form=$('agent-settings-form'),modes=workspaceAgent?.workspace.id===id?workspaceAgent.capabilities.browserModes:['existing','separate','jev'];
 for(const option of form.elements.browserMode.options)option.disabled=!modes.includes(option.value);
 form.elements.browserMode.value=p.browserMode??'existing';chromeProfileOptions(p.chromeProfile);$('agent-settings').classList.toggle('is-off',!id);if(!id)$('agent-settings-status').textContent='Önce bir çalışma alanı seç';else if(changedOwner||$('agent-settings-status').textContent==='Önce bir çalışma alanı seç')$('agent-settings-status').textContent='Ayarlar kaydedilir; sonraki başlatmada uygulanır';
 $('provider').value=p.agentSettings?.provider??'codex';settingsOptions(p.agentSettings);form.elements.network.value=p.agentSettings?.network==null?'inherit':String(p.agentSettings.network);form.elements.contextRestartPercent.value=p.agentSettings?.contextRestartPercent??0;form.elements.contextCompactPercent.value=p.agentSettings?.contextCompactPercent??80;
}
let agentSettingsOwner=null;
function syncWorkspaceAgent(value){
 if(!value){workspaceAgent=null;return;}
 const id=value.automation.id;if(automationUI?.selected!==id)return;
 const next={...value,capabilities:{...value.capabilities,canStart:value.capabilities.canStart&&!automationUI.dirty,canRestart:value.capabilities.canRestart&&!automationUI.dirty}};workspaceAgent=next;
 instructionsUI.select(id);terminals.update(id,next);activities.update(next,true);fillAgentSettings(next.workspace,id);renderContext(next);
}
function fillProfile(){
 if(automationUI?.selected){if(workspaceAgent)fillAgentSettings(workspaceAgent.workspace,workspaceAgent.workspace.id);return;}
 if(snapshot?.campaign){$('campaign-target').value=snapshot.campaign.target;$('campaign-interval').value=snapshot.campaign.intervalMinutes;}
 const p=snapshot?.profile??{};for(const key of ['name','preferences','facts','authorization'])$('profile-form').elements[key].value=p[key]??(key==='authorization'?'prepare':'');fillAgentSettings(snapshot?.workspace,candidate);let extra=$('job-template-fields');if(!extra){extra=element('div');extra.id='job-template-fields';$('profile-form').append(extra);}templateFields(extra,snapshot?.definition?.fields??newJobDefinition?.fields??[],p.criteria??{});
 $('cv-name').textContent=p.cvPath?p.cvPath.split(/[\\/]/).pop():'CV eklenmedi';$('cv-name').dataset.empty=String(!p.cvPath);$('cv').textContent=p.cvPath?'CV değiştir':'CV seç';
}

function renderContext(value){
 const usage=value?.active?.contextUsage,threshold=value?.workspace.agentSettings.contextRestartPercent??0,compactThreshold=value?.workspace.agentSettings.contextCompactPercent??80,compact=value?.active?.compaction;
 $('context-compact-status').textContent=({sending:'/compact gönderiliyor…',submitted:'/compact gönderildi; sağlayıcıdan compaction bekleniyor.',running_command:'Sağlayıcı /compact komutunu işliyor…',verified:'Compaction tamamlandı.',compacting:'Context sıkıştırılıyor…',awaiting_usage:'Compaction turu bitti; yeni context ölçümü bekleniyor.',completed:'Context kullanımı eşik altına indi.',waiting:'Terminalin komut almaya hazır olması bekleniyor.',unconfirmed:'Compaction doğrulanamadı. '+(compact?.error??'')})[compact?.state]??(compactThreshold?`Otomatik compaction: %${compactThreshold}.`:'Otomatik compaction kapalı.');
 $('context-usage-status').textContent=!threshold&&!compactThreshold?'Otomatik context yönetimi kapalı.':!value?.active?'Sonraki oturumda context izlenecek.':usage?.percent==null?'Context yüzdesi bekleniyor.':`Context kullanımı: %${usage.percent.toLocaleString('tr-TR',{maximumFractionDigits:1})}.${threshold>0&&usage.peakPercent>=threshold?' Eşik aşıldı; görev tamamlanınca yenilenecek.':''}`;
}
function controls(){
 if(automationUI?.selected){automationUI.renderShell();return;}
 renderChromeStatus();renderQuestionBadge();renderActivity();renderCampaignLimit();
 renderContext(snapshot);
 const active=campaignControlsActive();
 $('start').hidden=active;$('stop').hidden=!active;
 $('start').textContent=['paused','stopped'].includes(snapshot?.campaign?.status)?'Devam et':'Agent’ı başlat';$('agent-state').dataset.active=String(active);
 $('start').disabled=busy||!snapshot?.profile.cvPath;$('stop').disabled=busy;
 $('restart-agent').hidden=false;$('stop').textContent='Durdur';$('restart-agent').disabled=busy||!snapshot?.profile.cvPath||Boolean(browserWaitView(snapshot)?.starting);
 $('improve-profile').disabled=busy||!candidate;
 $('campaign-target').disabled=busy||active;$('campaign-interval').disabled=busy||active;$('candidates').disabled=busy;$('new').disabled=busy;$('rename-workspace').disabled=busy||!candidate;$('delete-workspace').disabled=busy||!candidate;
}
let refreshVersion=0;
async function selectTerminal(id){instructionsUI.select(id);terminals.update(id,id?snapshot:null);}
async function refresh(){const version=++refreshVersion;const workspaces=await api.workspaces();const candidates=workspaces.filter(w=>w.kind==='jobs'),allWorkspaces=workspaces.filter(w=>w.kind==='web');if(version!==refreshVersion)return;$('candidates').replaceChildren(new Option('Çalışma alanı seç',''),...candidates.map(p=>new Option(p.title,p.id)),...allWorkspaces.map(a=>new Option(a.title,'automation:'+a.id)));if(automationUI?.selected){$('candidates').value='automation:'+automationUI.selected;await automationUI.refresh();return;}if(candidate&&!candidates.some(p=>p.id===candidate))candidate=null;if(!candidate&&!newCandidate&&candidates.length)candidate=candidates[0].id;$('candidates').value=candidate??'';if(candidate)localStorage.setItem('selected-candidate',candidate);const nextSnapshot=candidate?await api.workspaceSnapshot(candidate):null;if(version!==refreshVersion)return;snapshot=nextSnapshot;for(const active of [snapshot?.active,...(snapshot?.workers??[]).map(w=>w.active)])if(active&&observedStates.has(active.sessionId))active.state=observedStates.get(active.sessionId);accountUI?.update(candidate,snapshot?.accountCredentials);$('agent-state').textContent=snapshot?.active?.state??snapshot?.workers?.find(w=>w.active)?.active?.state??(snapshot?.campaign?.status==='running'?'Bekliyor':'Agent kapalı');if(snapshot?.active&&!snapshot.active.state)snapshot.active.state=observedStates.get(snapshot.active.sessionId);running=Boolean(snapshot?.workers?.some(w=>w.active)||snapshot?.active);$('heading').textContent=snapshot?`${snapshot.profile.name.split(' ')[0]}, sıradaki fırsatın.`:'Bir sonraki adımın.';backgroundUI.select(candidate);configUI.select(candidate);notificationsUI.select(candidate);await selectTerminal(candidate);controls();renderBoard();renderSources();renderDocuments();renderActivity(true);setupUI.update(snapshot,catalog);}
function documentActions(doc){
 const actions=element('div','actions'),id=candidate,open=element('button','quiet','Aç ↗');open.onclick=attempt(()=>api.openDocument(id,doc.path));actions.append(open);
 if(doc.preview){const preview=element('button','quiet','Önizle');preview.onclick=attempt(async()=>{const content=await api.readDocument(id,doc.path);if(id!==candidate)return;$('preview-name').textContent=doc.name;$('preview-content').textContent=content;$('document-preview').showModal();});actions.prepend(preview);}return actions;
}
function renderDocuments(){
 $('document-list').replaceChildren();
 for(const doc of snapshot?.documents??[]){const row=element('div','document-row'),info=element('div');info.append(element('strong','',doc.name),element('small','',`${doc.path} · ${new Date(doc.updatedAt).toLocaleString('tr-TR')} · ${Math.ceil(doc.size/1024)} KB`));row.append(info,documentActions(doc));$('document-list').append(row);}
 if(!snapshot?.documents?.length)$('document-list').append(element('p','empty','Agent belge oluşturduğunda burada görünecek.'));
 renderJobDocuments();
}
const modeLabels={find_only:'Sadece bul',prepare:'Hazırla',auto:'Otomatik gönder'};
let sourceModeSaving=false;
const sourceModes=element('div','source-bulk-mode');
sourceModes.setAttribute('role','group');sourceModes.setAttribute('aria-label','Tüm kaynakların başvuru modu');
sourceModes.innerHTML='<span>Tüm kaynaklar</span><button type="button" class="quiet" data-mode="auto" aria-pressed="false">Otomatik gönder</button><button type="button" class="quiet" data-mode="find_only" aria-pressed="false">Sadece bul</button><small role="status"></small>';
sourcesView.querySelector('.sources-head').after(sourceModes);
for(const button of sourceModes.querySelectorAll('button'))button.onclick=attempt(async()=>{
  if(!candidate||!snapshot?.sources.length||sourceModeSaving)return;
  const owner=candidate,mode=button.dataset.mode;sourceModeSaving=true;renderSources();
  try{
    await api.saveSourcesApplyMode(owner,mode);
    if(candidate===owner){
      const editor=$('source-rows').querySelector('.source-editor');if(editor)editor.elements.applyMode.value=mode;
      await refresh();notice(`Tüm kaynaklar “${modeLabels[mode]}” olarak ayarlandı.`);
    }
  }finally{sourceModeSaving=false;renderSources();}
});
function sourceTime(value,empty='Sırada'){if(!value)return empty;return new Date(value).toLocaleString('tr-TR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}
function relativeTime(value,{past=false,now=Date.now()}={}){const at=new Date(value).getTime();if(!Number.isFinite(at))return null;const minutes=Math.round(Math.abs(now-at)/60000);const span=minutes<1?'az önce':minutes<60?`${minutes} dk`:minutes<1440?`${Math.round(minutes/60)} sa`:`${Math.round(minutes/1440)} gün`;if(minutes<1)return past?'az önce':'şimdi';return past?`${span} önce`:`${span} sonra`;}
function sourceTone(source,result){if(result.scanning)return'scanning';if(!source.enabled)return'off';if(!source.lastRunAt)return'waiting';return source.lastFound?'found':'none';}
let openSourceId=null;
let sourceTabsLoading=false;
async function refreshSourceTabs(){
  if(sourceTabsLoading||!candidate||!snapshot)return;
  const id=candidate,current=snapshot;sourceTabsLoading=true;
  try{
    const tabs=await api.sourceTabs(id);
    if(candidate===id&&snapshot===current&&JSON.stringify(snapshot.sourceTabs)!==JSON.stringify(tabs)){snapshot.sourceTabs=tabs;renderSources();}
  }finally{sourceTabsLoading=false;}
}
setInterval(()=>{if(!sourcesView.hidden)refreshSourceTabs().catch(()=>{});},3000);
function sourceEditor(source){
  const form=element('form','source-editor');form.dataset.sourceId=source.id;
  form.innerHTML=`<label>Kaynak adı<input name="name" required maxlength="120"></label><label>Başlangıç adresi<input name="url" type="url" disabled></label><label class="source-query">Arama kapsamı<textarea name="query" required maxlength="2000"></textarea></label><div class="source-editor-foot"><label>Tarama aralığı<input name="intervalMinutes" type="number" min="1" max="10080" required></label><label>Başvuru modu<select name="applyMode"></select></label><button class="quiet source-remove" type="button">Kaynağı kaldır</button><button class="quiet" type="button" data-cancel>Vazgeç</button><button class="primary" type="submit">Kaydet</button></div>`;
  const f=form.elements;for(const [value,label] of Object.entries(modeLabels))f.applyMode.append(new Option(label,value));
  f.name.value=source.name;f.url.value=source.url;f.query.value=source.query;f.intervalMinutes.value=String(source.intervalMinutes);f.applyMode.value=source.applyMode;
  form.querySelector('[data-cancel]').onclick=()=>{openSourceId=null;renderSources();};
  form.querySelector('.source-remove').onclick=attempt(async()=>{if(!confirm(`${source.name} kaynağı kaldırılsın mı?`))return;await api.deleteSource(candidate,source.id);openSourceId=null;notice(`${source.name} kaldırıldı.`);await refresh();});
  form.onsubmit=attempt(async event=>{event.preventDefault();const submit=form.querySelector('[type=submit]');submit.disabled=true;try{await api.saveSource(candidate,{...source,name:f.name.value,query:f.query.value,intervalMinutes:Number(f.intervalMinutes.value),applyMode:f.applyMode.value});openSourceId=null;notice(`${f.name.value} kaydedildi.`);await refresh();}finally{submit.disabled=false;}});
  return form;
}
function renderSources(){
  const body=$('source-rows');const draft=body.querySelector('.source-editor');const kept=draft&&draft.dataset.sourceId===openSourceId?Object.fromEntries(new FormData(draft)):null;body.replaceChildren();
  const sources=snapshot?.sources??[],now=Date.now();
  sourceModes.setAttribute('aria-busy',String(sourceModeSaving));
  sourceModes.querySelector('[role=status]').textContent=sourceModeSaving?'Kaydediliyor…':'';
  for(const button of sourceModes.querySelectorAll('button')){button.disabled=sourceModeSaving||!candidate||!sources.length;button.setAttribute('aria-pressed',String(sources.length>0&&sources.every(source=>source.applyMode===button.dataset.mode)));}
  body.inert=sourceModeSaving;$('source-add').inert=sourceModeSaving;$('source-add-toggle').disabled=sourceModeSaving||!candidate;
  for(const source of sources){
    const result=sourceResultView(source,snapshot?.campaign),tone=sourceTone(source,result),open=openSourceId===source.id;
    const row=element('li','source-row');row.dataset.sourceId=source.id;row.dataset.tone=tone;row.dataset.open=String(open);
    const enabled=element('input','switch');enabled.type='checkbox';enabled.checked=source.enabled;enabled.setAttribute('aria-label',`${source.name} aktif`);enabled.onchange=attempt(async()=>{enabled.disabled=true;try{await api.saveSource(candidate,{...source,enabled:enabled.checked});await refresh();}finally{enabled.disabled=false;}});
    const main=element('div','source-main'),name=element('div','source-name',source.name),url=element('button','source-url',source.url.replace(/^https?:\/\/(www\.)?/,'').replace(/\/$/,''));url.type='button';url.title=source.url;url.onclick=attempt(()=>api.openLink(source.url));name.append(url);const scope=element('p','source-scope',source.query);scope.title=source.query;main.append(name,scope);main.append(element('small','source-method',({tool:'Kaynağa özel araç',browser:'Tarayıcı',free:'Serbest arama'})[source.searchMethod??'free']));
    const plan=element('div','source-plan');plan.append(element('b','',`Her ${source.intervalMinutes} dk`),document.createTextNode(modeLabels[source.applyMode]??source.applyMode));
    const status=element('div','source-status');status.append(element('b','',result.title));if(source.lastRunAt||result.scanning)status.append(element('small','',result.detail));
    const timing=element('div','source-timing');const last=source.lastRunAt?`Son tarama ${relativeTime(source.lastRunAt,{past:true,now})}`:'Henüz taranmadı';const next=!source.enabled?'Kapalı':result.scanning?'Şu anda taranıyor':source.nextRunAt&&new Date(source.nextRunAt).getTime()>now?`Sonraki tarama ${relativeTime(source.nextRunAt,{now})}`:'Sıradaki tarama';timing.append(element('b','',next),document.createTextNode(last));if(source.lastRunAt)timing.title=`Son tarama ${sourceTime(source.lastRunAt)}`;
    const edit=element('button','quiet source-edit',open?'Kapat':'Düzenle');edit.type='button';edit.setAttribute('aria-expanded',String(open));edit.setAttribute('aria-label',`${source.name} kaynağını ${open?'kapat':'düzenle'}`);edit.onclick=()=>{openSourceId=open?null:source.id;renderSources();if(!open)body.querySelector(`.source-editor[data-source-id="${source.id}"] input[name=name]`)?.focus();};
    const actions=element('div','source-actions'),owner=candidate;
    if(snapshot?.sourceTabs?.[source.id]){
      const tab=element('button','quiet source-open-tab','Sekmeye git ↗');tab.type='button';tab.title='Açık arama sekmesini öne getir';tab.setAttribute('aria-label',`${source.name} sekmesine git`);
      tab.onclick=attempt(async()=>{tab.disabled=true;try{await api.openSourceTab(owner,source.id);}finally{await refreshSourceTabs();tab.disabled=false;}});actions.append(tab);
    }
    const skill=element('button','quiet','Skill ve araçlar');skill.type='button';skill.onclick=attempt(()=>openSourcePanel(api,owner,source,refresh));actions.append(skill,edit);row.append(enabled,main,plan,status,timing,actions);
    if(open){const editor=sourceEditor(source);if(kept){for(const [key,value] of Object.entries(kept))if(editor.elements[key]&&!editor.elements[key].disabled)editor.elements[key].value=value;}row.append(editor);}
    body.append(row);
  }
  if(!sources.length){const empty=element('li','source-empty');empty.append(element('strong','','Henüz kaynak yok'),document.createTextNode('Agent’ın hangi sitelerde, ne sıklıkla ilan arayacağını burada belirlersin.'));const add=element('button','primary','Kaynak ekle');add.type='button';add.onclick=()=>openSourceAdd(true);empty.append(element('br'),add);body.append(empty);}
  const on=sources.filter(s=>s.enabled),off=sources.length-on.length,running=snapshot?.campaign?.status==='running';const upcoming=running?on.map(s=>({s,at:new Date(s.nextRunAt||0).getTime()})).sort((a,b)=>a.at-b.at)[0]:null;
  const summary=$('sources-summary');summary.replaceChildren();
  if(!sources.length)summary.textContent='Agent yalnızca etkin kaynakları, belirlediğin aralıklarla tarar.';
  else{summary.append(element('b','',`${on.length} etkin kaynak`),document.createTextNode(off?`, ${off} kapalı. `:'. '));if(upcoming){const scanningNow=sources.find(s=>sourceResultView(s,snapshot?.campaign).scanning);summary.append(document.createTextNode(scanningNow?`Şu anda taranıyor: ${scanningNow.name}.`:upcoming.at>now?`Sıradaki tarama ${relativeTime(upcoming.at,{now})}: ${upcoming.s.name}.`:`Sırada: ${upcoming.s.name}.`));}else summary.append(document.createTextNode(on.length?'Agent başlayınca etkin kaynaklar sırayla taranır.':'Taramanın başlaması için en az bir kaynağı aç.'));}
  const policy=snapshot?.profile?.applicationPolicy??{};const form=$('application-policy');form.elements.autoFillKnown.checked=policy.autoFillKnown!==false;form.elements.acceptPrivacy.checked=Boolean(policy.acceptPrivacy);form.elements.groupRecruitmentConsent.checked=Boolean(policy.groupRecruitmentConsent);form.elements.demographic.value=policy.demographic??'prefer_not_to_say';form.elements.marketing.value=policy.marketing??'decline';form.elements.unknownImportant.value=policy.unknownImportant??'ask';form.elements.legalAgreements.value=policy.legalAgreements??'ask';
}
function openSourceAdd(show){const form=$('source-add');form.hidden=!show;$('source-add-toggle').setAttribute('aria-expanded',String(show));$('source-add-toggle').hidden=show;if(show)form.elements.name.focus();}
$('source-add-toggle').onclick=()=>openSourceAdd($('source-add').hidden);
$('source-add-cancel').onclick=()=>{$('source-add').reset();openSourceAdd(false);};
$('source-add').onsubmit=attempt(async event=>{event.preventDefault();const form=event.currentTarget,fields=Object.fromEntries(new FormData(form)),submit=form.querySelector('[type=submit]');submit.disabled=true;try{await api.saveSource(candidate,{...fields,kind:'custom',enabled:true,intervalMinutes:Number(fields.intervalMinutes)});}finally{submit.disabled=false;}form.reset();form.elements.intervalMinutes.value='30';form.elements.applyMode.value='auto';openSourceAdd(false);await refresh();notice('Kaynak eklendi.');});
$('application-policy').onsubmit=attempt(async event=>{event.preventDefault();const form=event.currentTarget;await api.saveApplicationPolicy(candidate,{autoFillKnown:form.elements.autoFillKnown.checked,acceptPrivacy:form.elements.acceptPrivacy.checked,groupRecruitmentConsent:form.elements.groupRecruitmentConsent.checked,demographic:form.elements.demographic.value,marketing:form.elements.marketing.value,unknownImportant:form.elements.unknownImportant.value,legalAgreements:form.elements.legalAgreements.value});await refresh();notice('Otomatik cevap kuralları kaydedildi.');});
function renderJobDocuments(){
 backgroundUI.renderJobSignals();
 for(const host of $('jobs').querySelectorAll('[data-job-documents]')){
  const docs=(snapshot?.documents??[]).filter(doc=>doc.path.split(/[\\/]/).slice(0,-1).some(part=>part===host.dataset.jobDocuments||part.endsWith('-'+host.dataset.jobDocuments)));
  const opened=host.querySelector('details')?.open;host.replaceChildren();if(!docs.length)continue;
  const detail=element('details','job-documents');detail.open=opened??false;detail.append(element('summary','',`Dosyalar (${docs.length})`));
  for(const doc of docs){const row=element('div','job-document');row.append(element('span','',doc.name),documentActions(doc));detail.append(row);}host.append(detail);
 }
}
$('close-preview').onclick=()=>{$('document-preview').close();};
setInterval(async()=>{const id=candidate;if(!id||automationUI?.selected)return;try{const docs=await api.documents(id);if(candidate===id&&snapshot&&JSON.stringify(snapshot.documents)!==JSON.stringify(docs)){snapshot.documents=docs;renderDocuments();}}catch(e){notice(e.message);}},5000);
const activities=activityPanels($('now-panel'),{openLink:url=>api.openLink(url),notice});
function renderAgentStatus(){
 if(automationUI?.selected){automationUI.renderShell();return;}
 const active=snapshot?.active?.candidateId===candidate?snapshot.active:snapshot?.workers?.find(w=>w.active)?.active??null,state=active?.state;
 let label='Kapalı',tone='neutral';
 if(active){label=({Working:'Çalışıyor',Compacting:'Özetliyor',AwaitingInput:'Onay bekliyor',Idle:'Hazır',Failed:'Hata',Interrupted:'Kesildi'})[state]??'Bağlanıyor';tone=['Working','Compacting'].includes(state)?'active':['AwaitingInput','Failed','Interrupted'].includes(state)?'waiting':'neutral';if(state==='Idle'&&visibleQuestions().length>0){label='Yanıt bekliyor';tone='waiting';}}
 if(!active&&snapshot?.campaign?.status==='running'){label='Bekliyor';tone='waiting';}
 if(!['Working','Compacting'].includes(state)&&['paused','stopped','complete'].includes(snapshot?.campaign?.status)){label={paused:'Duraklatıldı',stopped:'Durduruldu',complete:'Hedef tamamlandı'}[snapshot.campaign.status];tone=snapshot.campaign.status==='paused'?'waiting':'neutral';}
 if(browserWaitView(snapshot)){label='Chrome bekliyor';tone='waiting';}
 const liveWorkers=snapshot?.workers?.filter(w=>w.active).length??0;if(liveWorkers>1)label=`${liveWorkers} worker`;
 const badge=$('agent-nav-status');badge.textContent=label;badge.dataset.tone=tone;badge.parentElement.setAttribute('aria-label',`Agent, ${label}`);badge.parentElement.title=`Agent: ${label}${snapshot?.campaign?.note?` — ${snapshot.campaign.note}`:''}`;
}
function renderActivity(history=false){
  renderAgentStatus();
  activities.update(automationUI?.selected?workspaceAgent:snapshot,history);
}
setInterval(()=>{renderActivity();},1000);
let questionRenderKey='';
const pendingQuestionActions=new Map();
function questionActionPending(owner,q){return [...pendingQuestionActions.values()].some(action=>action.owner===owner&&(action.questionId===q.id||action.jobId&&action.jobId===q.jobId));}
function visibleQuestions(){return pendingQuestions(snapshot).filter(q=>!questionActionPending(candidate,q));}
function renderQuestionBadge(){const count=visibleQuestions().length,badge=$('question-badge'),button=badge.parentElement;badge.hidden=count===0;badge.textContent=String(count);button.setAttribute('aria-label',count?`Başvurular, ${count} yanıt bekleyen soru`:'Başvurular');button.title=count?`${count} soru yanıtını bekliyor`:'Başvurular';}
async function runQuestionAction(owner,q,perform,{wholeJob=false,message}={}){
 if(questionActionPending(owner,q))return;
 const key=`${owner}:${q.id}`;pendingQuestionActions.set(key,{owner,questionId:q.id,jobId:wholeJob?q.jobId:null});
 renderQuestions();renderQuestionBadge();if(candidate===owner)notice('');
 try{const result=await perform();await refresh();if(candidate===owner)notice(result?.message??message??'');return result;}
 catch(error){if(candidate===owner)notice(error.message);throw error;}
 finally{pendingQuestionActions.delete(key);renderQuestions();renderQuestionBadge();}
}
function renderPipeline(campaign,jobs){
  const status=$('campaign-status');status.replaceChildren();$('pipeline').dataset.status=campaign?.status??'off';
  if(!campaign)status.append(element('b','','Kampanya kapalı'),document.createTextNode(snapshot?' Agent’ı başlatınca kaynaklar taranır ve başvurular buraya düşer.':''));
  else{const title={running:['Working','Compacting'].includes(snapshot.active?.state)?'Çalışıyor':'Bekliyor',paused:'Duraklatıldı',stopped:'Durduruldu',complete:'Hedef tamamlandı'}[campaign.status]??campaign.status;const next=campaign.status==='running'&&!campaign.task&&campaign.nextSearchAt>Date.now()?` Sonraki tarama ${relativeTime(campaign.nextSearchAt)}.`:'';status.append(element('b','',title),document.createTextNode(` ${campaign.note}${/[.!?]$/.test(campaign.note)?'':'.'}${next}`));}
  const count=keys=>jobs.filter(j=>keys.includes(jobDisplayStatus(snapshot,j))).length,groups=[['submitted',count(['submitted']),'gönderildi'],['working',count(['working','prepared','submitting']),'devam ediyor'],['waiting',count(['blocked','uncertain']),'bekliyor'],['found',jobs.filter(j=>jobDisplayStatus(snapshot,j)==='queued'||j.status==='found'&&j.queueState?.eligible).length,'başvuru sırasında'],['rank_pending',jobs.filter(j=>j.status==='found'&&j.rankDecision?.state==='pending').length,'puanlanacak'],['held',jobs.filter(j=>j.status==='found'&&j.rankDecision?.state!=='pending'&&!j.queueState?.eligible).length,'listede bekliyor']],skipped=count(['skipped']);
  const target=campaign?.target??(Number($('campaign-target').value)||0),scale=Math.max(target,jobs.length-skipped,1);
  const bar=element('div','pipeline-bar');bar.setAttribute('role','img');bar.setAttribute('aria-label',`${groups[0][1]} gönderildi, hedef ${target}`);for(const [key,value] of groups){if(!value)continue;const seg=element('span');seg.dataset.key=key;seg.style.flex=`0 0 ${(value/scale*100).toFixed(2)}%`;bar.append(seg);}
  const legend=element('div','pipeline-legend');for(const [key,value,label] of groups){const item=element('span');item.dataset.key=key;item.append(element('b','',String(value)),document.createTextNode(` ${label}`));legend.append(item);}if(skipped){const item=element('span');item.dataset.key='skipped';item.append(element('b','',String(skipped)),document.createTextNode(' elendi / vazgeçildi'));legend.append(item);}
  const goal=element('span','pipeline-target',target?`${jobs.length} ilan, hedef ${target} başvuru`:`${jobs.length} ilan`);legend.append(goal);
  $('metrics').replaceChildren(bar,legend);
}
function renderQuestions(){
  const questions=visibleQuestions(),questionKey=JSON.stringify([candidate,questions,questions.map(q=>snapshot.jobs.find(j=>j.id===q.jobId)?.status)]);if(questionKey!==questionRenderKey){questionRenderKey=questionKey;$('questions').replaceChildren();for(const q of questions){const owner=candidate,card=element('div','question'),head=element('div','question-head'),title=element('div','question-title');title.append(element('strong','','Agent’ın bir sorusu var'));const job=snapshot.jobs.find(j=>j.id===q.jobId);if(job){const heading=element('h3','question-job');heading.append(element('b','',job.company),element('span','',job.role));if(job.resumeContext?.step)heading.append(element('em','question-step',job.resumeContext.step));title.append(heading);}head.append(title);card.append(head);if(q.fields)card.append(element('p','question-brief',q.question));if(job){const actions=element('div','question-link-actions');if(job.resumeContext){const tab=element('button','quiet','Sekmeye git ↗'),tabStatus=element('span','tab-status');tabStatus.setAttribute('role','status');tabStatus.hidden=true;tab.type='button';tab.onclick=attempt(async()=>{tab.disabled=true;tabStatus.hidden=true;try{const result=await api.openQuestionTab(owner,q.id);if(result?.message){tabStatus.textContent=result.message;tabStatus.hidden=false;}}catch(error){tabStatus.textContent=error.message;tabStatus.hidden=false;}finally{tab.disabled=false;}});actions.append(tab,tabStatus);}const listing=element('button','quiet','İlan bağlantısını aç ↗');listing.type='button';listing.onclick=attempt(()=>api.openLink(job.url));actions.append(listing);if(!['submitted','already_submitted','skipped'].includes(job.status)){
 const retry=element('button','quiet','Tekrar dene'),cancel=element('button','quiet danger','Başvuruyu iptal et');
 retry.type=cancel.type='button';
 retry.title='Agent başvuruyu yeniden denesin; kapanan sekmeyi kayıtlı ilandan açsın';
 cancel.title='Başvuruyu Vazgeçildi olarak kaydet ve bekleyen soruları kapat';
 retry.onclick=attempt(()=>runQuestionAction(owner,q,()=>api.recoverQuestion(owner,q.id),{wholeJob:true}));
 cancel.onclick=attempt(()=>runQuestionAction(owner,q,()=>api.setManualJobStatus(owner,job.id,'withdrawn'),{wholeJob:true,message:'Başvuru Vazgeçildi olarak kaydedildi.'}));
 actions.append(retry,cancel);
 }head.append(actions);}card.append(questionForm(owner,q,values=>runQuestionAction(owner,q,()=>api.answer(owner,q.id,values),{message:'Yanıt kaydedildi.'})));$('questions').append(card);}}
}

function renderBoard(){jobFilters.setTemplate(snapshot?.definition);preparationUI.update(candidate,snapshot);rankSettings.update(candidate,snapshot?.profile);const campaign=snapshot?.campaign,jobs=snapshot?.jobs??[];renderPipeline(campaign,jobs);renderQuestions();
  const filters=jobFilters.values,filter=filters.length===1?filters[0]:null,searchTerms=normalizeJobSearch(jobSearch.value).trim().split(/\s+/).filter(Boolean);
  const filtered=jobs.filter(j=>(j.hidden?filters.includes('hidden'):filters.some(value=>matchesJobFilter(j,value)))&&matchesJobSearch(j,searchTerms)),visible=sortJobs(filtered);
  const pinned=visible.filter(j=>applicationActivity(snapshot,j.id));
  const workerOrder=new Map((snapshot?.workers??[]).map((w,index)=>[w.campaign?.task?.jobId,index]));pinned.sort((a,b)=>(workerOrder.get(a.id)??0)-(workerOrder.get(b.id)??0));
  const pinnedIds=new Set(pinned.map(j=>j.id));visible.splice(0,visible.length,...pinned,...visible.filter(j=>!pinnedIds.has(j.id)));$('jobs').replaceChildren();
  if(!visible.length){const searching=Boolean(jobSearch.value.trim()),empty=element('div','empty');empty.append(element('strong','',searching?'Aramana uygun ilan bulunamadı.':filter==='hidden'?'Gizlenmiş başvuru yok.':filter==='starred'?'Henüz yıldızlı başvuru yok.':jobs.some(j=>j.hidden)?'Görüntülenecek başvuru yok.':'Yeni fırsatlara yer aç.'),element('span','',searching?'Farklı bir kelime dene veya aramayı temizle.':filter==='hidden'?'Gizlediğin başvuruları buradan tekrar gösterebilirsin.':filter==='starred'?'Başvuruları yıldızlamak için şirket adının yanındaki yıldıza tıkla.':jobs.some(j=>j.hidden)?'Gizlediğin başvuruları Gizlenenler filtresinde bulabilirsin.':snapshot?'Agent ilan buldukça burada görünecek. Başvuruların her adımını buradan takip edebilirsin.':'Önce aday profilini oluştur. CV, tercihler ve başvuru yetkisiyle başlayalım.'));$('jobs').append(empty);}
  if(visible.length){const columns=jobColumns(),{wrap,table,body}=recordTable([...columns,{key:'status',label:'Durum'},{key:'rank',label:'Puan'},{key:'updatedAt',label:'Son aktivite'},{key:null,label:'İşlemler'}]);for(const j of visible){const row=element('tr'),company=element('td','company-cell'),role=element('td','role-cell'),location=element('td','location-cell',j.location),status=element('td'),actionsCell=element('td','actions-cell'),actions=element('div','table-actions');const companyHeading=element('div','company-heading');companyHeading.append(jobStarControl(j),element('span','',j.company));company.append(companyHeading);actionsCell.append(actions);recordActions(actions,j,snapshot?.definition,async action=>{try{await api.workspaceTransition(candidate,j.id,action);await refresh();}catch(error){notice(error.message);}});role.append(element('strong','',j.role));const live=applicationActivity(snapshot,j.id);if(live){row.classList.add('agent-current-row');row.dataset.agentTone=live.tone;const label=element('span',`application-agent-badge ${live.tone}`,live.workerName?`${live.workerName} · ${live.label}`:live.label);role.append(label);}if(j.note){const note=element('p','job-note',j.note);note.title=j.note;role.append(note);}const detail=element('details','job-details');detail.append(element('summary','','Neden uygun'),element('p','',j.fit));if(j.resumeContext&&!['submitted','already_submitted','skipped'].includes(j.status))detail.append(element('p','note',`Kaldığı adım: ${j.resumeContext.step} · Sekme: ${j.resumeContext.tabId}`));if(j.proof)detail.append(element('pre','proof',`${j.proof.text}\n\nBelgeler: ${j.proof.documents}\n${j.proof.url}`));role.append(detail);if(j.relatedApplications?.length){const history=element('details','job-details');history.append(element('summary','',`Bağlı kayıtlar (${j.relatedApplications.length})`));for(const related of j.relatedApplications){const item=element('div'),link=element('a','',`${related.company} — ${related.role}`);link.href=related.url;link.target='_blank';link.rel='noopener noreferrer';item.append(link,element('p','note',`${related.location} · ${names[related.status]??related.status}`));if(related.note)item.append(element('p','note',related.note));if(related.proof)item.append(element('pre','proof',`${related.proof.text??''}\n${related.proof.url??''}`));if(related.resumeContext){const tab=element('button','quiet','Kayıtlı sekmeye git ↗');tab.type='button';tab.onclick=attempt(()=>api.openApplicationTab(candidate,related.id));item.append(tab);}history.append(item);}role.append(history);}const mails=element('div');mails.dataset.jobMails=j.id;role.append(mails);const documents=element('div');documents.dataset.jobDocuments=j.id;role.append(documents);if(j.workflowState)status.append(element('span','badge',recordState(j,snapshot?.definition).label));status.append(element('span',`badge ${live?(live.tone==='active'?'working':'blocked'):jobDisplayStatus(snapshot,j)==='queued'?'found':j.status}`,live?(live.tone==='active'?(live.kind==='rank'?'Puanlanıyor':'İşleniyor'):live.label):j.status==='found'?(j.preparation?.hold?preparationLabel(j.preparation):j.queueState?.label??j.rankDecision?.label??names[j.status]):jobStatusLabel(j)));const preparationAction=preparationUI.action(candidate,j);if(preparationAction)actions.append(preparationAction);actions.append(manualStatusControl(j));if(j.rank?.status==='unavailable'&&['found','blocked'].includes(j.status)){const retry=element('button','quiet',j.rankDecision?.state==='pending'?'İnceleme sırasında':'Yeniden incele');retry.disabled=j.rankDecision?.state==='pending';retry.onclick=attempt(async()=>{await api.retryJobRank(candidate,j.id);await refresh();});actions.append(retry);}const link=element('button','quiet','Aç ↗');link.title='İlanı tarayıcıda aç';link.setAttribute('aria-label',`${j.company} ilanını aç`);link.onclick=attempt(()=>api.openLink(j.url));actions.append(link,jobVisibilityControl(j));if(j.status==='found'&&j.queueState?.state==='find_only'){const settings=element('button','quiet','Kaynak ayarı');settings.onclick=()=>{openSourceId=j.sourceId;switchView('sources');renderSources();$('source-rows').querySelector(`[data-source-id="${j.sourceId}"]`)?.scrollIntoView({block:'center'});};actions.append(settings);}if(['found','blocked','prepared','uncertain'].includes(j.status)&&j.manualQueueState?.state!=='unavailable'){const owner=candidate,state=j.manualQueueState,queue=element('button','quiet',state?.state==='active'?'İşleniyor':state?.state==='queued'?(state.verificationOnly?'Doğrulama sırasında':'Öncelikli sırada'):state?.actionLabel??'Öncelikli başvur');queue.type='button';queue.disabled=['queued','active'].includes(state?.state);queue.title=state?.message??'Bu ilana başvur: kaynak modu, profil yetkisi, puan eşiği ve başvuru hedefini bu ilan için geçer';queue.setAttribute('aria-label',state?.verificationOnly?`${j.company} başvurusunun sonucunu öncelikli doğrula`:`${j.company} başvurusunu sıraya al`);queue.onclick=attempt(async()=>{queue.disabled=true;try{const result=await api.queueApplication(owner,j.id);await refresh();notice(result.message);}finally{if(queue.isConnected)queue.disabled=false;}});actions.append(queue);}if(j.resumeContext){const owner=candidate,tab=element('button','quiet','Sekmeye git ↗');tab.type='button';tab.title='Başvurunun kayıtlı tarayıcı sekmesini öne getir';tab.setAttribute('aria-label',`${j.company} başvurusunun sekmesine git`);tab.onclick=attempt(async()=>{tab.disabled=true;try{await api.openApplicationTab(owner,j.id);}finally{tab.disabled=false;}});actions.append(tab);}if(['blocked','uncertain'].includes(j.status)&&!snapshot.workers?.some(w=>w.campaign?.task?.jobId===j.id)&&snapshot.active?.candidateId===candidate&&j.sessionId!==snapshot.active.sessionId){const take=element('button','quiet','Devral');take.onclick=attempt(async()=>{await api.reclaim(candidate,j.id);await refresh();});actions.append(take);}const updated=element('td','activity-cell',j.updatedAt?relativeTime(j.updatedAt,{past:true}):'—');updated.title=j.updatedAt?`Son güncelleme ${new Date(j.updatedAt).toLocaleString('tr-TR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}`:'Başvuru kaydının son güncellenme zamanı';for(const column of columns){const cell=column.key==='source'?company:column.key==='title'?role:column.key==='location'&&!j.cells?.location?location:recordCell(column,jobColumnValue(j,column.key),{openLink:url=>api.openLink(url).catch(e=>notice(e.message))});cell.dataset.column=column.key;row.append(cell);}row.append(status,jobRankCell(j,element),updated,actionsCell);body.append(row);}$('jobs').append(wrap);}
  updateJobHeaders();updateJobPagination();renderJobDocuments();
  pinnedRowObserver.disconnect();
  for(const row of $('jobs').querySelectorAll('.agent-current-row'))pinnedRowObserver.observe(row);
  updatePinnedJobOffsets();
}
function updatePinnedJobOffsets(){
  let top=0;
  for(const row of $('jobs').querySelectorAll('.agent-current-row')){
    row.style.setProperty('--job-sticky-top',`${top}px`);
    top+=row.getBoundingClientRect().height;
  }
}
function jobStarControl(job){
  const owner=candidate,starred=Boolean(job.starred),button=element('button','job-star');
  button.type='button';button.dataset.starJob=job.id;
  button.setAttribute('aria-pressed',String(starred));
  button.title=starred?'Yıldızı kaldır':'Yıldızla';
  button.setAttribute('aria-label',`${job.company} · ${job.role}: ${button.title}`);
  button.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91Z"/></svg>';
  button.onclick=attempt(async()=>{button.disabled=true;try{await api.setJobStarred(owner,job.id,!starred);await refresh();}finally{button.disabled=false;}});
  return button;
}
function jobVisibilityControl(job){
  const owner=candidate,hidden=Boolean(job.hidden),button=element('button','quiet',hidden?'Tekrar göster':'Gizle');
  button.type='button';
  button.setAttribute('aria-label',`${job.company} · ${job.role}: ${button.textContent}`);
  button.title=hidden?'Başvuruyu normal listede tekrar göster':'Listeden gizle; agent bu ilan üzerinde çalışmaya devam edebilir';
  button.onclick=attempt(async()=>{button.disabled=true;try{await api.setJobHidden(owner,job.id,!hidden);await refresh();notice(hidden?'Başvuru tekrar gösteriliyor.':'Başvuru gizlendi. Gizlenenler filtresinden tekrar gösterebilirsin.');}finally{button.disabled=false;}});
  return button;
}
function manualStatusControl(job){
  const owner=candidate,select=element('select','manual-job-status');
  select.setAttribute('aria-label',`${job.company} · ${job.role} başvuru durumu`);
  for(const [value,label] of [['','Durum değiştir…'],['manual_submitted','Manuel gönderildi'],['withdrawn','Vazgeçildi']]){const option=element('option','',label);option.value=value;option.disabled=!value;select.append(option);}
  select.value=(job.manualOutcome==='already_submitted'?'manual_submitted':job.manualOutcome)??'';
  select.disabled=false;
  select.title='Başvurunun durumunu kaydet; agent bu ilanda çalışıyorsa önce otomatik duraklatılır';
  select.onchange=attempt(async()=>{select.disabled=true;try{await api.setManualJobStatus(owner,job.id,select.value);await refresh();notice('Başvuru durumu kaydedildi.');}finally{select.disabled=false;select.value=(job.manualOutcome==='already_submitted'?'manual_submitted':job.manualOutcome)??'';}});
  return select;
}
function loadJobSort(){
  try{
    const saved=JSON.parse(localStorage.getItem('job-sort'));
    if(JOB_SORT_KEYS.includes(saved?.key)&&['asc','desc'].includes(saved?.direction))return {key:saved.key,direction:saved.direction};
  }catch{}
  return {key:'rank',direction:'desc'};
}
const jobColumns=()=>snapshot?.profile.table?.columns??[{key:'source',label:'Şirket',type:'text'},{key:'title',label:'Pozisyon',type:'text'},{key:'location',label:'Konum',type:'text'}];
const jobColumnValue=(job,key)=>key==='source'||key==='company'?job.company:key==='title'||key==='role'?job.role:job.cells?.[key]??job[key]??'';
function sortJobs(jobs){
  if(!jobSort.key)return jobs;
  const collator=new Intl.Collator('tr',{numeric:true,sensitivity:'base'}),value=job=>jobSort.key==='status'?(jobStatusLabel(job)??job.status):jobColumnValue(job,jobSort.key);
  return jobs.map((job,index)=>({job,index})).sort((a,b)=>{const result=jobSort.key==='rank'?(a.job.rank?.score??-1)-(b.job.rank?.score??-1):jobSort.key==='updatedAt'?(Date.parse(a.job.updatedAt)||0)-(Date.parse(b.job.updatedAt)||0):(['number','money'].includes(jobColumns().find(c=>c.key===jobSort.key)?.type)?Number(value(a.job))-Number(value(b.job)):collator.compare(value(a.job),value(b.job)));return result?result*(jobSort.direction==='asc'?1:-1):a.index-b.index;}).map(item=>item.job);
}
function matchesJobFilter(job,filter){
  return filter.startsWith('state:')?recordState(job,snapshot?.definition).id===filter.slice(6):filter==='all'||filter==='preparation'&&Boolean(job.preparation)||filter==='starred'&&job.starred||filter===jobDisplayStatus(snapshot,job)||filter==='queued'&&job.status==='found'&&job.queueState?.eligible||filter===job.manualOutcome||filter===`rank_${job.rankDecision?.state}`||filter==='blocked'&&job.status==='uncertain'||filter==='working'&&['prepared','submitting'].includes(job.status);
}
function normalizeJobSearch(value){return String(value??'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/ı/g,'i');}
function matchesJobSearch(job,terms){
  if(!terms.length)return true;
  const status=job.status==='found'?(job.queueState?.label??job.rankDecision?.label??names[job.status]):jobStatusLabel(job);
  const text=normalizeJobSearch([job.company,job.role,job.location,status,job.note].join(' '));
  return terms.every(term=>text.includes(term));
}
function updateJobHeaders(){
  const headers=[...$('jobs').querySelectorAll('.jobs-table th')];
  headers.forEach((header,index)=>{const key=[...jobColumns().map(c=>({source:'company',title:'role'}[c.key]??c.key)),'status','rank','updatedAt'][index];if(!key)return;const label=header.textContent,active=jobSort.key===key;header.setAttribute('aria-sort',active?(jobSort.direction==='asc'?'ascending':'descending'):'none');const button=element('button','sort-button',`${label}${active?(jobSort.direction==='asc'?' ↑':' ↓'):''}`);button.onclick=()=>{jobSort=active?{key,direction:jobSort.direction==='asc'?'desc':'asc'}:{key,direction:['updatedAt','rank'].includes(key)?'desc':'asc'};localStorage.setItem('job-sort',JSON.stringify(jobSort));jobPage=1;renderBoard();};header.replaceChildren(button);});
}
function updateJobPagination(){
  const wrap=$('jobs').querySelector('.jobs-table-wrap');if(!wrap)return;
  const allRows=[...wrap.querySelectorAll('tbody tr')],rows=allRows.filter(row=>!row.classList.contains('agent-current-row')),pages=Math.max(1,Math.ceil(rows.length/JOBS_PER_PAGE));jobPage=Math.min(Math.max(jobPage,1),pages);
  allRows.filter(row=>row.classList.contains('agent-current-row')).forEach(row=>{row.hidden=false;});
  rows.forEach((row,index)=>{row.hidden=index<(jobPage-1)*JOBS_PER_PAGE||index>=jobPage*JOBS_PER_PAGE;});
  $('jobs').querySelector('.jobs-pagination')?.remove();
  const pagination=element('nav','jobs-pagination');pagination.setAttribute('aria-label','İlan sayfaları');
  const count=element('span','pagination-count',`${allRows.length} ilan${allRows.length>rows.length?` · ${allRows.length-rows.length} aktif iş üstte sabit`:''} · ${jobPage}/${pages}. sayfa`),previous=element('button','quiet','← Önceki'),next=element('button','quiet','Sonraki →');
  previous.disabled=jobPage===1;previous.onclick=()=>{jobPage--;updateJobPagination();};
  const pageButtons=element('div','pagination-pages');
  const first=pages<=7||jobPage<=4?1:jobPage>=pages-3?pages-4:jobPage-1;
  const last=pages<=7||jobPage>=pages-3?pages:jobPage<=4?5:jobPage+1;
  const pageNumbers=[...new Set([1,...Array.from({length:last-first+1},(_,index)=>first+index),pages])];
  let previousPage=0;
  for(const page of pageNumbers){
    if(previousPage&&page>previousPage+1){const gap=element('span','pagination-gap','…');gap.setAttribute('aria-hidden','true');pageButtons.append(gap);}
    const button=element('button',page===jobPage?'current':'',String(page));button.setAttribute('aria-label',`${page}. sayfa`);if(page===jobPage)button.setAttribute('aria-current','page');button.onclick=()=>{jobPage=page;updateJobPagination();};pageButtons.append(button);
    previousPage=page;
  }
  next.disabled=jobPage===pages;next.onclick=()=>{jobPage++;updateJobPagination();};
  if(pages>1)pagination.append(count,previous,pageButtons,next);else pagination.append(count);wrap.before(pagination);
}
$('profile-form').onsubmit=attempt(async e=>{e.preventDefault();const fields=Object.fromEntries(new FormData(e.target));fields.templateId=snapshot?.profile.templateId??newJobTemplate;fields.criteria=templateValues(e.target,snapshot?.definition?.fields??newJobDefinition?.fields??[]);if(candidate)fields.id=candidate;const p=candidate?await api.saveProfile(fields):await api.workspaceCreate(fields.templateId,fields);candidate=p.id;await refresh();fillProfile();notice('Profil kaydedildi.');});
$('improve-profile').onclick=attempt(async()=>{
 if(busy||!candidate||!$('profile-form').reportValidity())return;
 const owner=candidate,fields=Object.fromEntries(new FormData($('profile-form')));
 busy=true;controls();notice('');
 try{await settingsQueue;await api.saveProfile({...fields,id:owner});await api.improveProfile(owner);}
 finally{busy=false;await refresh();fillProfile();}
});
$('cv').onclick=attempt(async()=>{if(!candidate)throw Error('Önce profili kaydet');await api.pickDocument(candidate,{purpose:'cv'});await refresh();fillProfile();});
async function newJobWorkspace(template){newJobTemplate=template?.id??'job-search';newJobDefinition=template??null;automationUI?.deselect();busy=true;controls();try{newCandidate=true;candidate=null;snapshot=null;running=false;await selectTerminal(null);setupUI.reset();renderDocuments();$('document-preview').close();jobPage=1;$('candidates').value='';fillProfile();renderActivity(true);switchView('profile');}finally{busy=false;controls();}}
$('new').textContent='Yeni çalışma alanı';$('new').onclick=attempt(async()=>{if(automationUI)await automationUI.createBlank();else await newJobWorkspace();});
$('candidates').onchange=attempt(async()=>{
 const next=$('candidates').value||null;if(next?.startsWith('automation:')){await automationUI.select(next.slice(11));return;}if(next===candidate&&!automationUI?.selected)return;automationUI?.deselect();
 if(!next){$('new').click();return;}
 busy=true;controls();
 try{
  
  candidate=next;newCandidate=false;$('document-preview').close();jobPage=1;
  $('agent-state').textContent='Agent kapalı';
 }finally{busy=false;await refresh();fillProfile();switchView('board');}
});
async function startFromControls(fresh=false){
 busy=true;controls();notice('');
 try{
  await settingsQueue;
  const options={target:Number($('campaign-target').value),intervalMinutes:Number($('campaign-interval').value)};
  const submitted=(snapshot?.jobs??[]).filter(j=>jobDisplayStatus(snapshot,j)==='submitted').length,task=snapshot?.campaign?.task;
  if(submitted>=options.target&&(!task||task.report)){renderCampaignLimit();limitWarning.scrollIntoView({block:'center'});limitWarning.focus();}
  if(fresh)await api.workspaceRestart(candidate,options);else await api.workspaceStart(candidate,options);
  requestedLimit=null;
  await refresh();
  notice(snapshot?.active?(fresh?'Yeni konuşma başlatılıyor. Profil ve başvurular korundu.':'Agent başlatılıyor.'):(snapshot?.campaign?.note??'Agent’ın başlaması bekleniyor.'));
  switchView('agent');
  if(browserWaitView(snapshot)){notice('');chromeApproval.show();}
 }catch(error){
  if(!error.message.includes('Başvuru hedefine ulaşıldı:'))throw error;
  requestedLimit={candidateId:candidate,target:Number($('campaign-target').value)};
  renderCampaignLimit();notice('');limitWarning.scrollIntoView({block:'center'});limitWarning.focus();
 }finally{busy=false;await refresh();}
}
$('start').onclick=attempt(()=>automationUI?.selected?automationUI.start():startFromControls());
$('restart-agent').onclick=attempt(()=>automationUI?.selected?automationUI.restart():startFromControls(true));
$('stop').onclick=attempt(async()=>{if(automationUI?.selected)return automationUI.stop();busy=true;controls();try{await api.workspaceStop(candidate);$('agent-state').textContent='Agent durduruldu';}finally{busy=false;await refresh();}});
jobSearch.oninput=()=>{jobPage=1;renderBoard();};
for(const b of document.querySelectorAll('aside nav button[data-view]'))b.onclick=()=>{switchView(b.dataset.view);if(b.dataset.view==='profile')fillProfile();};
api.onChange(event=>{if(event.candidateId&&event.candidateId!==(automationUI?.selected??candidate))return;refresh().catch(e=>notice(e.message));});
api.onAgentEvent(event=>{if(event.candidateId&&event.candidateId!==(automationUI?.selected??candidate))return;terminals.event(event);if(automationUI?.selected){if(['state','engine_exit','eof'].includes(event.event))refresh().catch(e=>notice(e.message));else if(event.event==='error')notice(event.error);return;}if(event.event==='state'){const state=event.state.replace(/^Some\((.*)\)$/,'$1');if(event.sessionId)observedStates.set(event.sessionId,state);for(const worker of snapshot?.workers??[])if(worker.active?.sessionId===event.sessionId)worker.active.state=state;if(snapshot?.active?.sessionId===event.sessionId){snapshot.active.state=state;$('agent-state').textContent=state;}renderActivity();}else if(['engine_exit','eof'].includes(event.event))refresh().catch(e=>notice(e.message));else if(event.event==='error')notice(event.error);});
chromeProfiles=await api.chromeProfiles().catch(error=>{chromeProfilesError=error.message;return [];});
catalog=await api.catalog();$('provider').replaceChildren(...catalog.map(a=>{const o=new Option(a.label+(a.supported?'':' — MCP henüz yok'),a.id);o.disabled=!a.supported;return o;}));$('provider').onchange=()=>settingsOptions();
// Agent settings save on change; the store applies them at the next agent start. Fresh profile is read first so a stale snapshot never overwrites facts the agent just learned.
let settingsQueue=Promise.resolve();
$('agent-settings-form').onchange=event=>{
 const owner=automationUI?.selected??candidate;if(!owner)return;const web=automationUI?.selected===owner,profile=web?workspaceAgent?.workspace:snapshot?.profile,f=$('agent-settings-form').elements;
 const browserChanged=['browserMode','chromeProfile'].includes(event.target.name),browserMode=f.browserMode.value,chromeProfile=chromeProfiles.find(p=>p.directory===f.chromeProfile.value)??(profile?.chromeProfile?.directory===f.chromeProfile.value?profile.chromeProfile:null);
 const agentSettings={provider:f.provider.value,model:f.model.value,permission:f.permission.value,reasoning:f.reasoning.value,network:f.provider.value!=='codex'||f.network.value==='inherit'?null:f.network.value==='true',contextRestartPercent:f.contextRestartPercent.value===''?NaN:Number(f.contextRestartPercent.value),contextCompactPercent:f.contextCompactPercent.value===''?NaN:Number(f.contextCompactPercent.value)};
 chromeProfileVisibility();const status=$('agent-settings-status');status.textContent='Kaydediliyor…';
 settingsQueue=settingsQueue.then(async()=>{
  await api.workspaceSettings(owner,{agentSettings,...(browserChanged?{browserMode,chromeProfile}:{})});
  if(web&&automationUI?.selected===owner)await automationUI.refresh();
  if((automationUI?.selected??candidate)===owner)status.textContent=browserChanged?'Kaydedildi. Tarayıcı motoru güncellendi.':event.target.name.startsWith('context')?'Kaydedildi. Context eşiği hemen uygulanır.':'Kaydedildi. Sonraki başlatmada uygulanır';
 }).catch(e=>{if((automationUI?.selected??candidate)===owner)status.textContent='Kaydedilemedi: '+e.message;});
};
const initialView=localStorage.getItem('selected-view'),savedAutomation=localStorage.getItem('selected-automation');await refresh();fillProfile();
if(automationUI&&savedAutomation){await automationUI.select(savedAutomation).then(()=>switchView(['board','agent','profile','sources','files','background','config'].includes(initialView)?initialView:'board')).catch(()=>switchView(candidate?'board':'templates'));}
else if(automationUI&&!candidate){const first=(await api.workspaces()).find(w=>w.kind==='web');if(first)await automationUI.select(first.id);else switchView('templates');}else switchView(candidate?'board':'profile');setupUI.update(snapshot,catalog);
api.onAutomationChange?.(()=>refresh().catch(e=>notice(e.message)));
