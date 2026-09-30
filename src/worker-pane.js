const node=(tag,cls,text)=>{const element=document.createElement(tag);element.className=cls;if(text!==undefined)element.textContent=text;return element;};

export const WORKER_VIEWS=[['terminal','Terminal'],['chat','Sohbet']];

// The same terminal frame is used by job workers and template workspaces.
// Each worker offers two views of one session: the raw terminal and a readable transcript.
export function workerPane({id='main',name='Worker 1',terminalId='terminal',actions,view='terminal',showChat=true,onView=()=>{}}){
 const card=node('section','worker-pane');card.dataset.workerId=id;card.setAttribute('aria-label',`${name} terminali`);
 const top=node('div','worker-pane-head'),identity=node('div','worker-identity'),heading=node('h3','',name),status=node('span','worker-status');
 identity.append(heading,status);const controls=node('div','worker-controls'),buttons={};
 const switcher=node('div','worker-view-switch');switcher.setAttribute('role','tablist');switcher.setAttribute('aria-label',`${name} görünümü`);
 const views={};
 for(const [key,label] of WORKER_VIEWS.filter(([key])=>showChat||key==='terminal')){const button=node('button','',label);button.type='button';button.setAttribute('role','tab');button.dataset.view=key;button.onclick=()=>setView(key);switcher.append(button);views[key]=button;}
 switcher.hidden=!showChat;
 switcher.onkeydown=event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=card.dataset.view==='chat'?'terminal':'chat';setView(next);views[next].focus();};
 for(const [key,text,label] of [['start','Başlat','başlat'],['stop','Durdur','durdur'],['restart','Yenile','yeniden başlat'],['remove','×','kaldır']]){
  const button=node('button','quiet'+(key==='remove'?' worker-remove':''),text);button.type='button';button.setAttribute('aria-label',`${name} ${label}`);button.title=`${name} ${label}`;button.onclick=actions[key];controls.append(button);buttons[key]=button;
 }
 buttons.remove.hidden=id==='main';top.append(identity,switcher,controls);
 const task=node('div','worker-task'),title=node('strong','worker-task-title'),detail=node('small','worker-task-detail'),pageProgress=node('small','worker-page-progress');pageProgress.hidden=true;pageProgress.setAttribute('aria-live','polite');task.append(title,detail,pageProgress);
 const host=node('div','worker-terminal');if(terminalId)host.id=terminalId;
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
 card.append(top,task,attention,idle,host,chat,outcome,inputHint);
 function setView(next,{notify=true}={}){
  if(!views[next])next='terminal';
  const changed=card.dataset.view!==next;card.dataset.view=next;
  for(const [key,button] of Object.entries(views)){const selected=key===next;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}
  if(changed&&notify)onView(next);
 }
 setView(view,{notify:false});
 return {card,host,status,idle,idleTitle,idleDetail,idleHistory,task,title,detail,pageProgress,attention,attentionTitle,attentionDetail,attentionButton,outcome,outcomeTitle,outcomeDetail,inputHint,chat,chatLog,chatJump,chatForm,chatInput,chatSend,setView,view:()=>card.dataset.view,...buttons};
}
