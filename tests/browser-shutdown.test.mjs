import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserTools} from '../app/browser.mjs';
import {JevBrowser} from '../app/jev-browser.mjs';

test('app shutdown closes every owned Chrome target and retains failed targets for recovery',async()=>{
  const client=new JevBrowser('/unused'),closed=[],saved=[];
  client.opening=Promise.resolve({});client.contextId='context';client.connectedEndpoint='ws://chrome';client.homeId='home';
  client.registry={save:async(...args)=>saved.push(args)};
  client.browser={close:async()=>closed.push('disconnect')};
  client.transport={owned:new Set(['home','first','failed']),attached:new Set(),call:async(method,{targetId})=>{
    assert.equal(method,'Target.closeTarget');closed.push(targetId);return {success:targetId!=='failed'};
  },close:()=>closed.push('transport')};
  for(const id of ['home','first','failed','personal'])client.tabs.set(id,{id});
  const result=await client.close({closeTabs:true});
  assert.deepEqual(result,{closed:['first','home'],failed:['failed']});
  assert.deepEqual(closed,['first','failed','home','transport','disconnect']);
  assert.deepEqual(saved.at(-1)[2],new Set(['failed']));
});

test('ordinary browser disconnect preserves owned tabs',async()=>{
  const client=new JevBrowser('/unused'),closed=[];
  client.opening=Promise.resolve({});client.browser={close:async()=>closed.push('disconnect')};
  client.transport={owned:new Set(['owned']),call:async()=>assert.fail('Tab closure was not requested'),close:()=>closed.push('transport')};
  assert.deepEqual(await client.close(),{closed:[],failed:[]});
  assert.deepEqual(closed,['transport','disconnect']);
});

test('app shutdown reports closed tab IDs to the workspace before clearing clients',async()=>{
  const browser=new BrowserTools('/unused'),client=new JevBrowser('/unused'),events=[];
  client.close=async options=>{events.push(options);return {closed:['one','two'],failed:[]};};
  browser.clients.set('workspace',{pending:Promise.resolve({client})});
  browser.onTabsClosed=(id,ids)=>events.push({id,ids});
  await browser.close({closeTabs:true});
  assert.deepEqual(events,[{closeTabs:true},{id:'workspace',ids:['one','two']}]);
  assert.equal(browser.clients.size,0);
});
