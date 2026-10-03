import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';

const source='https://board.test/jobs';
function fixture(t){
 const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);t.after(()=>core.close());
 const a=db.create('housing',{goal:'Homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[source]});db.review(a.id);
 return {db,id:a.id,run:db.begin(a.id,'run')};
}

test('the same listing with extra tracking parameters updates one record instead of creating a second',t=>{
 const {db,id,run}=fixture(t);
 const plain='https://board.test/view?jk=abc123&from=serp',tracked='https://board.test/view?jk=abc123&from=serp&advn=59680&adid=4225&ad=opaque-token-9';
 const first=db.record(id,run.id,{url:plain,title:'Officer',summary:'Facts'});
 const second=db.record(id,run.id,{url:tracked,title:'Officer (sponsored)',summary:'Facts again'});
 assert.equal(second.id,first.id);assert.equal(second.url,plain,'the first observed address stays the record address');
 assert.equal(db.results(id).filter(r=>!r.trial).length,1);
 const reversed=db.record(id,run.id,{url:'https://board.test/view?jk=abc123',title:'Officer',summary:'Fewer parameters'});
 assert.equal(reversed.id,first.id,'a subset of the saved parameters is the same page');
});

test('different values, different routes and parameter-free addresses stay separate records',t=>{
 const {db,id,run}=fixture(t);
 const a=db.record(id,run.id,{url:'https://board.test/view?jk=abc123&from=serp',title:'A',summary:'x'});
 const b=db.record(id,run.id,{url:'https://board.test/view?jk=def456&from=serp',title:'B',summary:'x'});
 const c=db.record(id,run.id,{url:'https://board.test/view/abc123?from=serp',title:'C',summary:'x'});
 const d=db.record(id,run.id,{url:'https://board.test/view?jk=abc123&page=2',title:'D',summary:'x'});
 const e=db.record(id,run.id,{url:'https://board.test/view',title:'E',summary:'x'});
 assert.equal(new Set([a.id,b.id,c.id,d.id,e.id]).size,5,'neither parameter set contains the other, so these stay apart');
 assert.equal(db.results(id).filter(r=>!r.trial).length,5);
});
