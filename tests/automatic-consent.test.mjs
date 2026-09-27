import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
test('automatic consent preferences persist independently and do not authorize unknown facts',()=>{
 const s=new Store(':memory:');try{
 const p=s.saveProfile({name:'Candidate',preferences:'Remote'}),other=s.saveProfile({name:'Other',preferences:'Remote'});
 assert.equal(s.profile(p.id).applicationPolicy.legalAgreements,'ask');
 s.saveApplicationPolicy(p.id,{...p.applicationPolicy,marketing:'auto',legalAgreements:'auto',unknownImportant:'auto'});
 const policy=s.profile(p.id).applicationPolicy;assert.equal(policy.legalAgreements,'auto');assert.equal(policy.marketing,'auto');assert.equal(policy.unknownImportant,'ask');assert.equal(s.profile(other.id).applicationPolicy.legalAgreements,'ask');
 s.saveApplicationPolicy(p.id,{...policy,legalAgreements:'skip',marketing:'decline'});assert.equal(s.profile(p.id).applicationPolicy.legalAgreements,'skip');
 }finally{s.close();}
});
