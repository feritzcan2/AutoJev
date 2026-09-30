const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};
const host=url=>{try{return new URL(url).hostname.replace(/^www\./,'');}catch{return null;}};

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
 let owner=null,mode=null,sources=[],hosts=new Map(),otherHost=null,root=null,tabs=[],openKey=null,closingKey=null,loading=false,version=0;
 function control(target,key,label,items){
  target.replaceChildren();target.hidden=mode!=='jev'||!items.length;if(target.hidden)return;
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
  if(!owner||mode!=='jev'||loading)return;
  const id=owner,request=version;loading=true;
  try{const next=await api.workspaceTabs(id);if(owner===id&&request===version&&JSON.stringify(tabs)!==JSON.stringify(next)){tabs=next;render();}}
  finally{loading=false;}
 }
 setInterval(()=>{if(root?.isConnected&&root.getClientRects().length)refresh().catch(()=>{});},3000);
 return {update(id,browserMode,nextSources,nextHosts,nextOtherHost,nextRoot){
  const changed=owner!==id||mode!==browserMode;owner=id;mode=browserMode;sources=nextSources;hosts=nextHosts;otherHost=nextOtherHost;root=nextRoot;
  if(changed){tabs=[];openKey=null;closingKey=null;version++;}
  render();if(changed)refresh().catch(error=>notice(error.message));
 },refresh};
}
