// Adapt the existing Jev engine to the scoped automation browser tools.
// Run ownership and step limits stay in automationWorkflow; the agent assesses authority.
export function automationBrowser(browser,{mode='separate',readTabKey,sourceUrl,sourceUrls=[]}={}){
 if(mode!=='jev')return browser;
 let tabId=null;
 const value=response=>{
  if(response?.isError)throw Error(response.content?.filter(p=>p.type==='text').map(p=>p.text).join('\n')||'Jev adımı tamamlanamadı');
  for(const part of response?.content??[]){if(part.type!=='text')continue;try{return JSON.parse(part.text);}catch{}}
  throw Error('Jev sayfa yanıtı okunamadı');
 };
 const ready=async id=>{
  const state=browser.prepare(id);if(state.ready)return;
  await browser.connections.pending.get(id);
  const current=browser.status(id);if(!current.ready)throw Error(current.message||'Jev için Chrome bağlantısını aç ve bağlantı isteğine izin ver.');
 };
 const native=async(id,name,args,session,options)=>{await ready(id);const response=await browser.call(id,name,args,session,{...options,automationWorkspaceId:id,...(readTabKey?{automationTabKey:readTabKey}:{}),...(sourceUrl?{automationSourceUrl:sourceUrl,automationSourceUrls:sourceUrls}:{})}),page=value(response);if(page.status==='browser_wait')throw Error('Jev Chrome bağlantısı bekliyor. Tarayıcıyı aç düğmesinden yeniden bağlan.');return {response,page};};
 const observed=({response,page})=>({pageContext:{url:page.url,tabId:page.tabId},content:[{type:'text',text:(page.url?`Page URL: ${page.url}\n`:'')+JSON.stringify(page)},...(response.content??[]).filter(p=>p.type!=='text')],action:{status:page.status,executed:page.executed,verified:page.verified,message:page.message}});
 return {waitForOperations:id=>browser.waitForOperations(id),async currentUrl(id){
  await ready(id);if(!tabId)throw Error('Önce bir sayfa aç');
  // Reading the URL must not invalidate Jev's one-use pending decision.
  return (await browser.connect(id)).client.tab(tabId).page.url();
 },async call(id,name,args,session,options){
  if(name==='browser_jev_tabs'){
   const {page}=await native(id,name,{},session,options);
   return {tabs:page.tabs??[],currentTabId:tabId};
  }
  if(name==='browser_jev_use_tab'){
   const result=await native(id,'browser_jev_observe',{tabId:args.tabId,scope:'document',full:true,fullReason:'context_loss'},session,options);
   tabId=result.page.tabId;return observed(result);
  }
  if(name==='browser_jev_close_tab'){
   const {page}=await native(id,name,{tabId:args.tabId},session,options);
   if(page.closed&&tabId===args.tabId)tabId=null;
   return {...page,currentTabId:tabId};
  }
  if(name==='browser_navigate'){
   if(readTabKey){
    const result=await native(id,'browser_jev_open',{url:args.url},session,{automationPreferredTabId:tabId});
    tabId=result.page.tabId;if(!tabId)throw Error('Jev sekmesi açılamadı');return observed(result);
   }
   const {page:tabs}=await native(id,'browser_jev_tabs',{},session),existing=tabs.tabs?.find(t=>t.url===args.url);
   const result=await native(id,existing?'browser_jev_observe':'browser_jev_open',existing?{tabId:existing.tabId,full:true,fullReason:'context_loss'}:{url:args.url},session);
   tabId=result.page.tabId;if(!tabId)throw Error('Jev sekmesi açılamadı');return observed(result);
  }
  if(!tabId)throw Error('Önce bu tur için browser_open veya research_automation_source ile bir sayfa aç');
  let tool,parameters={tabId};
 if(name==='browser_snapshot'){tool='browser_jev_observe';Object.assign(parameters,{scope:'document',full:true,fullReason:'context_loss'});}
  else if(name==='browser_click'){tool='browser_jev_click';parameters.targetId=args.target;}
  else if(name==='browser_type'){tool='browser_jev_fill_fields';parameters.fields=[{fieldId:args.target,text:args.text}];}
  else if(name==='browser_select_option'){tool='browser_jev_select_option';Object.assign(parameters,{controlId:args.target,option:args.values[0]});}
  else if(name==='browser_jev_next'){tool=name;parameters.goal=args.goal;}
  else if(name==='browser_jev_act'){tool=name;Object.assign(parameters,args);}
  else if(name==='browser_jev_options'){tool='browser_jev_list_options';parameters.controlId=args.ref;}
  else if(name==='browser_jev_scroll'){tool=name;Object.assign(parameters,{controlId:args.controlId,direction:args.direction});}
  else if(name==='browser_target_press'){tool=name;Object.assign(parameters,{ref:args.ref,key:args.key});}
  else if(['browser_jev_list_suggestions','browser_jev_autocomplete'].includes(name)){tool=name;parameters.controlId=args.controlId;if(args.text!==undefined)parameters.text=args.text;if(args.option!==undefined)parameters.option=args.option;}
  else throw Error('Jev için gözlenen hedefi kullan veya browser_jev_next ile bir adım önerisi al');
  return observed(await native(id,tool,parameters,session,options));
 }};
}
