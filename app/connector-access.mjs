import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

// Read provider-owned app metadata only. No Gmail tokens, OAuth client or mail proxy.
export async function withCodexApps(cwd,action,{spawnProcess=spawn,timeoutMs=45000}={}){
 const child=spawnProcess('codex',['app-server','--stdio'],{cwd,stdio:['pipe','pipe','ignore']}),pending=new Map();let counter=0;
 const rejectAll=error=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
 child.on('error',()=>rejectAll(Error('Codex bağlantı servisi başlatılamadı. Codex kurulumunu ve girişini kontrol et.')));
 child.on('exit',()=>rejectAll(Error('Codex bağlantı servisi kapandı.')));
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{let response;try{response=JSON.parse(line);}catch{return;}const item=pending.get(response.id);if(!item)return;pending.delete(response.id);clearTimeout(item.timer);response.error?item.reject(Error(response.error.message??'Codex bağlantı hatası')):item.resolve(response.result);});
 const request=(method,params)=>new Promise((resolve,reject)=>{const id=++counter,timer=setTimeout(()=>{pending.delete(id);reject(Error('Gmail bağlantı kontrolü zaman aşımına uğradı. Tekrar kontrol et.'));},timeoutMs);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});});
 try{await request('initialize',{clientInfo:{name:'jobloop',version:'0.1.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');return await action(request);}
 finally{rejectAll(Error('Bağlantı kontrolü kapandı'));lines.close();child.stdin.end();child.kill();const timer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},2000);timer.unref();child.once('exit',()=>clearTimeout(timer));}
}
export function gmailAccess(app){
 if(!app)return {status:'unavailable',message:'Codex hesabında Gmail bulunamadı. Codex /apps ekranından Gmail erişimini kontrol et.',installUrl:null};
 let installUrl=null;try{const u=new URL(app.installUrl);if(u.protocol==='https:'&&u.hostname==='chatgpt.com'&&!u.username&&!u.password)installUrl=u.toString();}catch{}
 return {appId:app.id,installUrl,status:!app.isAccessible?'missing':!app.isEnabled?'disabled':'available',message:!app.isAccessible?'Gmail bu Codex hesabına bağlı değil. Bağlantıyı tamamlayıp tekrar kontrol et.':!app.isEnabled?'Gmail bağlı, fakat Codex ayarlarında devre dışı. Codex /apps ekranından etkinleştir.':'Gmail bağlantısı kullanılabilir. Skill çalışırken doğru posta hesabı ayrıca doğrulanacak.'};
}
export async function inspectGmailAccess(provider,cwd,options){
 if(provider!=='codex')return {status:'provider_setup',message:'Bu aday Claude kullanıyor. Gmail MCP bağlantısını Claude terminal ayarlarında kur; ardından Yeniden dene ile doğrula. Codex Gmail bağlantısı Claude’a aktarılmaz.',installUrl:null};
 return withCodexApps(cwd,async request=>{let cursor=null;for(let page=0;page<20;page++){const result=await request('app/list',{cursor,limit:100,forceRefetch:page===0});const gmail=result.data?.find(app=>/^gmail$/i.test(app.name));if(gmail)return gmailAccess(gmail);if(!result.nextCursor)break;cursor=result.nextCursor;}return gmailAccess(null);},options);
}
