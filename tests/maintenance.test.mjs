import test from 'node:test';
import assert from 'node:assert/strict';
import {Maintenance} from '../app/maintenance.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('maintenance refuses in-flight IPC and blocks new calls while copying',async()=>{
 const events=[],gate=new Maintenance({assertIdle(){},stop:async()=>events.push('stop'),resume:async()=>events.push('resume')});
 const ipc=deferred(),pending=gate.invoke('pick-document',()=>ipc.promise);
 await assert.rejects(gate.run(async()=>events.push('copy')),/Devam eden/);assert.equal(gate.busy,false);
 ipc.resolve();await pending;
 const copy=deferred(),started=deferred();
 const backup=gate.run(async()=>{started.resolve();await copy.promise;events.push('copy');});await started.promise;
 await assert.rejects(gate.invoke('save-profile',()=>assert.fail()),/Yedekleme/);
 await assert.rejects(gate.run(()=>assert.fail()),/Yedekleme/);
 copy.resolve();await backup;assert.deepEqual(events,['stop','copy','resume']);assert.equal(gate.busy,false);
});
test('failure resumes schedulers, restart hold keeps them stopped until release',async()=>{
 let stopped=0,resumed=0;const gate=new Maintenance({assertIdle(){},stop:async()=>stopped++,resume:async()=>resumed++});
 await assert.rejects(gate.run(async()=>{throw Error('disk full');},{hold:true}),/disk full/);
 assert.equal(gate.busy,false);assert.equal(resumed,1);
 await gate.invoke('update-install',()=>gate.run(async()=>{}, {hold:true}));
 assert.equal(gate.busy,true);assert.equal(resumed,1);await gate.release();assert.equal(resumed,2);assert.equal(stopped,2);
 let restart=false;await gate.run(async()=>{}, {hold:()=>restart});assert.equal(gate.busy,false);
 restart=true;await gate.run(async()=>{}, {hold:()=>restart});assert.equal(gate.busy,true);
});
test('live work rejection does not stop services',async()=>{
 const gate=new Maintenance({assertIdle(){throw Error('active agent');},stop:()=>assert.fail(),resume:()=>assert.fail()});
 await assert.rejects(gate.run(()=>assert.fail()),/active agent/);assert.equal(gate.busy,false);
});
