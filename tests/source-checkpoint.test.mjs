import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
test('source tabs are scoped to active search and survive settings edits',()=>{
 const s=new Store(':memory:');try{
 const p=s.saveProfile({name:'A',preferences:'Remote'}),other=s.saveProfile({name:'B',preferences:'Remote'}),source=s.sources(p.id)[0];
 const tab={browser:'chrome',tabId:'42',url:'https://www.linkedin.com/jobs/search/?keywords=backend'};
 assert.throws(()=>s.saveSourceCheckpoint(p.id,source.id,tab));
 s.saveCampaign(p.id,{status:'running',task:{kind:'search',sourceId:source.id}});
 assert.throws(()=>s.saveSourceCheckpoint(other.id,source.id,tab));
 assert.throws(()=>s.saveSourceCheckpoint(p.id,source.id,{...tab,url:'javascript:alert(1)'}));
 s.saveSourceCheckpoint(p.id,source.id,tab);
 s.saveSource(p.id,{...source,enabled:false});
 assert.equal(s.source(p.id,source.id).resumeContext.tabId,'42');
 assert.equal(s.snapshot(p.id).sources[0].resumeContext.url,tab.url);
 }finally{s.close();}
});
