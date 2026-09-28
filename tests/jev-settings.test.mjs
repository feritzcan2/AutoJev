import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {JevSettings} from '../app/jev-settings.mjs';

function fixture(options={}){
 const db=new DatabaseSync(':memory:');
 const settings=new JevSettings(db,{encrypt:value=>Buffer.from(value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString(),config:async()=>({model:'jev-latest'}),now:()=>123,...options});
 return {db,settings,close:()=>db.close()};
}
test('Jev saves an app-wide encrypted key, returns metadata only and preserves it on model edits',async()=>{
 const f=fixture();try{
  const result=await f.settings.save({apiKey:'secret-test-key',model:'jev-latest'});
  assert.equal(result.configured,true);assert.equal(result.source,'secure');assert.equal(result.saved,true);
  assert.equal(JSON.stringify(result).includes('secret-test-key'),false);assert.equal(JSON.stringify(result).includes('ciphertext'),false);
  assert.notEqual(f.settings.row().ciphertext,'secret-test-key');
  await f.settings.save({apiKey:'',model:'jev-1.13.0'});
  assert.deepEqual(await f.settings.config(),{apiKey:'secret-test-key',model:'jev-1.13.0'});
 }finally{f.close();}
});
test('Jev keeps environment compatibility and restores it after removing the saved override',async()=>{
 const f=fixture({config:async()=>({apiKey:'environment-key',model:'jev-preview'})});try{
  assert.equal((await f.settings.status()).source,'environment');
  await f.settings.save({apiKey:'saved-key',model:'jev-latest'});
  assert.equal((await f.settings.config()).apiKey,'saved-key');
  const removed=await f.settings.remove();assert.equal(removed.saved,false);assert.equal(removed.source,'environment');
 }finally{f.close();}
});
test('encryption failure leaves previous settings intact; unreadable ciphertext never falls back silently',async()=>{
 const f=fixture();try{
  await f.settings.save({apiKey:'first-key'});f.settings.encrypt=()=>{throw Error('Keychain unavailable');};
  await assert.rejects(()=>f.settings.save({apiKey:'second-key'}),/Keychain/);
  assert.equal((await f.settings.config()).apiKey,'first-key');
  f.settings.decrypt=()=>{throw Error('secret internal failure');};
  const status=await f.settings.status();assert.equal(status.configured,false);assert.match(status.error,/yeniden kaydet/);assert.doesNotMatch(JSON.stringify(status),/secret internal/);
  await assert.rejects(()=>f.settings.config(),/yeniden kaydet/);
 }finally{f.close();}
});
test('Jev rejects malformed values before writing',async()=>{
 const f=fixture();try{
  for(const input of [null,[],{apiKey:123},{apiKey:'short'},{apiKey:'space key'},{apiKey:'x'.repeat(4097)},{apiKey:'test-key',model:'x\nheader'},{apiKey:'test-key',endpoint:'https://evil.example'}])await assert.rejects(()=>f.settings.save(input));
  assert.equal(f.settings.row(),undefined);
 }finally{f.close();}
});
test('connection test only fetches authenticated model metadata with no candidate or browser data',async()=>{
 let calls=0;
 const f=fixture({fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://api.typesafe.ai/v1/models');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);assert.equal(options.headers.Authorization,'Bearer test-key');assert.ok(options.signal instanceof AbortSignal);
  return new Response(JSON.stringify({models:[{name:'jev-latest'}]}),{status:200});
 }});try{
  await f.settings.save({apiKey:'test-key'});const check=await f.settings.testConnection();assert.equal(calls,1);assert.equal(check.ok,true);assert.equal(check.modelListed,true);assert.equal(check.checkedAt,123);assert.deepEqual((await f.settings.status()).lastCheck,check);
 }finally{f.close();}
});
test('connection failures and malformed or oversized bodies never disclose server content or keys',async()=>{
 const cases=[async()=>{throw Error('raw secret-test-key');},async()=>new Response('secret-test-key',{status:401}),async()=>new Response('secret-test-key',{status:503}),async()=>new Response('{"models":[{"name":"<script>"}]}'),async()=>new Response('x'.repeat(131073)),async()=>new Response('not json')];
 for(const fetchImpl of cases){const f=fixture({fetchImpl});try{await f.settings.save({apiKey:'secret-test-key'});const result=await f.settings.testConnection();assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/secret-test-key|<script>/);}finally{f.close();}}
});
test('a check for a previous key cannot validate a replacement key',async()=>{
 let finish,started;const waiting=new Promise(resolve=>{started=resolve;});
 const f=fixture({fetchImpl:()=>{started();return new Promise(resolve=>{finish=resolve;});}});try{
  await f.settings.save({apiKey:'first-key'});const check=f.settings.testConnection();await waiting;
  await assert.rejects(()=>f.settings.testConnection(),/kontrol ediliyor/);
  await f.settings.save({apiKey:'second-key'});finish(new Response('{"models":[{"name":"jev-latest"}]}'));await check;
  assert.equal((await f.settings.status()).lastCheck,null);
 }finally{f.close();}
});
