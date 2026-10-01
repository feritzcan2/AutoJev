import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {sourceInstructions,runSourceTool,validateSourceSearch} from '../app/source-integrations.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
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
  const result=await sourceInstructions(root,source);assert.equal(result.skillText,original);assert.equal(result.skillOrigin,'upstream');assert.equal(result.toolReference,undefined);
  const legacy=`---\nname: jobloop-source-${id}\ndescription: Search this JobLoop source using the configured method and candidate preferences.\n---\nSearch ${id} (https://example.test) within the candidate's actual role, country, remote and salary preferences. Verify listing URLs and record current jobs through JobLoop MCP. Do not invent listings.\n`;
  assert.equal((await sourceInstructions(root,{...source,skillText:legacy})).skillText,original);
  assert.equal((await sourceInstructions(root,{...source,skillText:'My custom instructions'})).skillText,'My custom instructions');
 }
});
