const value=result=>{
 if(result?.isError)throw Error('Sayfa kontrolü başarısız.');
 const text=result?.content?.find(p=>p.type==='text')?.text;
 return JSON.parse(text);
};

// Use the managed browser and its login state, without model calls or site
// interactions. Only the disposable tab created by this check can be closed.
export async function checkSourceBrowser(client,id,task){
 const url=(task.technicalRecovery?.urls??[]).find(u=>/^https?:\/\//.test(u))??task.scan?.pendingUrls?.[0]??task.sourceUrl;
 const owner=`source-check:${task.id}`,before=new Set(client.tabs.keys());
 const state={automationWorkspaceId:id,automationTabKey:`source:${task.sourceUrl}`,automationSourceUrl:task.sourceUrl,automationSourceUrls:[task.sourceUrl],automationFreshTab:true};
 try{
  let page=value(await client.callTool({name:'browser_jev_open',arguments:{url}},owner,state));
  if(page.siteWait)return {ready:false,evidence:page.siteWait.message??'Kaynak erişimi bekleniyor.'};
  if(page.navigationError)throw Error(page.navigationError);
  if(!page.tabId)throw Error('Kontrol sekmesi açılamadı.');
  const tab=client.tabs.get(page.tabId);
  if(!tab||before.has(tab.id))throw Error('Ayrı kontrol sekmesi oluşturulamadı.');
  page=value(await client.callTool({name:'browser_jev_observe',arguments:{tabId:tab.id,scope:'document',full:true,fullReason:'context_loss'}},owner,state));
  const ready=!page.siteWait&&!page.navigationError&&!page.reading?.readiness?.loading&&/^https?:\/\//.test(page.url??'')&&Boolean(page.text?.trim())&&!(tab.http?.status>=500);
  return {ready,evidence:ready?'Kaydedilen adres yönetilen tarayıcıda tekrar okunabiliyor.':'Kaydedilen adres hâlâ yüklenemiyor.'};
 }catch(error){return {ready:false,evidence:error.message};}
 finally{
  for(const slot of client.tabs.values())if(!before.has(slot.id)&&client.automationRuns.get(slot.id)===owner){
   try{await slot.page.close({runBeforeUnload:false});client.forgetTab(slot.id);}catch{}
  }
  await client.persistTabs().catch(()=>{});
 }
}
