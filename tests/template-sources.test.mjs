import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationTemplate,reusableTemplate} from '../app/automation-templates.mjs';
function fixture(t){const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());return new AutomationStore(core);}
test('job template creates its 14 sources with original schedules and browser sources',t=>{
 const db=fixture(t),a=db.create('job-search'),sources=db.sources(a.id);
 assert.equal(sources.length,14);assert.equal(sources.filter(s=>s.enabled).length,10);
 const linked=sources.find(s=>s.name==='LinkedIn');assert.equal(linked.intervalMinutes,15);assert.equal(linked.integrationId,undefined);assert.equal(linked.searchMethod,undefined);
 assert.ok(sources.some(s=>s.name==='FreeHire'));assert.equal(sources.find(s=>s.name==='Jobindex').enabled,false);
 assert.equal(a.status,'draft');assert.equal(a.mode,'observe');assert.equal(a.nextRunAt,null);
});
test('explicit sources, explicit empty sources and removed sources stay under user control',t=>{
 const db=fixture(t),empty=db.create('job-search',{sources:[]}),custom=db.create('job-search',{sources:['https://example.test/jobs']});
 assert.deepEqual(empty.sources,[]);assert.deepEqual(custom.sources,['https://example.test/jobs']);assert.deepEqual(custom.sourceSettings,{});
 const a=db.create('job-search');db.save(a.id,{sources:[]});db.save(a.id,{title:'Edited'});assert.deepEqual(db.get(a.id).sources,[]);
});
test('source presets work for imported templates without exporting private workspace sources',t=>{
 const db=fixture(t),base=automationTemplate('housing'),defaults=[{url:'https://homes.test/list',name:'Homes',intervalMinutes:75,enabled:false}];
 const copy=db.saveTemplate({...base,defaultSources:defaults,sources:['https://private.test/list']});
 const a=db.create(copy.id);assert.deepEqual(a.sources,['https://homes.test/list']);assert.equal(db.sources(a.id)[0].intervalMinutes,75);assert.equal(db.sources(a.id)[0].enabled,false);
 assert.equal(copy.sources,undefined);assert.deepEqual(reusableTemplate(copy).defaultSources,copy.defaultSources);
 assert.deepEqual(db.create('housing').sources,[]);
});
test('template source presets reject unsafe addresses, duplicates and invalid intervals',()=>{
 const base=automationTemplate('custom');
 for(const defaultSources of [[{url:'file:///tmp/private'}],[{url:'https://name:secret@example.test'}],[{url:'https://example.test',intervalMinutes:0}],[{url:'https://example.test'},{url:'https://example.test/'}]])assert.throws(()=>reusableTemplate({...base,defaultSources}));
});
