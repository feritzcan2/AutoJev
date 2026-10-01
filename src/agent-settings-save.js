// Capture the affected workers before saving: browser changes can stop them.
export async function saveAgentSettings({api,owner,input,confirmRestart,onSaved=()=>{}}){
 const before=await api.workspaceSnapshot(owner);
 const browserChanged=input.browserMode!==undefined||input.chromeProfile!==undefined;
 const workers=(before.workers??[]).filter(worker=>(worker.active||worker.execution?.task)&&(!worker.conversation||browserChanged));
 await api.workspaceSettings(owner,input);
 await onSaved();
 if(!workers.length)return {restarted:0,failed:[]};
 if(!await confirmRestart(workers.length))return {deferred:true,restarted:0,failed:[]};
 let restarted=0;const failed=[];
 // Workspace mutations are serialized by the backend.
 for(const worker of workers){
  try{await api.restartWorker(owner,worker.id);restarted++;}
  catch(error){failed.push(`${worker.name??worker.id}: ${error.message}`);}
 }
 return {restarted,failed};
}

export function createAgentRestartDialog(){
 const dialog=document.createElement('dialog');dialog.id='agent-settings-restart-dialog';
 dialog.setAttribute('aria-labelledby','agent-settings-restart-title');
 dialog.innerHTML='<form method="dialog"><h2 id="agent-settings-restart-title">Agent’ler yeniden başlatılsın mı?</h2><p data-message></p><p>Devam eden işler kesilir ve yeni ayarlarla yeni oturumlar açılır. Kayıtlı ilerleme korunur.</p><div class="workspace-dialog-actions"><button class="quiet" value="later" autofocus>Daha sonra</button><button class="primary" value="restart">Yeniden başlat</button></div></form>';
 document.body.append(dialog);
 return count=>new Promise(resolve=>{
  dialog.querySelector('[data-message]').textContent=`Ayarlar kaydedildi. Bu çalışma alanındaki ${count} açık agent yeniden başlatılsın mı?`;
  dialog.returnValue='later';dialog.addEventListener('close',()=>resolve(dialog.returnValue==='restart'),{once:true});dialog.showModal();
 });
}
