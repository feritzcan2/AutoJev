import {formatTokens,parseTokenInput,setupTokenInput} from './token-input.js';
import {DEFAULT_COMPACT_TOKENS} from '../app/context-compaction.mjs';
import {defaultPermission} from '../app/agent-settings.mjs';
import {coalesceRefresh} from './refresh-queue.js';
import {saveAgentSettings,createAgentRestartDialog} from './agent-settings-save.js';
import {instructionsPanel} from './instructions.js';
import {automationsPage} from './automations.js';
import {createChromeProfileDialog} from './chrome-profile-dialog.js';
import {workspaceSwitcher} from './workspace-switcher.js';
import {workerTerminals} from './worker-terminals.js';
import {activityPanels} from './activity-panels.js';
import {configPage} from './config.js';
import {notificationsPage} from './notifications.js';
import './style.css';
import './question-form.css';
import './browser-status.css';
import './termloop-theme.css';
import './sidebar.css';
import './activity.css';
import './sources.css';
import './board.css';
import './profile.css';
const api=window.jobloop,$=id=>document.getElementById(id);
let catalog=[],chromeProfiles=[],chromeProfilesError='',workspaceAgent=null,agentSettingsSignature='',agentSettingsOwner=null,deletingWorkspace=null;
let settingsQueue=Promise.resolve(),refreshVersion=0;
const refresh=coalesceRefresh(refreshWorkspace);
let agentSettingsDirty=false,agentSettingsSaving=false,agentSettingsBaseline='';
const confirmAgentRestart=createAgentRestartDialog();
const notice=message=>{$('notice').textContent=message;$('notice').hidden=!message;};
const attempt=fn=>async(...args)=>{try{return await fn(...args);}catch(error){notice(error.message);}};
function element(tag,cls,value){const node=document.createElement(tag);if(cls)node.className=cls;if(value!==undefined)node.textContent=value;return node;}
function relativeTime(value){const minutes=Math.round(Math.abs(Date.now()-new Date(value).getTime())/60000);return minutes<1?'az önce':minutes<60?`${minutes} dk önce`:`${Math.round(minutes/60)} sa önce`;}
const workspaceMenu=workspaceSwitcher($('candidates'));
const actions=element('div','workspace-actions');actions.innerHTML='<button id="rename-workspace" class="quiet" type="button">Yeniden adlandır</button><button id="delete-workspace" class="quiet danger" type="button">Sil</button>';$('new').after(actions);
const renameDialog=document.createElement('dialog');renameDialog.id='rename-workspace-dialog';renameDialog.innerHTML='<form><h2>Çalışma alanını yeniden adlandır</h2><label>Yeni ad<input name="workspaceName" maxlength="150" required></label><div class="workspace-dialog-actions"><button class="quiet" type="button" data-cancel>Vazgeç</button><button class="primary" type="submit">Kaydet</button></div></form>';document.body.append(renameDialog);
renameDialog.querySelector('[data-cancel]').onclick=()=>renameDialog.close();
const selectedWorkspace=()=>({id:automationUI.selected,title:automationUI.data?.automation.title});
$('rename-workspace').onclick=()=>{const owner=selectedWorkspace();if(!owner.id)return;renameDialog.dataset.workspaceId=owner.id;renameDialog.querySelector('input').value=owner.title;renameDialog.showModal();renameDialog.querySelector('input').select();};
renameDialog.querySelector('form').onsubmit=attempt(async event=>{event.preventDefault();await api.renameWorkspace(renameDialog.dataset.workspaceId,renameDialog.querySelector('input').value);renameDialog.close();await refresh();notice('Çalışma alanı yeniden adlandırıldı.');});
async function deleteWorkspace(owner=selectedWorkspace()){
 if(!owner.id||deletingWorkspace||automationUI.busy)return;
 if(!confirm(`“${owner.title}” çalışma alanı silinsin mi? Kayıtlar, belgeler ve çalışma geçmişi kalıcı olarak kaldırılacak.`))return;
 deletingWorkspace=owner.id;++refreshVersion;
 try{await settingsQueue;await api.deleteWorkspace(owner.id);automationUI.deselect();deletingWorkspace=null;await refresh();switchView('templates');notice(`“${owner.title}” çalışma alanı silindi.`);}
 catch(error){notice(error.message);}finally{deletingWorkspace=null;}
}
$('delete-workspace').onclick=()=>deleteWorkspace();
const notificationsUI=notificationsPage(api,{notice});
const configUI=configPage(api,{notice,relativeTime,openNotifications:()=>switchView('notifications')});
const automationUI=automationsPage(api,{notice,getCatalog:()=>catalog,navigate:switchView,onSnapshot:syncWorkspaceAgent,focusAgent:options=>terminals.focus(options),syncWorkspaceMenu:()=>workspaceMenu.sync(),refreshWorkspaces:refresh,deleteWorkspace,isDeleting:()=>Boolean(deletingWorkspace)});
await document.fonts.ready;
const terminalSection=document.querySelector('#agent .terminal-section');$('agent-settings').before(terminalSection);
const terminals=workerTerminals(api,{container:terminalSection,conversationContainer:$('setup-agent-terminal'),notice,refresh,beforeAction:async(id,method,worker)=>{await settingsQueue;if(automationUI.dirty&&['startWorker','restartWorker'].includes(method)){switchView('profile');throw Error('Önce profil değişikliklerini kaydet.');}if(method==='startWorker'&&worker==='main'&&!automationUI.data.progress.reviewed){await automationUI.start();return false;}},sendMessage:async(id,text,worker)=>{await settingsQueue;return worker==='main'?automationUI.sendMessage(text):api.terminalMessage(id,text,worker);}});
const instructionsUI=instructionsPanel(api,$('agent'));
const activities=activityPanels($('now-panel'),{openLink:url=>api.openLink(url),notice});
const chromeStatus=element('div','chrome-status');chromeStatus.setAttribute('role','status');chromeStatus.setAttribute('aria-live','polite');
const chromeTitle=element('b'),chromeDetail=element('small'),chromeReconnect=element('button','quiet chrome-reconnect','Yeniden bağlan');chromeReconnect.type='button';chromeStatus.append(chromeTitle,chromeDetail,chromeReconnect);document.querySelector('.sidebar-bottom').before(chromeStatus);
const chromeProfileChange=element('button','quiet chrome-profile-change','Profili değiştir');chromeProfileChange.type='button';chromeStatus.append(chromeProfileChange);
const chromeProfileDialog=createChromeProfileDialog({loadProfiles:async()=>{chromeProfiles=await api.chromeProfiles();chromeProfilesError='';return chromeProfiles;},save:async(owner,chromeProfile)=>{await settingsQueue;await api.workspaceSettings(owner.id,{chromeProfile});await api.browserReconnect(owner.id);await refresh();notice('Chrome profili kaydedildi.');}});document.body.append(chromeProfileDialog.element);
chromeProfileChange.onclick=()=>{const a=automationUI.data?.automation;if(a)chromeProfileDialog.show({id:a.id,chromeProfile:a.chromeProfile,web:true});};
chromeReconnect.onclick=attempt(()=>automationUI.reconnectBrowser());
const sourcesNav=element('button');sourcesNav.dataset.view='sources';sourcesNav.innerHTML='<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>Kaynaklar</span><span id="sources-nav-status" class="agent-nav-status sources-nav-status" data-tone="active" aria-hidden="true" hidden></span>';document.querySelector('nav button[data-view="agent"]').before(sourcesNav);
function switchView(name,options={}){
 const global=['automations','templates'].includes(name),selected=automationUI.selected;
 document.querySelector('main>header>.actions').hidden=global||!selected||name==='setup-agent';document.body.classList.toggle('automation-workspace',Boolean(selected)&&!global);
 for(const id of ['notifications','config','profile','board','agent','setup-agent','files'])if($(id))$(id).hidden=true;
 automationUI.element.hidden=false;
 if(global){$('heading').textContent='Yeni çalışma alanı';if(!options.detail)automationUI.show('templates').catch(error=>notice(error.message));}
 else if(selected){automationUI.renderShell();if(name==='config'){automationUI.element.hidden=true;$('config').hidden=false;configUI.select(selected);configUI.show();}else if(name==='notifications'){automationUI.element.hidden=true;$('notifications').hidden=false;notificationsUI.show(selected);}else{automationUI.showPane(name);if(['agent','setup-agent'].includes(name))$(name).hidden=false;}}
 localStorage.setItem('selected-view',name);document.querySelectorAll('aside nav button').forEach(button=>button.classList.toggle('selected',button.dataset.view===name));workspaceMenu.sync();
}
function settingsOptions(saved){
 const current=catalog.find(a=>a.id===$('provider').value);if(!current)return;
 const fields=$('agent-settings-form').elements;fields.network.disabled=current.id!=='codex';
 for(const [name,fallback]of [['contextCompactTokens',DEFAULT_COMPACT_TOKENS],['contextRestartTokens',0]]){
  const field=fields[name];
  if(saved){field.value=formatTokens(saved[name]??fallback);field.setCustomValidity('');}
 }
 for(const [key,list]of [['model',current.models],['permission',current.permissions],['reasoning',current.reasoning]]){$(key).replaceChildren(...list.map(value=>new Option(value,value)));$(key).value=list.includes(saved?.[key])?saved[key]:key==='permission'?defaultPermission(current.id):'default';}
 $('trialModel').replaceChildren(new Option('Ana modelle aynı',''),...current.models.filter(value=>value!=='default').map(value=>new Option(value,value)));$('trialModel').value=current.models.includes(saved?.trialModel)?saved.trialModel:'';
}
function chromeProfileOptions(selected=workspaceAgent?.workspace?.chromeProfile){
 const select=$('agent-settings-form').elements.chromeProfile;
 select.replaceChildren(new Option('Profil belirtme',''),...chromeProfiles.map(p=>new Option(`${p.name} — ${p.directory}`,p.directory)));
 if(selected&&!chromeProfiles.some(p=>p.directory===selected.directory))select.add(new Option(`${selected.name} — ${selected.directory} (bulunamadı)`,selected.directory));
 select.value=selected?.directory??'';
 chromeProfileVisibility();
}
function chromeProfileVisibility(){
 $('chrome-profile-hint').textContent=chromeProfilesError||(chromeProfiles.length?'Jev mevcut girişini kullanır; ilanları tek AutoJev penceresinde sekmeler olarak açar.':'Chrome profili bulunamadı.');
}
function fillAgentSettings(profile,id){
 const changedOwner=agentSettingsOwner!==id;agentSettingsOwner=id;
 if(changedOwner)agentSettingsDirty=false;
 if(agentSettingsDirty&&!changedOwner)return;
 const p=profile??{},key=JSON.stringify([id,p.agentSettings,p.chromeProfile]);if(agentSettingsSignature===key)return;agentSettingsSignature=key;
 const form=$('agent-settings-form');
 chromeProfileOptions(p.chromeProfile);$('agent-settings').classList.toggle('is-off',!id);if(!id)$('agent-settings-status').textContent='Önce bir çalışma alanı seç';else if(changedOwner||$('agent-settings-status').textContent==='Önce bir çalışma alanı seç')$('agent-settings-status').textContent='Değişiklikleri Kaydet ile uygula';
 $('provider').value=p.agentSettings?.provider??'codex';settingsOptions(p.agentSettings??{});form.elements.network.value=p.agentSettings?.network==null?'inherit':String(p.agentSettings.network);
 agentSettingsBaseline=JSON.stringify(readAgentSettings());$('agent-settings-save').disabled=true;
}
function syncWorkspaceAgent(value){
 workspaceAgent=value;if(!value){terminals.update(null,null);instructionsUI.select(null);return;}
 const id=value.workspace.id;if(automationUI.selected!==id)return;
 const next={...value,capabilities:{...value.capabilities,canStart:value.capabilities.canStart&&!automationUI.dirty,canRestart:value.capabilities.canRestart&&!automationUI.dirty}};
 instructionsUI.select(id);terminals.update(id,next);activities.update(next,true);fillAgentSettings(next.workspace,id);renderContext(next);configUI.select(id);notificationsUI.select(id);
}
function renderContext(value){
 const usage=value?.active?.contextUsage,threshold=value?.workspace.agentSettings.contextRestartTokens??0,compactThreshold=value?.workspace.agentSettings.contextCompactTokens??0,compact=value?.active?.compaction;
 $('context-compact-status').textContent=({sending:'/compact gönderiliyor…',submitted:'/compact gönderildi; sağlayıcıdan compaction bekleniyor.',running_command:'Sağlayıcı /compact komutunu işliyor…',verified:'Compaction tamamlandı.',compacting:'Context sıkıştırılıyor…',awaiting_usage:'Compaction turu bitti; yeni context ölçümü bekleniyor.',completed:'Context kullanımı eşik altına indi.',waiting:'Terminalin komut almaya hazır olması bekleniyor.',unconfirmed:'Compaction doğrulanamadı. '+(compact?.error??'')})[compact?.state]??(compactThreshold?`Otomatik compaction: ${formatTokens(compactThreshold)} token.`:'Otomatik compaction kapalı.');
 if(value?.workspace.agentSettings.provider==='opencode'&&!compact?.state)$('context-compact-status').textContent=compactThreshold?`OpenCode otomatik compaction: ${formatTokens(compactThreshold)} token. Eşik değişikliği sonraki agent oturumunda uygulanır.`:'Uygulamanın compaction eşiği kapalı; OpenCode kendi varsayılanını kullanır.';
 $('context-usage-status').textContent=!threshold&&!compactThreshold?'Otomatik context yönetimi kapalı.':!value?.active?'Sonraki oturumda context izlenecek.':usage?.tokens==null?'Context token ölçümü bekleniyor.':`Context kullanımı: ${formatTokens(usage.tokens)} token.${threshold>0&&usage.peakTokens>=threshold?' Eşiğe ulaşıldı; görev bitince yeni agent oturumu açılacak.':''}`;
}
async function refreshWorkspace(){
 if(deletingWorkspace)return;const version=++refreshVersion,items=await api.workspaces();if(version!==refreshVersion)return;
 $('candidates').replaceChildren(new Option('Çalışma alanı seç',''),...items.map(item=>new Option(item.title,item.id)));
 if(automationUI.selected&&!items.some(item=>item.id===automationUI.selected))automationUI.deselect();
 if(automationUI.selected){$('candidates').value=automationUI.selected;await automationUI.refresh();}
 workspaceMenu.sync();
}
$('new').textContent='Yeni çalışma alanı';$('new').onclick=attempt(()=>automationUI.createBlank());
$('candidates').onchange=attempt(async()=>{const id=$('candidates').value;notice('');if(id){await automationUI.select(id);await refresh();}});
$('start').onclick=attempt(async()=>{await settingsQueue;await automationUI.start();});
$('stop').onclick=attempt(()=>automationUI.stop());$('restart-agent').onclick=attempt(async()=>{await settingsQueue;await automationUI.restart();});
for(const button of document.querySelectorAll('aside nav button[data-view]'))button.onclick=()=>switchView(button.dataset.view);
$('close-preview').onclick=()=>$('document-preview').close();
api.onChange(event=>{if(event.candidateId&&event.candidateId!==automationUI.selected)return;refresh().catch(error=>notice(error.message));});
api.onAgentEvent(event=>{if(event.candidateId&&event.candidateId!==automationUI.selected)return;terminals.event(event);if(['state','engine_exit','eof'].includes(event.event))refresh().catch(error=>notice(error.message));else if(event.event==='error')notice(event.error);});
chromeProfiles=await api.chromeProfiles().catch(error=>{chromeProfilesError=error.message;return [];});
catalog=await api.catalog();$('provider').replaceChildren(...catalog.map(item=>{const option=new Option(item.label+(item.supported?'':' — MCP henüz yok'),item.id);option.disabled=!item.supported;return option;}));$('provider').onchange=()=>settingsOptions();
function readAgentSettings(){
 const profile=workspaceAgent?.workspace,f=$('agent-settings-form').elements;
 const contextTokens=name=>parseTokenInput(f[name].value);
 const chromeProfile=chromeProfiles.find(p=>p.directory===f.chromeProfile.value)??(profile?.chromeProfile?.directory===f.chromeProfile.value?profile.chromeProfile:null);
 const agentSettings={provider:f.provider.value,model:f.model.value,trialModel:f.trialModel.value||null,permission:f.permission.value,reasoning:f.reasoning.value,network:f.provider.value!=='codex'||f.network.value==='inherit'?null:f.network.value==='true',contextRestartTokens:contextTokens('contextRestartTokens'),contextCompactTokens:contextTokens('contextCompactTokens')};
 return {agentSettings,chromeProfile};
}
function markAgentSettingsDirty(){
 if(!automationUI.selected||agentSettingsSaving)return;
 chromeProfileVisibility();agentSettingsDirty=JSON.stringify(readAgentSettings())!==agentSettingsBaseline;
 $('agent-settings-save').disabled=!agentSettingsDirty;
 $('agent-settings-status').textContent=agentSettingsDirty?'Kaydedilmemiş değişiklikler var.':'Değişiklik yok.';
}
for(const name of ['contextCompactTokens','contextRestartTokens'])setupTokenInput($('agent-settings-form').elements[name]);
$('agent-settings-form').oninput=markAgentSettingsDirty;
$('agent-settings-form').onchange=markAgentSettingsDirty;
$('agent-settings-form').onsubmit=event=>{
 event.preventDefault();const owner=automationUI.selected;
 if(!owner||agentSettingsSaving||!agentSettingsDirty)return;
 const input=readAgentSettings(),baseline=JSON.parse(agentSettingsBaseline);
 if(JSON.stringify(input.chromeProfile)===JSON.stringify(baseline.chromeProfile))delete input.chromeProfile;
 const form=$('agent-settings-form'),status=$('agent-settings-status');
 agentSettingsSaving=true;form.inert=true;$('agent-settings-save').disabled=true;status.textContent='Kaydediliyor…';
 let saved=false;
 settingsQueue=settingsQueue.then(async()=>{
  const result=await saveAgentSettings({api,owner,input,confirmRestart:confirmAgentRestart,onSaved:()=>{
   saved=true;if(automationUI.selected===owner){agentSettingsDirty=false;agentSettingsSignature='';status.textContent='Kaydedildi.';}
  }});
  if(automationUI.selected===owner){
   await automationUI.refresh();
   status.textContent=result.failed.length?`Ayarlar kaydedildi. Yeniden başlatılamayan agent’ler: ${result.failed.join('; ')}`:result.restarted?`Kaydedildi. ${result.restarted} agent yeniden başlatıldı.`:input.agentSettings.provider==='opencode'?'Kaydedildi. Yeni oturum eşiği hemen, compaction ve diğer ayarlar sonraki başlatmada uygulanır.':'Kaydedildi. Context eşikleri hemen, diğer ayarlar sonraki başlatmada uygulanır.';
  }
 }).catch(error=>{if(automationUI.selected===owner)status.textContent=(saved?'Ayarlar kaydedildi. ':'Kaydedilemedi: ')+error.message;})
 .finally(()=>{agentSettingsSaving=false;form.inert=false;$('agent-settings-save').disabled=!agentSettingsDirty;});
};
const initialView=localStorage.getItem('selected-view'),saved=localStorage.getItem('selected-workspace')??localStorage.getItem('selected-automation')??localStorage.getItem('selected-candidate');
await refresh();const items=await api.workspaces(),selected=items.find(item=>item.id===saved)??items[0];
if(selected){await automationUI.select(selected.id);await refresh();switchView((automationUI.data.progress.fresh||automationUI.data.automation.status==='draft')&&(!initialView||initialView==='board')?'setup-agent':['board','agent','setup-agent','profile','sources','files','background','config','notifications'].includes(initialView)?initialView:'board');}else switchView('templates');
localStorage.removeItem('selected-candidate');localStorage.removeItem('selected-automation');
api.onAutomationChange?.(event=>{if(event.automationId&&event.automationId!==automationUI.selected)return;refresh().catch(error=>notice(error.message));});
