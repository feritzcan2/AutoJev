import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../app/store.mjs';
import {sourceInstructions,runSourceTool,validateSourceSearch} from '../app/source-integrations.mjs';
const root=new URL('../',import.meta.url).pathname;
test('catalog installs six integrations once, preserving permissions and removals',()=>{
 const s=new Store(':memory:');try{
 const p=s.saveProfile({name:'Test',preferences:'Berlin',authorization:'submit'});
 const sources=s.sources(p.id);assert.equal(sources.filter(x=>x.integrationId).length,6);
 assert.equal(sources.find(x=>x.integrationId==='linkedin').searchMethod,'tool');
 assert.equal(sources.find(x=>x.integrationId==='jobnet').enabled,false);
 assert.equal(sources.find(x=>x.kind==='employer').searchMethod,'free');
 const free=sources.find(x=>x.integrationId==='freehire');s.deleteSource(p.id,free.id);assert.equal(s.sources(p.id).some(x=>x.id===free.id),false);
 const li=sources.find(x=>x.integrationId==='linkedin');s.saveSource(p.id,{...li,applyMode:'find_only',searchMethod:'browser'});assert.equal(s.sources(p.id).find(x=>x.id===li.id).applyMode,'find_only');
 }finally{s.close();}
});
test('setup completion updates inherited modes but preserves explicit source choices',()=>{
 const s=new Store(':memory:');try{
 const p=s.createSetup({provider:'codex',model:'default',permission:'default',reasoning:'default',network:null});const sources=s.sources(p.id);
 const li=sources.find(x=>x.integrationId==='linkedin');s.saveSource(p.id,{...li,applyMode:'find_only'});
 s.saveSetup(p.id,{...s.setup(p.id),status:'review'});s.completeSetup(p.id,{name:'Test',facts:'Engineer',preferences:'Danimarka remote',authorization:'submit'});
 assert.equal(s.source(p.id,li.id).applyMode,'find_only');assert.equal(s.sources(p.id).find(x=>x.integrationId==='freehire').applyMode,'auto');assert.equal(s.sources(p.id).find(x=>x.integrationId==='jobnet').enabled,true);
 }finally{s.close();}
});
test('source skill overrides persist, tool arguments use execFile without shell interpolation',async()=>{
 const config=validateSourceSearch({searchMethod:'tool',integrationId:'linkedin',skillText:'Search backend roles',fallback:'browser'});
 const instructions=await sourceInstructions(root,{...config,id:'source',name:'LinkedIn'});assert.equal(instructions.skillText,'Search backend roles');assert.match(instructions.toolReference,/--location/);assert.equal(instructions.upstream.commit.length,40);
 let seen;await runSourceTool(root,config,['search','--query','$(echo secret)'],{execute:async(command,args,options)=>{seen={command,args,options};return{stdout:'[]',stderr:''};}});
 assert.equal(seen.args.at(-1),'$(echo secret)');assert.equal(seen.options.shell,undefined);
 assert.equal(validateSourceSearch({integrationId:null,searchMethod:'free'},config).integrationId,null);
 await assert.rejects(()=>runSourceTool(root,{searchMethod:'browser',integrationId:'linkedin'},['search']),/modunda/);
 const failed=await runSourceTool(root,config,['search'],{execute:async()=>{throw Error('Network unavailable');}});assert.equal(failed.ok,false);
});

test('built-in sources expose the exact upstream skill as the primary editable instructions',async()=>{
 const {readFile}=await import('node:fs/promises');
 for(const id of ['linkedin','freehire','jobindex','jobnet','jobdanmark','jobbank']){
  const source={id:'test',integrationId:id,kind:id,name:id,url:'https://example.test'};
  const original=await readFile(new URL(`../vendor/ai-job-search/.agents/skills/${id}-search/SKILL.md`,import.meta.url),'utf8');
  const result=await sourceInstructions(root,source);assert.equal(result.skillText,original);assert.equal(result.skillOrigin,'upstream');
  const legacy=`---\nname: jobloop-source-${id}\ndescription: Search this JobLoop source using the configured method and candidate preferences.\n---\nSearch ${id} (https://example.test) within the candidate's actual role, country, remote and salary preferences. Verify listing URLs and record current jobs through JobLoop MCP. Do not invent listings.\n`;
  assert.equal((await sourceInstructions(root,{...source,skillText:legacy})).skillText,original);
  assert.equal((await sourceInstructions(root,{...source,skillText:'My custom instructions'})).skillText,'My custom instructions');
 }
});
