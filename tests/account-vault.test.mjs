import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {AccountVault} from '../app/account-vault.mjs';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
test('portal secrets are isolated, encrypted, never returned with metadata, and removable',()=>{
 const store=new Store(':memory:');const a=store.saveProfile({name:'A',preferences:'Remote'}),b=store.saveProfile({name:'B',preferences:'Remote'});const key=randomBytes(32),iv=randomBytes(16);
 const vault=new AccountVault(store.db,{encrypt:s=>{const c=createCipheriv('aes-256-cbc',key,iv);return Buffer.concat([c.update(s),c.final()]).toString('base64');},decrypt:s=>{const c=createDecipheriv('aes-256-cbc',key,iv);return Buffer.concat([c.update(Buffer.from(s,'base64')),c.final()]).toString();}});
 try{
  vault.request(a.id,{jobId:'job',origin:'https://portal.test'});
  const result=vault.save(a.id,{email:'A@example.com',password:'Secret-for-fixture!',gmailCodes:true});
  assert.equal(result.configured,true);assert.equal(result.gmailCodes,true);assert.equal(result.email,'a@example.com');
  assert.ok(!JSON.stringify(result).includes('Secret-for-fixture!'));assert.ok(!JSON.stringify(store.profile(a.id)).includes('Secret-for-fixture!'));
  assert.notEqual(vault.row(a.id).ciphertext,'Secret-for-fixture!');assert.equal(vault.secret(a.id),'Secret-for-fixture!');assert.equal(vault.secret(b.id),null);
  // Even candidates sharing an email keep independent registration passwords.
  vault.save(b.id,{email:'A@example.com',password:'Other-candidate-fixture!',gmailCodes:false});
  assert.equal(vault.secret(a.id),'Secret-for-fixture!');assert.equal(vault.secret(b.id),'Other-candidate-fixture!');
  assert.equal(vault.status(b.id).gmailCodes,false);assert.equal(vault.status(b.id).pending,null);
  vault.save(a.id,{email:'A@example.com',password:'Updated-candidate-fixture!',gmailCodes:true});
  assert.equal(vault.secret(a.id),'Updated-candidate-fixture!');assert.equal(vault.secret(b.id),'Other-candidate-fixture!');
  vault.clearRequest(a.id);assert.equal(vault.status(a.id).pending,null);vault.remove(a.id);assert.equal(vault.secret(a.id),null);
  assert.equal(vault.secret(b.id),'Other-candidate-fixture!');
  const unavailable=new AccountVault(store.db,{encrypt:()=>{throw Error('Keychain unavailable');}});
  assert.throws(()=>unavailable.save(a.id,{email:'a@example.com',password:'Secret-for-fixture!'}),/Keychain/);assert.equal(vault.status(a.id).configured,false);
 }finally{store.close();}
});
