import test from 'node:test';
import assert from 'node:assert/strict';
import {chromeWindowMarker} from '../app/jev-chrome.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';

const focus=(marker,focused=true,origin=new URL(marker.url).origin)=>fetch(marker.url+(focused?'/focused':'/blurred'),{method:'POST',headers:{Origin:origin}});

test('window readiness requires focus from its own page, and a late focus can recover a timed out wait',async t=>{
  const marker=await chromeWindowMarker({observeFocus:true});t.after(()=>marker.close());
  const response=await fetch(marker.url);assert.equal(response.status,200);
  assert.match(await response.text(),/document\.hasFocus\(\)/);
  assert.equal((await focus(marker,true,'https://unrelated.example')).status,404);
  await assert.rejects(marker.waitForReady({timeout:20}),/profili hazır değil/);
  await focus(marker);await marker.waitForReady({timeout:20});
  await focus(marker,false);await assert.rejects(marker.waitForReady({timeout:20}),/profili hazır değil/);
  await focus(marker);await marker.waitForReady({timeout:20});
});

test('window readiness is cancellable and markers cannot complete one another',async t=>{
  const first=await chromeWindowMarker({observeFocus:true}),second=await chromeWindowMarker({observeFocus:true});
  t.after(()=>{first.close();second.close();});
  await focus(second);await second.waitForReady();
  const abort=new AbortController(),pending=first.waitForReady({signal:abort.signal}),rejected=assert.rejects(pending,{name:'AbortError'});
  abort.abort();await rejected;
  await assert.rejects(first.waitForReady({signal:abort.signal}),{name:'AbortError'});
  const closing=first.waitForReady(),closed=assert.rejects(closing,/kapandı/);first.close();await closed;
});

test('a failed connection retries the same selected window instead of opening more windows',async t=>{
  let windows=0,marker;
  const browser=new JevBrowser('/unused',{profile:{directory:'Profile 2'},openWindow:async(url,profile)=>{
    assert.equal(profile.directory,'Profile 2');windows++;marker={url};await focus(marker);
  },endpoint:async()=>{throw Error('Synthetic endpoint unavailable');}});
  t.after(()=>browser.close());
  await assert.rejects(browser.context(),/Synthetic endpoint unavailable/);
  await assert.rejects(browser.context(),/Synthetic endpoint unavailable/);
  assert.equal(windows,1);
  await browser.close();await assert.rejects(fetch(marker.url));
});
