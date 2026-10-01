import {Telegram} from './telegram-accounts.mjs';
import {WorkspaceSupport,rebindWorkspaceOwners} from './workspace-support.mjs';
export async function registerWorkspaceSupport({data,db,runtime,handle,emit,encryptSecret,decryptSecret}){
 rebindWorkspaceOwners(db.db);
 const store=new WorkspaceSupport(db,runtime);
 const telegram=new Telegram({store,data,encrypt:encryptSecret,decrypt:decryptSecret,changed:id=>emit('changed',{candidateId:id}),
  answer:async(id,question,text)=>{const result=await runtime.answer(id,question,text);emit('changed',{candidateId:id});return result;},
  queueApplication:(id,itemId,token)=>store.queueRecord(id,itemId,token),
  withdrawApplication:(id,itemId)=>runtime.dismissRecord(id,itemId)});
 handle('telegram-status',id=>telegram.status(id));handle('telegram-configure',(id,input)=>telegram.configure(id,input));
 handle('telegram-pair',id=>telegram.pairing(id));handle('telegram-unlink',id=>telegram.unlink(id));handle('telegram-preferences',(id,input)=>telegram.preferences(id,input));handle('telegram-retry',id=>telegram.retry(id));handle('telegram-send-unsent-jobs',id=>telegram.sendUnsentJobs(id));
 await telegram.load();
 return {store,telegram,remove:id=>telegram.removeCandidate(id),close:()=>telegram.stop(),stop:()=>telegram.stop(),resume:()=>telegram.load()};
}
