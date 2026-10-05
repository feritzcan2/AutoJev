import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {registerAutomationServices} from '../app/automation-services.mjs';
import {workspaceDirectory} from '../app/workspace-paths.mjs';

test('restoring setup text uses its exact interview identity, never the latest source worker or another workspace',async t=>{
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core),a=db.create('custom'),other=db.create('custom'),calls=[];
 const services=registerAutomationServices({data:'/synthetic-data',db,browsers:{},handle(){},emit(){},agents:{transcript(...args){calls.push(args);return {messages:[]};}}});
 t.after(async()=>{await services.close();core.close();});
 const identity={provider:'codex',nativeId:'33333333-3333-3333-3333-333333333333'};
 db.putRun({id:'setup',automationId:a.id,kind:'interview',workerId:'conversation',status:'completed',conversation:identity});
 for(let i=0;i<40;i++)db.putRun({id:'scan-'+i,automationId:a.id,kind:'run',workerId:'main',status:'completed',conversation:{provider:'codex',nativeId:'source-native'}});
 services.conversationTranscript(a.id);
 assert.deepEqual(calls.at(-1),[a.id,'conversation',{...identity,cwd:workspaceDirectory('/synthetic-data',core.workspaces.get(a.id))}]);
 services.conversationTranscript(other.id);assert.deepEqual(calls.at(-1),[other.id,'conversation',undefined]);
 db.putRun({...db.run('setup'),conversation:null});services.conversationTranscript(a.id);
 assert.equal(calls.at(-1)[2],undefined,'Reset identities are not revived from worker history');
});
