import {appendFileSync} from 'node:fs';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../app/store.mjs';
import {Engine} from '../app/engine.mjs';
import {startMcp} from '../app/mcp.mjs';
const dir=await mkdtemp(join(tmpdir(),'jobloop-resume-')),store=new Store(join(dir,'test.sqlite'));
const p=store.saveProfile({name:'Resume test',preferences:'Local test only. Do not browse or apply.',authorization:'research'});
await writeFile(join(dir,'AGENTS.md'),'Local integration test. No job search, browser, or external actions. Follow the test prompt.');
await mkdir(join(dir,'runtime'));
let engine,identity,state,working=false;
const mcp=await startMcp(store,()=>{},h=>engine.request('hook',{token:h.token,observation:h.observation}));
async function launch(resumeId,prompt){
 state='';working=false;const sessionId=randomUUID();
 engine=new Engine(resolve('engine/target/debug/jobloop-engine'),join(dir,'processes'),e=>{if(e.event==='diagnostic')console.log(e.text);if(e.event==='output')appendFileSync(join(dir,'terminal.log'),Buffer.from(e.bytes));if(e.event==='state')console.log('STATE',e.state);if(e.event==='identity')identity=e.nativeId;if(e.event==='state'){state=e.state;if(state.includes('Working'))working=true;}if(e.event==='error')console.error(e.error);});
 await engine.request('start',{sessionId,cwd:dir,runtimeDirectory:join(dir,'runtime'),endpoint:mcp.endpoint,token:mcp.grant(p.id,sessionId),provider:'codex',model:'gpt-5.6-sol',permission:'bypassPermissions',reasoning:'low',resumeId,prompt,rows:30,cols:120});
 await new Promise(r=>setTimeout(r,2000));if(!working)await engine.request('input',{text:'\r'});
}
async function until(fn){const end=Date.now()+90000;while(!fn()){if(Date.now()>end)throw Error('Timeout: '+state);await new Promise(r=>setTimeout(r,250));}}
try{
 const code=randomUUID();
 await launch(null,`Remember this test code in this conversation: ${code}. Reply READY only; do not use tools or write files.`);
 await until(()=>identity&&working&&state.includes('Idle'));const first=identity;console.log('FIRST_TURN_READY');await engine.close().catch(e=>console.log('CLOSE',e.message));
 await launch(first,'Resume verification: call jobloop ask_candidate with exactly the test code from our previous turn as the question. Do not look at files or other sessions. Then finish.');
 await until(()=>store.questions(p.id).some(q=>q.question===code));
 if(identity!==first)throw Error('Native identity changed');console.log('RESUME_HISTORY_PASS');
}finally{await engine?.close().catch(()=>{});await mcp.close();store.close();}
