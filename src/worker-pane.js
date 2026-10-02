const node=(tag,cls,text)=>{const element=document.createElement(tag);element.className=cls;if(text!==undefined)element.textContent=text;return element;};

export const WORKER_VIEWS=[['terminal','Terminal'],['screenshot','Ekran görüntüsü'],['chat','Sohbet']];

// The same terminal frame is used by job workers and template workspaces.
// Each worker keeps its terminal, browser preview and optional transcript together.
export function workerPane({id='main',name='Worker 1',terminalId='terminal',actions,view='terminal',showChat=true,onView=()=>{}}){
 const card=node('section','worker-pane');card.dataset.workerId=id;card.setAttribute('aria-label',`${name} terminali`);
 const top=node('div','worker-pane-head'),identity=node('div','worker-identity'),heading=node('h3','',name),status=node('span','worker-status');
 identity.append(heading,status);const controls=node('div','worker-controls'),buttons={};
 const switcher=node('div','worker-view-switch');switcher.setAttribute('role','tablist');switcher.setAttribute('aria-label',`${name} görünümü`);
 const views={};
 for(const [key,label] of WORKER_VIEWS.filter(([key])=>showChat||key!=='chat')){const button=node('button','',label);button.type='button';button.setAttribute('role','tab');button.dataset.view=key;button.id=`worker-${id}-view-${key}`;button.onclick=()=>setView(key);switcher.append(button);views[key]=button;}
 switcher.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const keys=Object.keys(views),index=keys.indexOf(card.dataset.view),next=keys[event.key==='Home'?0:event.key==='End'?keys.length-1:(index+(event.key==='ArrowLeft'?-1:1)+keys.length)%keys.length];setView(next);views[next].focus();};
 for(const [key,text,label] of [['tab','Sekmeler','aktif işinin sekmelerini göster'],['start','Başlat','başlat'],['stop','Durdur','durdur'],['restart','Yenile','yeniden başlat'],['remove','×','kaldır']]){
  const button=node('button','quiet'+(key==='remove'?' worker-remove':''),text);button.type='button';button.setAttribute('aria-label',`${name} ${label}`);button.title=`${name} ${label}`;button.onclick=actions[key];controls.append(button);buttons[key]=button;
 }
 buttons.tab.hidden=!actions.tab;buttons.tab.dataset.workerTab=id;buttons.remove.hidden=id==='main';top.append(identity,switcher,controls);
 const tabList=node('div','worker-tabs');tabList.hidden=true;tabList.id=`worker-tabs-${id}`;buttons.tab.setAttribute('aria-controls',tabList.id);buttons.tab.setAttribute('aria-expanded','false');
 const task=node('div','worker-task'),title=node('strong','worker-task-title'),detail=node('small','worker-task-detail'),pageProgress=node('small','worker-page-progress');pageProgress.hidden=true;pageProgress.setAttribute('aria-live','polite');task.append(title,detail,pageProgress);
 const host=node('div','worker-terminal');if(terminalId)host.id=terminalId;
 const screenshot=node('section','worker-screenshot'),screenshotImage=node('img','worker-screenshot-image'),screenshotEmpty=node('div','worker-screenshot-empty','Görüntü bekleniyor…'),screenshotMeta=node('div','worker-screenshot-meta'),screenshotUrl=node('span','worker-screenshot-url'),screenshotStatus=node('span','worker-screenshot-status');
 screenshotImage.alt=`${name} tarayıcı ekranı`;screenshotImage.hidden=true;screenshotImage.draggable=false;screenshotStatus.setAttribute('role','status');
 screenshotMeta.append(screenshotUrl,screenshotStatus);screenshot.append(screenshotImage,screenshotEmpty,screenshotMeta);
 const idle=node('div','worker-idle');idle.hidden=true;
 const robot=node('div','worker-idle-robot');robot.setAttribute('aria-hidden','true');
 robot.innerHTML='<svg viewBox="0 0 128 112" fill="none"><ellipse cx="63" cy="104" rx="32" ry="5" fill="currentColor" opacity=".08"/><path d="M63 28V19" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="63" cy="14" r="5" fill="currentColor" opacity=".65"/><rect x="24" y="30" width="78" height="58" rx="22" fill="currentColor" opacity=".12"/><rect x="24" y="30" width="78" height="58" rx="22" stroke="currentColor" stroke-width="2"/><path d="M40 56q6 7 12 0m22 0q6 7 12 0M58 72q5 4 10 0" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M17 52v15m92-15v15M44 91v5m38-5v5" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><circle cx="38" cy="68" r="4" fill="#dfaaa5" opacity=".55"/><circle cx="88" cy="68" r="4" fill="#dfaaa5" opacity=".55"/></svg><span class="worker-idle-zzz">z<span>z</span></span>';
 const idleTitle=node('strong','worker-idle-title','Agent kapalı'),idleDetail=node('p','worker-idle-detail'),idleActions=node('div','worker-idle-actions'),idleHistory=node('button','worker-idle-history','Son terminal çıktısı');
 idleHistory.type='button';idleHistory.setAttribute('aria-expanded','false');idleActions.append(idleHistory);idle.append(robot,idleTitle,idleDetail,idleActions);
 const attention=node('div','worker-attention'),attentionCopy=node('div','worker-attention-copy'),attentionTitle=node('strong','worker-attention-title'),attentionDetail=node('span','worker-attention-detail'),attentionButton=node('button','worker-attention-button','Terminalde yanıtla');
 attention.hidden=true;attention.setAttribute('role','status');attention.setAttribute('aria-live','polite');attentionButton.type='button';attentionCopy.append(attentionTitle,attentionDetail);attention.append(attentionCopy,attentionButton);
 attentionButton.onclick=()=>{setView('terminal');host.querySelector('.xterm-helper-textarea')?.focus();};
 const chat=node('div','worker-chat'),chatLog=node('div','worker-chat-log');chatLog.setAttribute('role','log');chatLog.setAttribute('aria-label',`${name} sohbeti`);chatLog.setAttribute('aria-live','polite');
 const chatForm=node('form','worker-chat-form'),chatInput=node('textarea',''),chatSend=node('button','primary','Gönder');chatSend.type='submit';
 chatInput.rows=1;chatInput.maxLength=12000;chatInput.placeholder='Agent’a yaz…';chatInput.setAttribute('aria-label',`${name} mesajı`);
 chatInput.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();chatForm.requestSubmit();}};
 chatInput.oninput=()=>{chatInput.style.height='auto';chatInput.style.height=Math.min(160,chatInput.scrollHeight)+'px';};
 const chatJump=node('button','worker-chat-jump','↓ Yeni mesaj');chatJump.type='button';chatJump.hidden=true;
 chatForm.append(chatInput,chatSend);chat.append(chatLog,chatJump,chatForm);
 const outcome=node('div','worker-outcome');outcome.hidden=true;outcome.setAttribute('role','status');
 const outcomeTitle=node('strong',''),outcomeDetail=node('span',''),outcomeLink=node('button','quiet','Sonuç ve sonraki adım ↑');outcomeLink.type='button';outcomeLink.onclick=()=>document.querySelector('#now-panel')?.scrollIntoView({block:'start',behavior:'smooth'});outcome.append(outcomeTitle,outcomeDetail,outcomeLink);
 const inputHint=node('p','worker-input-hint');inputHint.hidden=true;
 card.append(top,tabList,task,attention,idle,host,screenshot,chat,outcome,inputHint);
 const panels={terminal:host,screenshot,chat};
 for(const [key,button] of Object.entries(views)){const panel=panels[key];panel.id||=`worker-${id}-panel-${key}`;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);button.setAttribute('aria-controls',panel.id);}
 function setView(next,{notify=true}={}){
  if(!views[next])next='terminal';
  const changed=card.dataset.view!==next;card.dataset.view=next;
  for(const [key,button] of Object.entries(views)){const selected=key===next;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}
  screenshot.hidden=next!=='screenshot';chat.hidden=next!=='chat';
  if(changed&&notify)onView(next);
 }
 setView(view,{notify:false});
 return {card,host,screenshot,screenshotImage,screenshotEmpty,screenshotUrl,screenshotStatus,tabList,status,idle,idleTitle,idleDetail,idleHistory,task,title,detail,pageProgress,attention,attentionTitle,attentionDetail,attentionButton,outcome,outcomeTitle,outcomeDetail,inputHint,chat,chatLog,chatJump,chatForm,chatInput,chatSend,setView,view:()=>card.dataset.view,...buttons};
}
