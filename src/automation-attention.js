import {automationAttention} from '../app/automation-attention.mjs';
import {groupWorkspaceTabs} from './workspace-tabs.js';

const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
export function attentionTabs(issue,tabs,sources){
 const exact=tabs.find(t=>t.tabId===issue.tabId&&(!issue.url||t.url===issue.url));
 if(exact)return [exact];
 const urlMatches=tabs.filter(t=>issue.url&&t.url===issue.url);
 if(urlMatches.length)return urlMatches;
 if(!issue.sourceUrl)return [];
 return groupWorkspaceTabs(tabs,sources.map(s=>({id:s.url,url:s.url}))).grouped.get(issue.sourceUrl)??[];
}

export function automationAttentionPanel(api,{navigate,refresh,ask}){
 const banner=el('div',null,'automation-attention-banner');banner.hidden=true;banner.dataset.webOnly='';
 const bannerText=el('strong'),review=el('button','Müdahaleleri göster','quiet');review.type='button';
 banner.append(el('span','!','attention-icon'),bannerText,review);document.querySelector('main>header').after(banner);
 const panel=el('section',null,'automation-attention');panel.hidden=true;panel.dataset.webOnly='';panel.setAttribute('aria-label','Müdahale gereken kaynaklar');
 document.querySelector('#now-panel').before(panel);
 const announcement=el('p',null,'attention-announcement');announcement.setAttribute('role','status');announcement.setAttribute('aria-live','polite');panel.append(announcement);
 const list=el('div',null,'attention-list');panel.append(list);
 const scheduled=el('details',null,'automation-retry-plans');scheduled.hidden=true;scheduled.dataset.webOnly='';panel.after(scheduled);
 const cards=new Map();let owner=null,snapshot=null,signature='',planSignature='';
 review.onclick=()=>{navigate('agent');panel.scrollIntoView({block:'start',behavior:'smooth'});cards.values().next().value?.open.focus({preventScroll:true});};
 function create(issue){
  const workspace=owner,card=el('article',null,'automation-help-card');card.dataset.issueId=issue.id;
  const heading=el('div',null,'automation-help-heading'),copy=el('div');copy.append(el('span','Müdahale gerekiyor','automation-help-label'),el('h3',issue.name));heading.append(el('span','!','attention-icon'),copy);
  const summary=el('p',issue.message.length>300?issue.message.slice(0,297)+'…':issue.message,'automation-help-summary');
  const instructions=el('p',issue.retry?'İlgili sekmede engeli giderdikten sonra devam edebilirsin.':'İlgili sekmeyi kontrol et. Sonuç belirsizse agent’a durumu yaz; işlemi yeniden gönderme.','automation-help-instructions');
  const actions=el('div',null,'automation-help-actions'),open=el('button','Sekmeyi göster ↗','primary'),resume=el('button',issue.retry?'Çözdüm, devam et':'Agent’a yaz','quiet');
  open.type=resume.type='button';actions.append(open,resume);
  const later=issue.retry?el('button','2 saat sonra dene','quiet'):null;
  if(later){later.type='button';later.disabled=Boolean(issue.closing);actions.append(later);}
  if(issue.closing){resume.disabled=true;resume.textContent='Oturum kapanıyor…';}
  const feedback=el('p',null,'automation-help-feedback');feedback.hidden=true;feedback.setAttribute('role','status');
  const choices=el('div',null,'automation-help-tabs');choices.hidden=true;
  const run=async(action)=>{if(card.dataset.busy==='true')return;card.dataset.busy='true';open.disabled=resume.disabled=true;if(later)later.disabled=true;feedback.hidden=true;try{await action();}catch(error){feedback.textContent=error.message;feedback.hidden=false;}finally{card.dataset.busy='false';open.disabled=false;resume.disabled=Boolean(issue.closing);if(later)later.disabled=Boolean(issue.closing);}};
  const focus=tab=>run(async()=>{await api.focusWorkspaceTab(workspace,tab.tabId);choices.hidden=true;});
  open.onclick=()=>run(async()=>{
   const tabs=attentionTabs(issue,await api.workspaceTabs(workspace),snapshot?.sources??[]);
   if(!tabs.length)throw Error('İlgili açık sekme bulunamadı. Sekme kapanmış veya tarayıcı bağlantısı kesilmiş olabilir. Chrome bağlantısını kontrol et.');
   if(tabs.length===1){await api.focusWorkspaceTab(workspace,tabs[0].tabId);return;}
   choices.replaceChildren(el('p','Bu kaynağa ait açık sekmeyi seç:'));choices.hidden=false;
   for(const tab of tabs){const button=el('button',tab.url,'quiet');button.type='button';button.onclick=()=>focus(tab);choices.append(button);}
  });
  resume.onclick=()=>run(async()=>{
   if(!issue.retry){ask();return;}
   if(issue.retry==='source')await api.automationSourceRun(workspace,issue.sourceUrl);else await api.automationRun(workspace,'trial');
   await refresh();
  });
  if(later)later.onclick=()=>run(async()=>{await api.automationRetryLater(workspace,issue.id);await refresh();});
  card.append(heading,summary,instructions,actions,choices,feedback);
  if(issue.message.length>300){const details=el('details');details.append(el('summary','Agent’ın açıklamasının tamamı'),el('p',issue.message));card.append(details);}
  list.append(card);return {card,open};
 }
 return {update(id,value){
  if(owner!==id){owner=id;signature='';planSignature='';scheduled.open=false;cards.clear();list.replaceChildren();}
  snapshot=value;const all=id?automationAttention(value):[],issues=all.filter(issue=>!issue.retryAt),plans=all.filter(issue=>issue.retryAt),next=JSON.stringify(issues);
  banner.hidden=panel.hidden=!issues.length;
  bannerText.textContent=`${issues.length} müdahale bekleniyor`;
  if(next!==signature){signature=next;cards.clear();list.replaceChildren();for(const issue of issues)cards.set(issue.id,create(issue));announcement.textContent=issues.length?'Agent’ın devam edebilmesi için aşağıdaki engelleri kontrol et.':'';}
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
