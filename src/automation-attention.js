import {questionForm} from './question-form.js';
import {automationAttention} from '../app/automation-attention.mjs';
import {groupWorkspaceTabs} from './workspace-tabs.js';

const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
export function attentionTabs(issue,tabs,sources){
 const exact=tabs.find(t=>t.tabId===issue.tabId&&(issue.kind==='question'||!issue.url||t.url===issue.url));
 if(exact)return [exact];
 const urlMatches=tabs.filter(t=>issue.url&&t.url===issue.url);
 if(urlMatches.length)return urlMatches;
 if(!issue.sourceUrl)return [];
 return groupWorkspaceTabs(tabs,sources.map(s=>({id:s.url,url:s.url}))).grouped.get(issue.sourceUrl)??[];
}

export function automationAttentionPanel(api,{navigate,refresh,getConversation=()=>null,showRecordQuestions=()=>{}}){
 const banner=el('div',null,'automation-attention-banner');banner.hidden=true;banner.dataset.webOnly='';
 const bannerText=el('strong'),review=el('button','Müdahaleleri göster','quiet');review.type='button';
 banner.append(el('span','!','attention-icon'),bannerText,review);document.querySelector('main>header').after(banner);
 const panel=el('section',null,'automation-attention');panel.hidden=true;panel.dataset.webOnly='';panel.setAttribute('aria-label','Müdahale gereken kaynaklar');
 document.querySelector('#now-panel').before(panel);
 const announcement=el('p',null,'attention-announcement');announcement.setAttribute('role','status');announcement.setAttribute('aria-live','polite');panel.append(announcement);
 const list=el('div',null,'attention-list');panel.append(list);
 const scheduled=el('details',null,'automation-retry-plans');scheduled.hidden=true;scheduled.dataset.webOnly='';panel.after(scheduled);
 const chatAttention=document.querySelector('#setup-agent-attention');
 const isChatIssue=issue=>issue.conversation||['setup','conversation'].includes(issue.kind)||issue.workerId==='conversation'||issue.kind==='usage_limit'&&snapshot?.runs?.some(run=>run.id===issue.runId&&run.kind==='interview');
 const cards=new Map(),replyDrafts=new Map();let owner=null,snapshot=null,planSignature='',conversationCount=0;
 function questionTab(issue,workspace,feedback){
  const open=el('button','Sekmeyi göster ↗','primary'),choices=el('div',null,'automation-help-tabs');open.type='button';choices.hidden=true;
  const focus=async tab=>{open.disabled=true;feedback.textContent='';try{await api.focusWorkspaceTab(workspace,tab.tabId);choices.hidden=true;}catch(error){feedback.textContent=error.message;}finally{open.disabled=false;}};
  open.onclick=async()=>{open.disabled=true;feedback.textContent='';try{
   const tabs=attentionTabs(issue,await api.workspaceTabs(workspace),snapshot?.sources??[]);
   if(!tabs.length)throw Error('İlgili açık sekme bulunamadı. Sekme kapanmış veya tarayıcı bağlantısı kesilmiş olabilir.');
   if(tabs.length===1){await focus(tabs[0]);return;}
   choices.replaceChildren(el('p','İlgili açık sekmeyi seç:'));choices.hidden=false;
   for(const tab of tabs){const pick=el('button',tab.url,'quiet');pick.type='button';pick.onclick=()=>focus(tab);choices.append(pick);}
  }catch(error){feedback.textContent=error.message;}finally{open.disabled=false;}};
  return {open,choices};
 }
 review.onclick=()=>{const issues=automationAttention(snapshot).filter(i=>!i.retryAt);if(issues.length&&issues.every(i=>i.kind==='question'&&i.recordId)){showRecordQuestions();return;}const chatIssue=issues.find(isChatIssue);navigate(chatIssue?'setup-agent':'agent');if(chatIssue){if(chatIssue.kind==='question'&&getConversation()?.showQuestion(chatIssue.id))return;cards.get(chatIssue.id)?.card.scrollIntoView({block:'start',behavior:'smooth'});return;}document.querySelector('#agent-tab-work')?.click();panel.scrollIntoView({block:'start',behavior:'smooth'});[...cards.values()].find(item=>item.card.parentElement===list)?.open.focus({preventScroll:true});};
 function create(issue){
  if(issue.kind==='question')return createQuestion(issue);
  if(['setup','conversation'].includes(issue.kind))return createSetup(issue);
  if(issue.kind==='usage_limit')return createLimit(issue);
  if(issue.kind==='repeated_tool_error')return createToolFailure(issue);
  const workspace=owner,card=el('article',null,'automation-help-card');card.dataset.issueId=issue.id;
  const technical=issue.kind==='technical';
  const heading=el('div',null,'automation-help-heading'),copy=el('div');copy.append(el('span',technical?'Tarama tamamlanamadı':'Müdahale gerekiyor','automation-help-label'),el('h3',issue.name));heading.append(el('span','!','attention-icon'),copy);
  const summary=el('p',issue.message.length>300?issue.message.slice(0,297)+'…':issue.message,'automation-help-summary');
  const instructions=el('p',technical&&issue.retry?'Kaydedilen sonuçlar ve devam noktası korunuyor. Taramayı yeniden deneyebilirsin.':issue.retry?'İlgili sekmede engeli giderdikten sonra devam edebilirsin.':'İlgili sekmeyi kontrol et. Sonuç belirsizse agent’a durumu yaz; işlemi yeniden gönderme.','automation-help-instructions');
  if(issue.kind==='site_access')instructions.textContent=issue.cleanupError??`Diğer kaynaklar çalışmaya devam eder. Yanıt verirsen bu tarama kaldığı yerden sürer. ${new Date(issue.accessRetryAt).toLocaleString('tr-TR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})} tarihine kadar yanıt gelmezse sekmeler kapanır ve tarama sıfırdan başlar. Kartı kapatırsan sekmeler şimdi kapanır; sonraki deneme sıfırdan başlar.`;
  const actions=el('div',null,'automation-help-actions'),open=el('button','Sekmeyi göster ↗','primary'),reply=el('button','Yanıtla','quiet'),resume=issue.retry?el('button',technical?'Taramaya devam et':'Çözdüm, devam et','quiet'):null;
  open.type=reply.type='button';actions.append(open,reply);
  if(resume){resume.type='button';actions.append(resume);}
  const later=issue.retry?el('button','2 saat sonra dene','quiet'):null;
  if(later){later.type='button';later.disabled=Boolean(issue.closing);actions.append(later);}
  const close=el('button','Kapat','quiet');close.type='button';close.dataset.dismissAttention=issue.id;close.title='Bu müdahale bildirimini kapat';actions.append(close);
  if(issue.kind==='site_access'){close.title='Bu kaynağın bekleyen sekmelerini kapat; sonraki denemede sıfırdan başla';close.disabled=Boolean(issue.closing);}
  if(issue.closing&&resume){resume.disabled=true;resume.textContent='Oturum kapanıyor…';}
  const feedback=el('p',null,'automation-help-feedback');feedback.hidden=true;feedback.setAttribute('role','status');
  const choices=el('div',null,'automation-help-tabs');choices.hidden=true;
  const form=el('form',null,'automation-help-reply'),label=el('label','Agent’a ne yapması gerektiğini yaz'),input=el('textarea'),send=el('button','Gönder','primary'),cancel=el('button','Vazgeç','quiet');
  input.required=true;input.maxLength=10000;input.rows=3;input.placeholder='Örneğin: Indeed’i şimdilik atla, diğer kaynaklarla devam et.';
  input.value=replyDrafts.get(issue.id)??'';form.hidden=!replyDrafts.has(issue.id);reply.setAttribute('aria-expanded',String(!form.hidden));
  label.append(input);send.type='submit';cancel.type='button';send.disabled=!input.value.trim()||Boolean(issue.closing);
  const replyActions=el('div',null,'automation-help-actions');replyActions.append(send,cancel);
  form.append(label,el('small','Yanıtın bu engelin açıklamasıyla birlikte agente iletilir. Diğer kaynakların takibi devam eder.','automation-help-instructions'),replyActions);
  const toggleReply=show=>{form.hidden=!show;reply.setAttribute('aria-expanded',String(show));if(show){replyDrafts.set(issue.id,input.value);input.focus();}else{replyDrafts.delete(issue.id);input.value='';send.disabled=true;reply.focus();}};
  reply.onclick=()=>toggleReply(form.hidden);cancel.onclick=()=>toggleReply(false);
  input.oninput=()=>{replyDrafts.set(issue.id,input.value);send.disabled=!input.value.trim()||Boolean(issue.closing);};
  const run=async(action)=>{if(card.dataset.busy==='true')return;card.dataset.busy='true';open.disabled=reply.disabled=close.disabled=input.disabled=send.disabled=cancel.disabled=true;if(resume)resume.disabled=true;if(later)later.disabled=true;feedback.hidden=true;try{await action();}catch(error){feedback.textContent=error.message;feedback.hidden=false;}finally{card.dataset.busy='false';open.disabled=reply.disabled=close.disabled=input.disabled=cancel.disabled=false;send.disabled=!input.value.trim()||Boolean(issue.closing);if(resume)resume.disabled=Boolean(issue.closing);if(later)later.disabled=Boolean(issue.closing);}};
  close.onclick=()=>run(async()=>{await api.automationAttentionDismiss(workspace,issue.id,issue.dismissKey);if(owner!==workspace)return;replyDrafts.delete(issue.id);await refresh();});
  form.onsubmit=event=>{event.preventDefault();const text=input.value.trim();if(!text||issue.closing)return;void run(async()=>{
   const context=[`Müdahaleye yanıt: ${issue.name}`,issue.sourceUrl&&`Kaynak: ${issue.sourceUrl}`,issue.url&&`Sekme: ${issue.url}`,`Agent’ın açıklaması: ${issue.message}`].filter(Boolean).join('\n').slice(0,1900);
   if(issue.kind==='site_access')await api.automationSourceResume(workspace,issue.sourceUrl,issue.runId,text);
   else await api.terminalMessage(workspace,`${context}\n\nKullanıcının talimatı:\n${text}`,issue.workerId??'main');
   if(owner!==workspace)return;
   toggleReply(false);feedback.textContent='Yanıtın agente iletildi.';feedback.hidden=false;await refresh();
  });};
  const focus=tab=>run(async()=>{await api.focusWorkspaceTab(workspace,tab.tabId);choices.hidden=true;});
  open.onclick=()=>run(async()=>{
   const tabs=attentionTabs(issue,await api.workspaceTabs(workspace),snapshot?.sources??[]);
   if(!tabs.length)throw Error('İlgili açık sekme bulunamadı. Sekme kapanmış veya tarayıcı bağlantısı kesilmiş olabilir. Chrome bağlantısını kontrol et.');
   if(tabs.length===1){await api.focusWorkspaceTab(workspace,tabs[0].tabId);return;}
   choices.replaceChildren(el('p','Bu kaynağa ait açık sekmeyi seç:'));choices.hidden=false;
   for(const tab of tabs){const button=el('button',tab.url,'quiet');button.type='button';button.onclick=()=>focus(tab);choices.append(button);}
  });
  if(resume)resume.onclick=()=>run(async()=>{
   if(issue.kind==='site_access')await api.automationSourceResume(workspace,issue.sourceUrl,issue.runId);
   else if(issue.retry==='source')await api.automationSourceRun(workspace,issue.sourceUrl);else await api.automationRun(workspace,'trial');
   await refresh();
  });
  if(later)later.onclick=()=>run(async()=>{await api.automationRetryLater(workspace,issue.id);await refresh();});
  card.append(heading,summary,instructions,actions,form,choices,feedback);
  if(issue.message.length>300){const details=el('details');details.append(el('summary','Agent’ın açıklamasının tamamı'),el('p',issue.message));card.append(details);}
  list.append(card);return {card,open};
 }
 function createToolFailure(issue){
  const card=el('article',null,'automation-help-card');card.dataset.issueId=issue.id;
  const open=el('button','Kaydı göster','primary');open.type='button';
  open.onclick=()=>{navigate('board');document.querySelector(`[data-result-id="${CSS.escape(issue.recordId)}"]`)?.scrollIntoView({block:'center',behavior:'smooth'});};
  card.append(el('span','Tekrarlanan hata · Görev durduruldu','automation-help-label'),el('h3',issue.name),el('p',issue.message,'automation-help-summary'),el('p','Otomatik denemeler durduruldu. Hatanın nedenini giderdikten sonra sonuçlar tablosundan yeniden deneyebilirsin.','automation-help-instructions'),open);
  list.append(card);return {card,open};
 }
 function createSetup(issue){
  const conversation=issue.kind==='conversation',workspace=owner,card=el('article',null,'automation-help-card'),open=el('button',conversation?'Sohbete devam et':'Kuruluma devam et','primary'),feedback=el('p');card.dataset.issueId=issue.id;open.type='button';feedback.setAttribute('role','status');
  open.onclick=async()=>{open.disabled=true;try{await api.automationSetup(workspace);if(owner===workspace){await refresh();navigate('setup-agent');}}catch(error){feedback.textContent=error.message;}finally{open.disabled=false;}};
  card.append(el('h3',conversation?'Sohbet yarıda kaldı':'Kurulum yarıda kaldı'),el('p',issue.message),el('p',conversation?'Mesajların kayıtlı. Diğer işler devam ederken sohbeti yeniden deneyebilirsin.':'Bilgilerin ve yanıtların kayıtlı. Aynı kurulumdan devam edebilirsin.'),open,feedback);list.append(card);return {card,open};
 }
 function createQuestion(issue){
  const workspace=owner,card=el('article',null,'automation-help-card');card.dataset.issueId=issue.id;
  const form=questionForm(workspace,{id:issue.id,question:issue.message,fields:issue.fields},async value=>{await api.workspaceAnswer(workspace,issue.id,value);if(owner===workspace)await refresh();});
  const attach=el('button','Belge ekle','quiet'),feedback=el('p');attach.type='button';feedback.setAttribute('role','status');
  attach.onclick=async()=>{attach.disabled=true;try{const added=await api.pickDocument(workspace);if(added){feedback.textContent='Belge eklendi. Formu gönderdiğinde agent inceleyecek.';if(owner===workspace)await refresh();}}catch(error){feedback.textContent=error.message;}finally{attach.disabled=false;}};
  const tab=issue.tabId||issue.url?questionTab(issue,workspace,feedback):null,actions=el('div',null,'automation-help-actions');
  if(tab)actions.append(tab.open);actions.append(attach);
  if(issue.recordId&&issue.canDismissRecord){
   const dismiss=el('button',snapshot.definition?.records?.dismissLabel??'Kaydı ele','quiet');dismiss.type='button';dismiss.dataset.dismissRecord=issue.recordId;
   dismiss.onclick=async()=>{if(dismiss.disabled)return;const controls=[...card.querySelectorAll('button,input,textarea,select')],disabled=controls.map(control=>control.disabled);controls.forEach(control=>control.disabled=true);feedback.textContent='';
    try{await api.automationDismiss(workspace,issue.recordId);if(owner===workspace)await refresh();}catch(error){feedback.textContent=error.message;}finally{controls.forEach((control,index)=>control.disabled=disabled[index]);}
   };actions.append(dismiss);
  }
  card.append(el('h3',issue.message),form,actions,...(tab?[tab.choices]:[]),feedback);list.append(card);return {card,open:tab?.open??form.querySelector('textarea,input,select,button')};
 }
 function createLimit(issue){
  const card=el('article',null,'automation-help-card');card.dataset.issueId=issue.id;
  const heading=el('div',null,'automation-help-heading'),copy=el('div');copy.append(el('span','Kullanım limiti','automation-help-label'),el('h3',issue.name));heading.append(el('span','!','attention-icon'),copy);
  const open=el('button','Terminali göster','primary');open.type='button';
  open.onclick=()=>{navigate(isChatIssue(issue)?'setup-agent':'agent');document.querySelector(isChatIssue(issue)?'#setup-agent-tab-terminal':'#agent-tab-work')?.click();const pane=[...document.querySelectorAll('.worker-pane')].find(node=>node.dataset.workerId===issue.workerId);if(!pane)return;pane.querySelector('[role="tab"][data-view="terminal"]')?.click();pane.scrollIntoView({block:'center',behavior:'smooth'});pane.querySelector('.xterm-helper-textarea')?.focus({preventScroll:true});};
  const actions=el('div',null,'automation-help-actions');actions.append(open);
  card.append(heading,el('p',issue.title,'automation-help-summary'),el('p',issue.message,'automation-help-summary'),el('p',issue.sessionOpen?'Görev ve devam noktası korunuyor. Yeniden agent açılmadan bu oturumda bekleniyor.':'Sağlayıcı limiti nedeniyle oturum kapandı. Limit yenilendikten sonra görevi yeniden başlatabilirsin.','automation-help-instructions'),actions);
  list.append(card);return {card,open};
 }
 return {review:()=>review.click(),get conversationCount(){return conversationCount;},update(id,value){
  if(owner!==id){owner=id;planSignature='';scheduled.open=false;for(const {card} of cards.values())card.remove();cards.clear();replyDrafts.clear();list.replaceChildren();}
  snapshot=value;const all=id?automationAttention(value):[],issues=all.filter(issue=>!issue.retryAt),plans=all.filter(issue=>issue.retryAt),chat=getConversation();
  const panelIssues=issues.filter(i=>i.kind!=='question'||!i.recordId);
  const inline=panelIssues.filter(i=>chat&&i.kind==='question'&&i.conversation),chatIssues=panelIssues.filter(i=>chatAttention&&isChatIssue(i)&&!inline.includes(i)),outside=panelIssues.filter(i=>!inline.includes(i)&&!chatIssues.includes(i));conversationCount=inline.length+chatIssues.length;if(chatAttention)chatAttention.hidden=!chatIssues.length;
  banner.hidden=!issues.length;panel.hidden=!outside.length;
  const onlyRecordQuestions=issues.length&&!panelIssues.length,onlyChatQuestions=issues.length&&inline.length===issues.length;review.textContent=onlyRecordQuestions?'Yanıt bekleyenleri göster':onlyChatQuestions?'Formu aç':'Müdahaleleri göster';
  bannerText.textContent=onlyChatQuestions?`${inline.length} soru yanıtını bekliyor`:issues.length&&issues.every(i=>i.kind==='usage_limit')?`${issues.length} agent kullanım limitini bekliyor`:`${issues.length} müdahale bekleniyor`;
  for(const [key,item] of cards)if(!panelIssues.some(i=>i.id===key)){item.card.remove();cards.delete(key);}
  for(const issue of panelIssues){const next=JSON.stringify(issue),old=cards.get(issue.id);if(old?.signature===next)continue;old?.card.remove();cards.set(issue.id,{...create(issue),signature:next});}
  chat?.setQuestions(inline.map(issue=>cards.get(issue.id).card));
  for(const issue of chatIssues){const {card}=cards.get(issue.id);if(card.parentElement!==chatAttention)chatAttention.append(card);}
  for(const issue of outside){const {card}=cards.get(issue.id);if(card.parentElement!==list)list.append(card);}
  announcement.textContent=outside.length?'Agent’ın beklediği durumlar aşağıda gösteriliyor.':'';
  scheduled.hidden=!plans.length;
  const nextPlans=JSON.stringify(plans);
  if(nextPlans!==planSignature){
   planSignature=nextPlans;scheduled.replaceChildren(el('summary',`Planlanan denemeler (${plans.length})`));
   for(const issue of plans){
    const workspace=id,row=el('div',null,'automation-retry-plan'),cancel=el('button','Ertelemeyi iptal et','quiet');cancel.type='button';
    const feedback=el('span');feedback.setAttribute('role','status');
    row.append(el('span',`${issue.name} · ${new Date(issue.retryAt).toLocaleString('tr-TR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}`),cancel,feedback);
    cancel.onclick=async()=>{cancel.disabled=true;try{await api.automationRetryLater(workspace,issue.id,true);await refresh();}catch(error){feedback.textContent=error.message;}finally{cancel.disabled=false;}};
    scheduled.append(row);
   }
  }
  return issues.length;
 }};
}
