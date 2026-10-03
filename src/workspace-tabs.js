const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};
const host=url=>{try{return new URL(url).hostname.replace(/^www\./,'');}catch{return null;}};

export function workerTabs(snapshot,workerId,tabs){
 const worker=snapshot.workers?.find(w=>w.id===workerId),runId=worker?.execution?.task?.id;
 if(!worker?.active||!runId)return [];
 const run=snapshot.runs?.find(r=>r.id===runId&&(r.workerId??'main')===workerId&&r.status==='running');
 if(!run)return [];
 // Exact run ownership includes popups and redirects. A legacy checkpoint is
 // safe only while it has no newer owner; same-host and old record tabs are not evidence.
 return tabs.filter(t=>(t.runId===run.id||!t.runId&&t.tabId===run.resumeContext?.tabId)&&(!t.recordId||t.recordId===run.recordId));
}

export function workerTab(snapshot,workerId,tabs){return workerTabs(snapshot,workerId,tabs)[0]??null;}

export function recordTabs(record,tabs,snapshot){
 const run=(snapshot.runs??[]).filter(r=>r.recordId===record.id&&r.resumeContext?.tabId).sort((a,b)=>b.startedAt-a.startedAt)[0];
 const current=tabs.find(t=>t.tabId===run?.resumeContext.tabId&&(!t.recordId||t.recordId===record.id)&&(!t.runId||t.runId===run.id));if(current)return [current];
 const owned=tabs.filter(t=>t.recordId===record.id);if(owned.length)return owned;
 const question=(snapshot.automation.questions??[]).find(q=>q.recordId===record.id&&q.answer==null&&q.browserContext?.tabId);
 const retained=tabs.find(t=>t.tabId===question?.browserContext.tabId&&(!t.recordId||t.recordId===record.id)&&(!t.runId||t.runId===question.browserContext.runId));if(retained)return [retained];
 return [];
}

export function groupWorkspaceTabs(tabs,sources,sourceForTab=()=>null){
 const grouped=new Map(sources.map(source=>[source.id,[]])),other=[];
 for(const tab of tabs){
  let id=tab.sourceUrl?sources.find(source=>source.url===tab.sourceUrl)?.id:sourceForTab(tab);
  if(!tab.sourceUrl&&!grouped.has(id)){
   const matches=sources.filter(source=>host(source.url)&&host(source.url)===host(tab.url));
   if(matches.length===1)id=matches[0].id;
  }
  (grouped.get(id)??other).push(tab);
 }
 return {grouped,other};
}

// Mount a compact tab menu in each source row; polling updates only these menus.
export function workspaceSourceTabs(api,{notice,sourceForTab}={}){
 let owner=null,sources=[],hosts=new Map(),otherHost=null,root=null,tabs=[],openKey=null,closingKey=null,loading=false,version=0;
 function control(target,key,label,items){
  target.replaceChildren();target.hidden=!items.length;if(target.hidden)return;
  target.className=key==='other'?'source-tabs-other':'source-tabs-control';target.dataset.open=String(openKey===key);
  const toggle=el('button',`${label} (${items.length})`,'quiet source-tabs-toggle');toggle.type='button';toggle.disabled=closingKey===key;toggle.setAttribute('aria-expanded',String(openKey===key));
  toggle.onclick=()=>{openKey=openKey===key?null:key;render();};target.append(toggle);
  if(openKey!==key)return;
  const menu=el('ul',null,'source-tabs-menu');menu.setAttribute('aria-label',label);
  for(const tab of items){
   const item=el('li'),button=el('button',null,'source-tab-link'),address=el('span',tab.url,'source-tab-address'),id=owner;
   button.type='button';button.disabled=closingKey===key;button.title=tab.url;button.setAttribute('aria-label',`${tab.url} sekmesine git`);button.append(address);
   button.onclick=async()=>{button.disabled=true;try{await api.focusWorkspaceTab(id,tab.tabId);openKey=null;render();}catch(error){notice(error.message);}finally{button.disabled=false;refresh().catch(()=>{});}};
   item.append(button);menu.append(item);
  }
  const closeItem=el('li'),close=el('button',closingKey===key?'Kapatılıyor…':'Hepsini kapat','source-tabs-close');close.type='button';close.disabled=closingKey===key;
  close.setAttribute('aria-label',`${label} listesindeki ${items.length} sekmenin hepsini kapat`);
  close.onclick=async()=>{
   const id=owner;closingKey=key;render();
   try{
    const result=await api.closeWorkspaceTabs(id,items.map(({tabId,url,sourceUrl})=>({tabId,url,sourceUrl})));
    if(owner===id)tabs=tabs.filter(tab=>!result.closed.includes(tab.tabId));
    if(result.failed.length)notice(`${result.failed.length} sekme kapatılamadı.`);
    else if(owner===id)openKey=null;
   }catch(error){notice(error.message);}
   finally{if(owner===id){closingKey=null;await refresh().catch(error=>notice(error.message));render();}}
  };
  closeItem.append(close);menu.append(closeItem);
  target.append(menu);
 }
 function render(){
  const {grouped,other}=groupWorkspaceTabs(tabs,sources,sourceForTab);
  for(const [id,target] of hosts)control(target,id,'Sekmeler',grouped.get(id)??[]);
  if(otherHost)control(otherHost,'other','Diğer sekmeler',other);
 }
 async function refresh(){
  if(!owner||loading)return;
  const id=owner,request=version;loading=true;
  try{const next=await api.workspaceTabs(id);if(owner===id&&request===version&&JSON.stringify(tabs)!==JSON.stringify(next)){tabs=next;render();}}
  finally{loading=false;}
 }
 setInterval(()=>{if(root?.isConnected&&root.getClientRects().length)refresh().catch(()=>{});},3000);
 return {update(id,nextSources,nextHosts,nextOtherHost,nextRoot){
  const changed=owner!==id;owner=id;sources=nextSources;hosts=nextHosts;otherHost=nextOtherHost;root=nextRoot;
  if(changed){tabs=[];openKey=null;closingKey=null;version++;}
  render();if(changed)refresh().catch(error=>notice(error.message));
 },refresh};
}
