import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../app/store.mjs';
import {BackgroundStore} from '../app/background-store.mjs';
import {BackgroundJobs} from '../app/background.mjs';
import {startMcp} from '../app/mcp.mjs';
import {launchSkillWorker} from '../app/background-worker.mjs';
const data=await mkdtemp(path.join(tmpdir(),'jobloop-background-agent-')),store=new Store(path.join(data,'test.sqlite')),db=new BackgroundStore(store);
const p=store.saveProfile({name:'Synthetic Mail Test',preferences:'Backend Berlin',facts:'E-posta: synthetic@example.com',authorization:'research',agentSettings:{provider:process.env.JOBLOOP_TEST_PROVIDER||'codex',model:process.env.JOBLOOP_TEST_PROVIDER==='claude'?'sonnet':'gpt-5.6-sol',permission:'bypassPermissions',reasoning:'low',network:process.env.JOBLOOP_TEST_PROVIDER==='claude'?null:true}});
const job=store.addJob(p.id,{company:'Synthetic Company',role:'Backend Engineer',location:'Berlin',url:'https://example.com/synthetic-job',fit:'Test fixture'}).job;const object=(properties={})=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
let searches=0,reads=0;
const connector=await startMcp(store,()=>{},async()=>({}),null,null,{tools:[
 {name:'gmail_get_profile',description:'Read the connected Gmail account identity.',inputSchema:object()},
 {name:'gmail_search_emails',description:'Search application email in the connected Gmail account. Synthetic fixture has one page.',inputSchema:object({query:{type:'string',minLength:1,maxLength:2000}})},
 {name:'gmail_read_email',description:'Read the full Gmail email and its source link, without modifying it.',inputSchema:object({messageId:{type:'string',minLength:1,maxLength:2000}})}
],call:(id,session,name,args)=>{
 if(name==='gmail_get_profile')return{emailAddress:'synthetic@example.com'};
 if(name==='gmail_search_emails'){searches++;return{messages:[{id:'testmail1',threadId:'thread1',subject:'Synthetic Company: Backend Engineer interview'}],nextPageToken:null};}
 if(name==='gmail_read_email'){reads++;if(args.messageId!=='testmail1')throw Error('Unknown message');return{id:'testmail1',threadId:'thread1',date:'2026-09-25T10:00:00Z',subject:'Synthetic Company: Backend Engineer interview',url:'https://mail.google.com/mail/u/0/#all/thread1',from:'recruiter@example.com',text:'Thank you for applying for Backend Engineer at Synthetic Company. We invite you to a first interview next week. This is synthetic test data.'};}
 throw Error('Unknown fixture tool');
}});
const connectorToken=connector.grant(p.id,'fixture'),workspace=path.join(data,'background','workspaces',p.id);
await mkdir(path.join(workspace,'.codex'),{recursive:true});await mkdir(path.join(workspace,'.claude'),{recursive:true});
await writeFile(path.join(workspace,'.codex/config.toml'),`[mcp_servers.gmail_fixture]\nurl = "${connector.endpoint}"\nhttp_headers = { Authorization = "Bearer ${connectorToken}" }\n`);
await writeFile(path.join(workspace,'.mcp.json'),JSON.stringify({mcpServers:{gmail_fixture:{type:'http',url:connector.endpoint,headers:{Authorization:`Bearer ${connectorToken}`}}}}));
await writeFile(path.join(workspace,'.claude/settings.local.json'),JSON.stringify({enableAllProjectMcpServers:true}));
let output='',manager;manager=new BackgroundJobs(db,{launch:(run,task,onEvent,signal)=>launchSkillWorker({root:process.cwd(),data,db,run,task,onEvent,signal,complete:(...args)=>manager.complete(...args),onOutput:bytes=>{output=(output+Buffer.from(bytes).toString()).slice(-12000);}})});
let trustApprovals=0;
async function waitForRun(run){const deadline=Date.now()+110000;let trusted=false;while(manager.active.size&&Date.now()<deadline){
 // Only this synthetic workspace is approved by the test; production shows the provider prompt to its user.
 const plain=output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,' ');
 if(process.env.JOBLOOP_TEST_PROVIDER==='claude'&&!trusted&&/Yes,\s+I\s+trust\s+this\s+folder/.test(plain)){trusted=true;trustApprovals++;await new Promise(r=>setTimeout(r,2000));
  for(let attempt=0;attempt<5;attempt++){
   const screen=output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,' '),selection=screen.slice(screen.lastIndexOf('❯'));
   if(/^❯\s+Yes,\s+I\s+trust/.test(selection)){await manager.active.get(p.id).worker.input('\r');break;}
   await manager.active.get(p.id).worker.input('\x1b[B');await new Promise(r=>setTimeout(r,1000));
  }
 }
 await new Promise(r=>setTimeout(r,500));
}const result=db.run(run.id);if(result.status!=='completed')throw Error(`${result.status}: ${result.summary}\n${output}`);return result;}
try{const result=await waitForRun(await manager.start(p.id));if(db.signals(p.id).length!==1||db.signals(p.id)[0].jobId!==job.id||db.signals(p.id)[0].outcome!=='interview')throw Error('Incorrect mail classification');output='';await waitForRun(await manager.start(p.id));if(db.signals(p.id).length!==1)throw Error('Duplicate mail result');if(searches<2||reads<1)throw Error('Existing connector was not actually used');if(trustApprovals>1)throw Error('Workspace trust repeated');if(store.conversation(p.id,p.agentSettings.provider)!==null)throw Error('Main conversation was changed');console.log('LIVE_GMAIL_CONNECTOR_AGENT_PASS',data,result.summary);}finally{await manager.close();await connector.close();store.close();}
