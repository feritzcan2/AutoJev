const ORDER_KEY='jobloop.workspaceOrder.v1';
const LIMIT=9;

export function shortcutIndex(event,mac){
 const primary=mac?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey;
 if(!primary||event.altKey||event.shiftKey)return -1;
 const match=/^Digit([1-9])$/.exec(event.code);
 return match?Number(match[1])-1:-1;
}

export function orderWorkspaces(workspaces,order){
 const rank=new Map(order.map((id,index)=>[id,index]));
 return [...workspaces].sort((a,b)=>(rank.get(a.id)??order.length+workspaces.indexOf(a))-(rank.get(b.id)??order.length+workspaces.indexOf(b)));
}

export function workspaceSwitcher(select){
 const mac=/Mac|iPhone|iPad/.test(navigator.platform),modifier=mac?'⌘':'Ctrl+';
 let saved=[];
 try{const value=JSON.parse(localStorage.getItem(ORDER_KEY));if(Array.isArray(value))saved=[...new Set(value.filter(id=>typeof id==='string'&&id))];}catch{}
 const container=select.parentElement,trigger=document.createElement('button'),avatar=document.createElement('span'),label=document.createElement('span'),chevron=document.createElement('span'),menu=document.createElement('div');
 trigger.type='button';trigger.className='workspace-switcher-trigger';trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
 avatar.className='workspace-switcher-avatar';avatar.setAttribute('aria-hidden','true');label.className='workspace-switcher-label';chevron.className='workspace-switcher-chevron';chevron.setAttribute('aria-hidden','true');chevron.textContent='⌄';trigger.append(avatar,label,chevron);
 menu.className='workspace-switcher-menu';menu.id='workspace-switcher-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','Çalışma alanları');menu.hidden=true;trigger.setAttribute('aria-controls',menu.id);
 container.append(trigger);document.body.append(menu);select.classList.add('workspace-native-select');select.tabIndex=-1;select.setAttribute('aria-hidden','true');
 const items=()=>[...select.options].filter(option=>option.value).map(option=>({id:option.value,title:option.textContent}));
 const ordered=()=>orderWorkspaces(items(),saved);
 const rows=()=>[...menu.querySelectorAll('[data-workspace-id]')];
 let drag=null,suppressClick=false;
 function close(focus=false){menu.hidden=true;trigger.setAttribute('aria-expanded','false');if(focus)trigger.focus();}
 function open(){if(trigger.disabled)return;render();menu.hidden=false;const rect=trigger.getBoundingClientRect();menu.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-menu.offsetWidth-12))}px`;menu.style.top=`${Math.max(12,Math.min(rect.bottom+6,window.innerHeight-menu.offsetHeight-12))}px`;trigger.setAttribute('aria-expanded','true');(rows().find(row=>row.dataset.workspaceId===select.value)??rows()[0])?.focus();}
 function choose(id,focus=false){if(select.disabled)return;close(focus);if(select.value===id)return;select.value=id;render();select.dispatchEvent(new Event('change',{bubbles:true}));}
 function reorder(id,target){const list=ordered().map(item=>item.id),from=list.indexOf(id),to=list.indexOf(target);if(from<0||to<0||from===to)return;list.splice(from,1);list.splice(to,0,id);saved=list;try{localStorage.setItem(ORDER_KEY,JSON.stringify(saved));}catch{}render();menu.querySelectorAll('[data-workspace-id]').forEach(row=>{if(row.dataset.workspaceId===id)row.focus();});}
 function render(){
  const list=ordered(),current=list.find(item=>item.id===select.value);trigger.disabled=select.disabled;label.textContent=current?.title??'Çalışma alanı seç';avatar.textContent=current?.title?.slice(0,1).toLocaleUpperCase('tr-TR')??'↻';
  menu.replaceChildren();for(const [index,item] of list.entries()){
   const row=document.createElement('button'),icon=document.createElement('span'),copy=document.createElement('strong'),hint=document.createElement('kbd'),check=document.createElement('span');
   row.type='button';row.className='workspace-switcher-row';row.dataset.workspaceId=item.id;row.setAttribute('role','menuitem');row.setAttribute('aria-current',String(item.id===select.value));
   icon.className='workspace-switcher-avatar';icon.setAttribute('aria-hidden','true');icon.textContent=item.title.slice(0,1).toLocaleUpperCase('tr-TR');copy.textContent=item.title;hint.className='workspace-switcher-hint';hint.textContent=index<LIMIT?`${modifier}${index+1}`:'';check.className='workspace-switcher-check';check.setAttribute('aria-hidden','true');check.textContent=item.id===select.value?'✓':'';
   row.append(icon,copy,hint,check);row.onclick=()=>{if(!suppressClick)choose(item.id,true);};
   row.onpointerdown=event=>{if(event.button===0)drag={id:item.id,x:event.clientX,y:event.clientY,row,moved:false};};
   menu.append(row);
  }
 }
 document.addEventListener('pointermove',event=>{if(!drag)return;if(!drag.moved&&Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>4){drag.moved=true;drag.row.classList.add('dragging');}if(drag.moved)event.preventDefault();});
 document.addEventListener('pointerup',event=>{if(!drag)return;const current=drag;drag=null;current.row.classList.remove('dragging');if(!current.moved)return;suppressClick=true;setTimeout(()=>{suppressClick=false;},0);const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('.workspace-switcher-row');if(target)reorder(current.id,target.dataset.workspaceId);});
 document.addEventListener('pointercancel',()=>{drag?.row.classList.remove('dragging');drag=null;});
 trigger.onclick=()=>menu.hidden?open():close(true);
 menu.onkeydown=event=>{
  if(event.key==='Escape'){event.preventDefault();close(true);return;}
  const list=rows(),current=list.indexOf(document.activeElement);
  if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();const target=list[current+(event.key==='ArrowDown'?1:-1)];if(current>=0&&target)reorder(list[current].dataset.workspaceId,target.dataset.workspaceId);return;}
  if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?list.length-1:(current+(event.key==='ArrowDown'?1:-1)+list.length)%list.length;list[next]?.focus();
 };
 document.addEventListener('pointerdown',event=>{if(!menu.hidden&&!menu.contains(event.target)&&!trigger.contains(event.target))close();});
 document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||document.querySelector('dialog[open]'))return;
  const index=shortcutIndex(event,mac),item=index>=0?ordered()[index]:null;
  if(!item||select.disabled)return;event.preventDefault();choose(item.id);
 },true);
 select.addEventListener('change',render);
 render();return {sync:render};
}
