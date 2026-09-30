import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {providerLimit,providerLimitAttention} from '../app/provider-limit.mjs';
import {TerminalScreen} from '../app/terminal-screen.mjs';
import {AgentSessions,publicSession} from '../app/agent-sessions.mjs';
import {terminalAttention} from '../src/agent-attention.js';
import {automationAttention} from '../app/automation-attention.mjs';
import {automationProgress} from '../app/automation-progress.mjs';

const banner="You've hit your session limit · resets 6am (Europe/Istanbul)\r\nUse your only limit reset to reset it now:\r\nclaude.ai/reset\r\n⚠ Usage limit reached · limit resets 6am\r\nContinuing automatically at 6am · esc to cancel\r\nctx 26.0% · auto mode on";
const limit={kind:'usage_limit',provider:'claude',resetLabel:'06:00 (Europe/Istanbul)',automaticResume:true};

test('the displayed Claude limit includes its reported reset time and continuation, independent of Working state',()=>{
 assert.deepEqual(providerLimit(banner,'claude'),limit);
 assert.deepEqual(providerLimit('  ⎿ '+banner,'claude'),limit);
 assert.match(providerLimitAttention(limit).detail,/06:00 \(Europe\/Istanbul\)/);
 assert.equal(terminalAttention(banner,'Working').kind,'usage_limit');
 assert.equal(providerLimit(banner,'codex'),null);
 assert.equal(providerLimit('⚠️ Usage limit reached · limit resets 6:30pm\nContinuing automatically at 6:30pm · esc to cancel','claude').resetLabel,'18:30');
 assert.equal(providerLimit('Usage limit reached · Continuing automatically at 6am · esc to cancel','claude').resetLabel,null,'Do not guess a reset time from another timestamp');
 for(const text of ['The documentation says: Usage limit reached',JSON.stringify({text:banner}),"You've hit your session limit",banner+'\r\n⏺ Continuing with page 55.'])assert.equal(providerLimit(text,'claude'),null);
});

test('split ANSI and UTF-8 output is detected on a narrow rendered screen; overwritten or scrolled-off notices disappear',async t=>{
 const screen=new TerminalScreen({rows:28,cols:40});t.after(()=>screen.dispose());
 const bytes=Buffer.from('\x1b[31m'+banner+'\x1b[0m');for(let i=0;i<bytes.length;i+=3)screen.write(bytes.subarray(i,i+3),i);
 assert.deepEqual(providerLimit(await screen.text(),'claude'),limit);
 screen.write(Buffer.from('\x1b[2J\x1b[H⏺ Processing page 55\r\nWorking…'),1000);assert.equal(providerLimit(await screen.text(),'claude'),null);
 screen.write(Buffer.from('\r\n'+banner+'\r\n'+'Processing listing\r\n'.repeat(40)),1001);assert.equal(providerLimit(await screen.text(),'claude'),null);
});

test('provider session publishes a durable limit event without any agent report and clears it when the live UI resumes',async t=>{
 const data=await mkdtemp(path.join(tmpdir(),'loop-limit-'));let deliver;const events=[];
 const agents=new AgentSessions({root:process.cwd(),data,createEngine:(_binary,_dir,onEvent)=>{deliver=onEvent;return {request:async()=>({}),close:async()=>{}};}});
 t.after(async()=>{await agents.close();await rm(data,{recursive:true,force:true});});
 await agents.start({id:'workspace',sessionId:'limit-session',settings:{provider:'claude',model:'default',permission:'default',reasoning:'default',network:null},cwd:data,runtimeDirectory:data,prompt:'Scan',onEvent:event=>events.push(event)});
 deliver({event:'state',sessionId:'limit-session',state:'Working'});deliver({event:'output',sessionId:'limit-session',bytes:[...Buffer.from(banner)]});
 const session=agents.sessions.get('workspace');await agents.checkUsageLimit(session);
 assert.deepEqual(publicSession(session).usageLimit,limit);assert.equal(agents.contextBusy('workspace'),true);assert.equal(events.filter(e=>e.event==='usage_limit').length,1);
 await agents.checkUsageLimit(session);assert.equal(events.filter(e=>e.event==='usage_limit').length,1,'Repeated redraws do not duplicate the issue');
 deliver({event:'state',sessionId:'limit-session',state:'Idle'});assert.ok(session.usageLimit,'Idle alone does not mean the quota reset');
 deliver({event:'output',sessionId:'limit-session',bytes:[...Buffer.from('\x1b[2J\x1b[H⏺ Reading the next page') ]});
 const until=Date.now()+2500;while(session.usageLimit&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(session.usageLimit,null);assert.equal(agents.contextBusy('workspace'),false);assert.equal(events.filter(e=>e.event==='usage_limit').at(-1).usageLimit,null);
 // Exit immediately after output, without waiting for the normal 200ms probe.
 deliver({event:'output',sessionId:'limit-session',bytes:[...Buffer.from('\x1b[2J\x1b[H'+banner)]});
 await deliver({event:'eof',sessionId:'limit-session'});
 const last=events.filter(e=>['usage_limit','eof'].includes(e.event)).slice(-2);assert.equal(last[0].event,'usage_limit');assert.ok(last[0].usageLimit);assert.equal(last[1].event,'eof');assert.equal(agents.sessions.size,0);
});

test('a live limit appears above source failures and in the progress status with its exact worker',()=>{
 const run={id:'run',kind:'run',workerId:'second',sourceUrl:'https://homes.test/',status:'running',state:'Working',usageLimit:limit,startedAt:1};
 const snapshot={automation:{revision:1,reviewedRevision:1,status:'enabled',trial:{status:'passed',revision:1}},messages:[],runs:[run],activeRuns:[run],sources:[{url:run.sourceUrl,name:'Homes',enabled:true,scanning:true}],workers:[{id:'second',name:'Worker 2'}]};
 const issues=automationAttention(snapshot);assert.equal(issues.length,1);assert.equal(issues[0].kind,'usage_limit');assert.equal(issues[0].workerId,'second');assert.equal(issues[0].name,'Worker 2 · Homes');assert.equal(issues[0].retry,null);assert.equal(issues[0].sessionOpen,true);
 assert.equal(automationProgress(snapshot).label,'Kullanım limiti');
 run.usageLimit=null;assert.equal(automationAttention(snapshot).length,0);
});
