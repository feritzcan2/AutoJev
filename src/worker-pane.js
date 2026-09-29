const node=(tag,cls,text)=>{const element=document.createElement(tag);element.className=cls;if(text!==undefined)element.textContent=text;return element;};

// The same terminal frame is used by job workers and template workspaces.
export function workerPane({id='main',name='Worker 1',terminalId='terminal',actions}){
 const card=node('section','worker-pane');card.dataset.workerId=id;card.setAttribute('aria-label',`${name} terminali`);
 const top=node('div','worker-pane-head'),identity=node('div','worker-identity'),heading=node('h3','',name),status=node('span','worker-status');
 identity.append(heading,status);const controls=node('div','worker-controls'),buttons={};
 for(const [key,text,label] of [['start','Başlat','başlat'],['stop','Durdur','durdur'],['restart','Yenile','yeniden başlat'],['remove','×','kaldır']]){
  const button=node('button','quiet'+(key==='remove'?' worker-remove':''),text);button.type='button';button.setAttribute('aria-label',`${name} ${label}`);button.title=`${name} ${label}`;button.onclick=actions[key];controls.append(button);buttons[key]=button;
 }
 buttons.remove.hidden=id==='main';top.append(identity,controls);
 const task=node('div','worker-task'),title=node('strong','worker-task-title'),detail=node('small','worker-task-detail');task.append(title,detail);
 const host=node('div','worker-terminal');if(terminalId)host.id=terminalId;
 const outcome=node('div','worker-outcome');outcome.hidden=true;outcome.setAttribute('role','status');
 const outcomeTitle=node('strong',''),outcomeDetail=node('span',''),outcomeLink=node('button','quiet','Sonuç ve sonraki adım ↑');outcomeLink.type='button';outcomeLink.onclick=()=>document.querySelector('#now-panel')?.scrollIntoView({block:'start',behavior:'smooth'});outcome.append(outcomeTitle,outcomeDetail,outcomeLink);
 const inputHint=node('p','worker-input-hint');inputHint.hidden=true;
 card.append(top,task,host,outcome,inputHint);
 return {card,host,status,title,detail,outcome,outcomeTitle,outcomeDetail,inputHint,...buttons};
}
