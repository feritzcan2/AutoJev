// Local, synthetic UI fixture. Open the printed URL and exercise the real
// attention panel; no provider, real browser tabs or user database is used.
import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WebTasks} from '../app/web-template.mjs';

const store=new WorkspaceDatabase(':memory:'),db=new AutomationStore(store),events=[],launches=[];
const sources=['https://reply.example/','https://resolved.example/','https://close.example/','https://working.example/'];
const runtime=new WebTasks(db,{launch:async run=>{launches.push(run);return {close:async()=>{}};},onRunFinished:async(id,run,options)=>{if(options.sourceAccessReset)events.push({action:'closed',source:run.sourceUrl});return {closed:['synthetic-tab']};}});
const a=db.create('housing',{title:'Erişim beklemesi · sentetik test',goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources});
db.review(a.id);const trial=db.begin(a.id,'trial');for(const url of sources)db.observe(a.id,trial.id,url,'Listings');db.finish(a.id,trial.id,'completed','Ready');db.enable(a.id);
for(const url of sources){
 const task=store.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:url,sources:[url],lockKey:'source:'+url}),run=await runtime.start(a.id,{kind:'run',taskId:task.id});
 if(url===sources[3])break;
 const wait=db.siteAccess.block(url,'verification');db.putRun({...db.run(run.id),siteWait:wait,resumeContext:{url,tabId:'synthetic-tab'}});runtime.report(a.id,run.id,'blocked','Erişim doğrulaması gerekiyor.');await runtime.finish(a.id,'blocked',wait.message);
}
store.workspaces.workers.add(a.id);store.workspaces.workers.add(a.id);
const html=`<!doctype html><html lang="tr"><meta charset="utf-8"><title>Kaynak beklemesi testi</title><link rel="stylesheet" href="/src/automations.css"><style>body{background:#151820;color:#eee;font:15px system-ui;margin:0;padding:32px}main{max-width:1000px;margin:auto}button{cursor:pointer;background:#333c50;color:white;border:1px solid #667088;border-radius:8px;padding:10px}textarea{display:block;width:95%;background:#222a38;color:white}#audit{white-space:pre-wrap;border-top:1px solid #666;padding-top:20px}.automation-help-instructions{color:#c3cbd8}[hidden]{display:none!important}</style><body class="automation-workspace"><main><header><h1>Kaynak beklemesi testi</h1><p>Üç müdahale kartı; başka kaynakta çalışan bir worker.</p></header><div id="now-panel"></div><pre id="audit" aria-label="Test sonucu"></pre></main><script type="module">
import {automationAttentionPanel} from '/src/automation-attention.js';
const call=async(name,...args)=>{const r=await fetch('/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args})});const result=await r.json();if(result.error)throw Error(result.error);return result;};
const api={automationSourceResume:(...a)=>call('resume',...a),automationAttentionDismiss:(...a)=>call('dismiss',...a),automationRetryLater:(...a)=>call('later',...a),workspaceTabs:async()=>[],terminalMessage:()=>{throw Error('Wrong worker route');}};
const refresh=async()=>{const state=await(await fetch('/state')).json();panel.update(state.automation.id,state);document.querySelector('#audit').textContent=state.audit;};
const panel=automationAttentionPanel(api,{navigate:()=>{},refresh});await refresh();
</script></html>`;
const server=http.createServer(async(req,res)=>{
 try{
  if(req.url==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end(html);return;}
  if(req.url==='/state'){
   const snapshot=db.snapshot(a.id);res.setHeader('content-type','application/json');res.end(JSON.stringify({...snapshot,activeRuns:runtime.slots(a.id).map(s=>s.run),audit:[...events.map(e=>e.action+' '+e.source),...launches.filter(r=>r.continuation?.reason==='site_access_response').map(r=>'resumed '+r.sourceUrl),...runtime.slots(a.id).map(s=>'working '+s.run.sourceUrl)].join('\n')}));return;
  }
  if(req.url==='/call'&&req.method==='POST'){
   let body='';for await(const chunk of req){body+=chunk;if(body.length>20000)throw Error('Request too large');}const {name,args}=JSON.parse(body);
   if(args[0]!==a.id)throw Error('Unknown fixture');
   const handlers={resume:(...values)=>runtime.sourceAccess.resume(...values),dismiss:(...values)=>runtime.dismissAttention(...values),later:(...values)=>runtime.retryLater(...values)};
   if(!handlers[name])throw Error('Unknown action');const result=await handlers[name](...args);res.setHeader('content-type','application/json');res.end(JSON.stringify(result));return;
  }
  const url=new URL(req.url,'http://localhost'),file=path.resolve('.'+url.pathname);
  if(!file.startsWith(process.cwd()+path.sep)||!/^\/(?:src|app)\/[\w/-]+\.(?:m?js|css)$/.test(url.pathname)){res.writeHead(404);res.end();return;}
  res.setHeader('content-type',file.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(file));
 }catch(error){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
server.listen(0,'127.0.0.1',()=>console.log('Source access UI fixture: http://127.0.0.1:'+server.address().port));
process.on('SIGTERM',async()=>{server.close();await runtime.close();store.close();});
