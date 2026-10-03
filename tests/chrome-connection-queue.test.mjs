import test from 'node:test';
import assert from 'node:assert/strict';
import {acquireChromeConnection} from '../app/jev-connection-queue.mjs';

test('cancelled and timed out profile requests leave the active approval and remaining queue intact',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const release=await acquireChromeConnection();t.after(release);
  const abort=new AbortController();
  const cancelled=assert.rejects(acquireChromeConnection({signal:abort.signal}),{name:'AbortError'});
  abort.abort();await cancelled;
  await assert.rejects(acquireChromeConnection({signal:abort.signal}),{name:'AbortError'});
  const timedOut=assert.rejects(acquireChromeConnection(),/sırayla bağlanacak/);
  t.mock.timers.tick(30000);await timedOut;
  let started=false;
  const next=acquireChromeConnection().then(done=>{started=true;return done;});
  await Promise.resolve();assert.equal(started,false);
  release();const finish=await next;t.after(finish);
  // Releasing an old connection twice must not let two profiles activate.
  release();let thirdStarted=false;
  const third=acquireChromeConnection().then(done=>{thirdStarted=true;return done;});
  await Promise.resolve();assert.equal(thirdStarted,false);
  finish();(await third)();
});
