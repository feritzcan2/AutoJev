import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// One bounded, cancellable CLI request. Bodies travel only through IPC/RAM.
export async function readCollectorCliPage(url,{signal,forkProcess=fork}={}){
 return readCollectorCliRequest({searches:[{id:'page',url}],maxPages:1},{signal,forkProcess});
}
export async function readCollectorCliDetail(url,options={}){
 const page=await readCollectorCliRequest({detailUrl:url},options);
 if(page.jobs?.length!==1||page.jobs[0].url!==url)throw Error('Toplayıcı beklenen tekil ilanı döndürmedi.');
 return page.jobs[0];
}
async function readCollectorCliRequest(input,{signal,forkProcess=fork}={}){
 signal?.throwIfAborted();
 const child=forkProcess(fileURLToPath(new URL('./collect-cli.mjs',import.meta.url)),['--worker'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','pipe','ipc'],execArgv:[]});
 return new Promise((resolve,reject)=>{
  let page,done=false,failure,stderr='',killTimer;
  const stop=error=>{failure??=error;child.kill();killTimer??=setTimeout(()=>child.kill('SIGKILL'),2000);};
  const abort=()=>stop(signal.reason??Error('Toplama iptal edildi.'));
  const timer=setTimeout(()=>stop(Error('Toplayıcı zaman aşımına uğradı; sayfa tamamlanmadı.')),120000);
  const send=value=>child.send(value,error=>{if(error)stop(error);});
  const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
  child.stderr?.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000);});
  child.on('message',message=>{
   if(failure)return;
   if(message.type==='page'&&!page){page=message.page;send({type:'ack'});}
   else if(message.type==='done'&&page)done=true;
   else stop(Error(message.type==='error'?message.message:'Toplayıcıdan beklenmeyen yanıt geldi.'));
  });
  child.once('error',error=>{if(!child.pid){cleanup();reject(error);}else stop(error);});
  child.once('exit',code=>{cleanup();if(failure)reject(failure);else if(code!==0||!done||!page)reject(Error(`Toplayıcı sayfayı tamamlamadı (${code}). ${stderr}`));else resolve(page);});
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();else send({type:'start',input});
 });
}
