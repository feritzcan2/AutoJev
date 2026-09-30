import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {transcriptMessage,TranscriptReader,claudeProjectDirectory} from '../app/agent-transcript.mjs';

test('Claude assistant and user text records become chat messages; tools and sidechains do not',()=>{
 const id='11111111-1111-1111-1111-111111111111';
 assert.deepEqual(transcriptMessage('claude',{type:'assistant',uuid:'a',timestamp:'2026-09-30T10:00:00.000Z',sessionId:id,message:{content:[{type:'text',text:'Şu an 13. sayfadayım.'},{type:'tool_use',name:'x'}]}},id),{id:'a',role:'agent',text:'Şu an 13. sayfadayım.',at:'2026-09-30T10:00:00.000Z'});
 assert.equal(transcriptMessage('claude',{type:'assistant',uuid:'b',sessionId:id,message:{content:[{type:'tool_use',name:'x'}]}},id),null);
 assert.equal(transcriptMessage('claude',{type:'assistant',uuid:'c',sessionId:id,isSidechain:true,message:{content:[{type:'text',text:'alt'}]}},id),null);
 assert.deepEqual(transcriptMessage('claude',{type:'user',uuid:'d',timestamp:'t',sessionId:id,message:{role:'user',content:'Berlin’e odaklan'}},id),{id:'d',role:'user',text:'Berlin’e odaklan',at:'t'});
 assert.equal(transcriptMessage('claude',{type:'user',uuid:'e',sessionId:id,message:{role:'user',content:[{type:'tool_result',content:'x'}]}},id),null);
 assert.equal(transcriptMessage('claude',{type:'user',uuid:'f',sessionId:id,message:{role:'user',content:'<local-command-stdout>x</local-command-stdout>'}},id),null);
 assert.equal(transcriptMessage('claude',{type:'user',uuid:'g',sessionId:id,message:{role:'user',content:'Read AGENTS.md and go.'}},id,new Set(['Read AGENTS.md and go.'])).role,'task');
});

test('Codex agent and user messages become chat messages',()=>{
 assert.deepEqual(transcriptMessage('codex',{timestamp:'t',type:'event_msg',payload:{type:'agent_message',message:'Sırayla açıyorum.'}},'x'),{id:'t:agent_message',role:'agent',text:'Sırayla açıyorum.',at:'t'});
 assert.deepEqual(transcriptMessage('codex',{timestamp:'t2',type:'event_msg',payload:{type:'user_message',message:'devam'}},'x'),{id:'t2:user_message',role:'user',text:'devam',at:'t2'});
 assert.equal(transcriptMessage('codex',{timestamp:'t',type:'event_msg',payload:{type:'token_count'}},'x'),null);
});

test('Claude project directories encode the workspace path the way Claude Code does',()=>{
 assert.equal(claudeProjectDirectory('/Users/me/Projects/job.loop'),'-Users-me-Projects-job-loop');
});

test('reader tails the transcript incrementally, verifies the workspace, and keeps the latest messages',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'transcript-')),cwd=path.join(root,'work'),id='22222222-2222-2222-2222-222222222222';
 await mkdir(cwd);const dir=path.join(root,'projects',claudeProjectDirectory(cwd));await mkdir(dir,{recursive:true});
 const file=path.join(dir,`${id}.jsonl`);
 const line=(uuid,text,role='assistant')=>JSON.stringify({type:role,uuid,timestamp:'2026-09-30T10:00:00.000Z',sessionId:id,cwd,message:{role,content:[{type:'text',text}]}})+'\n';
 await writeFile(file,line('1','ilk'));
 const reader=new TranscriptReader({provider:'claude',nativeId:id,cwd,claudeRoot:path.join(root,'projects'),limit:2});
 assert.deepEqual((await reader.read()).map(m=>m.text),['ilk']);
 await appendFile(file,line('2','iki')+line('3','üç'));
 assert.deepEqual((await reader.read()).map(m=>m.text),['iki','üç']);
 // A transcript whose records name another workspace is never trusted, even when the file name matches.
 const elsewhere=path.join(root,'elsewhere'),otherDir=path.join(root,'projects',claudeProjectDirectory(elsewhere));await mkdir(otherDir,{recursive:true});
 await writeFile(path.join(otherDir,`${id}.jsonl`),line('9','yabancı'));
 const other=new TranscriptReader({provider:'claude',nativeId:id,cwd:elsewhere,claudeRoot:path.join(root,'projects')});
 assert.deepEqual(await other.read(),[]);
});
