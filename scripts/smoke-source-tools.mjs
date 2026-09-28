import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceIntegrations} from '../app/source-integrations.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const preload=path.join(root,'tests/fixtures/source-tools-network.mjs');
const bun=process.env.JOBLOOP_BUN||'bun';
function run(id,args,fixture=''){
 const result=spawnSync(bun,['--preload',preload,path.join(root,'dist/source-tools',id+'.mjs'),...args],{
  cwd:root,encoding:'utf8',timeout:20000,
  env:{...process.env,NO_COLOR:'1',JOBLOOP_SOURCE_FIXTURE:fixture},
 });
 assert.ifError(result.error);
 assert.equal(result.signal,null,`${id} ${args.join(' ')} was terminated`);
 return result;
}
function jsonSuccess(id,args,fixture){
 const result=run(id,args,fixture);
 assert.equal(result.status,0,`${id}: ${result.stderr}`);
 assert.equal(result.stderr.trim(),'');
 return JSON.parse(result.stdout);
}
for(const {id} of sourceIntegrations){
 const help=run(id,['--help']);
 // The dependency-free upstream CLIs return 1 for top-level help.
 assert.equal(help.status,['linkedin','freehire'].includes(id)?1:0,`${id}: ${help.stderr}`);
 assert.match(help.stdout,/search/i);assert.match(help.stdout,/detail/i);
 assert.equal(help.stderr.trim(),'');
 const unknown=run(id,['search','--jobloop-unknown-flag']);
 assert.equal(unknown.status,1,`${id}: ${unknown.stderr}`);
 assert.equal(unknown.stdout,'');
 assert.equal(JSON.parse(unknown.stderr).code,'UNKNOWN_FLAG');
 const missing=run(id,['detail']);
 assert.equal(missing.status,1,`${id}: ${missing.stderr}`);
 assert.equal(missing.stdout,'');
 assert.equal(JSON.parse(missing.stderr).code,['linkedin','freehire'].includes(id)?'NO_ID':'MISSING_REQUIRED');
}
// Exercise real bundled Bunli handlers, short aliases, typed flags, a result
// limit, URL normalization and JSON output. The preload forbids live requests.
const search=jsonSuccess('jobindex',['search','-q','C# developer','--page','2','--jobage','7','--sort','date','--limit','1','--format','json'],'jobindex-search');
assert.equal(search.meta.total,2);assert.equal(search.meta.page,2);
assert.equal(search.results.length,1);
assert.equal(search.results[0].id,'h12345');
assert.equal(search.results[0].title,'C# developer');
assert.equal(search.results[0].company,'Fixture Co');
const detail=jsonSuccess('jobindex',['detail','https://www.jobindex.dk/jobannonce/h12345/fixture?tracking=1','--format','json'],'jobindex-detail');
assert.equal(detail.id,'h12345');assert.equal(detail.company,'Fixture Co');
assert.equal(detail.title,'C# developer');assert.equal(detail.location,'Aarhus');
assert.equal(detail.url,'https://www.jobindex.dk/jobannonce/h12345');
assert.equal(detail.deadline,'2026-10-13');
console.log('Bundled source tools passed: six help/error contracts and search/detail fixtures');
