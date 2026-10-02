import test from 'node:test';
import assert from 'node:assert/strict';
import {coalesceRefresh} from '../src/refresh-queue.js';

test('change bursts share one read and keep a change that arrives during it',async()=>{
 let calls=0,active=0,peak=0,release;
 const waiting=new Promise(resolve=>release=resolve);
 const refresh=coalesceRefresh(async()=>{calls++;peak=Math.max(peak,++active);if(calls===1)await waiting;active--;});
 const first=refresh();assert.equal(refresh(),first);
 await Promise.resolve();assert.equal(calls,1);
 for(let i=0;i<50;i++)assert.equal(refresh(),first);
 release();await first;assert.equal(calls,2);assert.equal(peak,1);
 await refresh();assert.equal(calls,3);
});

test('a failed read releases the refresh queue for a later attempt',async()=>{
 let fail=true,calls=0;
 const refresh=coalesceRefresh(async()=>{calls++;if(fail)throw Error('Read failed');});
 const first=refresh();assert.equal(refresh(),first);await assert.rejects(first,/Read failed/);
 fail=false;await refresh();assert.equal(calls,2);
});
