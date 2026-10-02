import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {SOURCE_TOOL_IDS,sourceToolContext} from '../app/source-tools.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),preload=path.join(root,'tests/fixtures/source-cli-network.mjs');
function run(id,args,fixture='none',executable=process.execPath){
 const output=spawnSync(executable,['--import',preload,path.join(root,'dist/source-tools',id+'.mjs'),...args],{encoding:'utf8',timeout:10000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AUTOJEV_CLI_FIXTURE:fixture}});
 assert.ifError(output.error);assert.equal(output.signal,null);return output;
}
function success(id,args,fixture){const result=run(id,args,fixture);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
test('all six packaged CLIs expose help, reject unknown filters and validate detail IDs',()=>{
 for(const id of SOURCE_TOOL_IDS){
  const help=run(id,['--help']);assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/search/i);assert.match(help.stdout,/detail/i);assert.doesNotMatch(help.stdout,/bun run/);
  const invalid=run(id,['search','--autojev-invalid']);assert.equal(invalid.status,1);assert.equal(JSON.parse(invalid.stderr).code,'UNKNOWN_FLAG');assert.equal(invalid.stdout,'');
  const missing=run(id,['detail']);assert.equal(missing.status,1);assert.ok(['NO_ID','MISSING_REQUIRED'].includes(JSON.parse(missing.stderr).code));
 }
 for(const id of ['jobindex-search','jobnet-search','jobdanmark-search'])assert.equal(run(id,['search','--page','0']).status,1);
});
test('Node adapter preserves real API requests, pagination, repeated filters and JSON result shapes',()=>{
 const index=success('jobindex-search',['search','-q','C# developer','--page','2','--jobage','7','--sort','date','--limit','1'],'jobindex-search');assert.equal(index.meta.total,21);assert.equal(index.results.length,1);assert.equal(index.results[0].title,'Developer');
 const detail=success('jobindex-search',['detail','https://www.jobindex.dk/jobannonce/h12345/fixture?tracking=1'],'jobindex-detail');assert.equal(detail.company,'Fixture Co');assert.equal(detail.location,'Aarhus');
 const net=success('jobnet-search',['search','--search-string','Developer','--page','2','--per-page','20'],'jobnet-search');assert.equal(net.meta.totalJobAdCount,21);assert.equal(net.results[0].company,'Fixture Co');
 assert.deepEqual(success('jobnet-search',['suggestions','--query','dev','--limit','1'],'jobnet-suggestions'),['Developer']);
 const danmark=success('jobdanmark-search',['search','--text','Developer','--municipality','Aarhus','--job-type','fuldtid','--page','2'],'jobdanmark-search');assert.equal(danmark.meta.totalPages,2);assert.equal(danmark.results[0].date,'2026-10-01');
 const bank=success('jobbank-search',['search','--key','Developer','--type','3','--type','6'],'jobbank-search');assert.equal(bank.meta.total,101);assert.equal(bank.results[0].company,'Fixture Co');
 const linkedin=success('linkedin-search',['search','-q','Developer','--location','Berlin, Germany','--page','2'],'linkedin-search');assert.equal(linkedin.results[0].id,'123456');
 const freehire=success('freehire-search',['search','-q','Developer','--country','DE','--page','2','--limit','2'],'freehire-search');assert.equal(freehire.results[0].description,'Build accessible tools.');
 assert.equal(success('freehire-search',['detail','developer-fixture'],'freehire-detail').id,'developer-fixture');
 const denied=run('jobnet-search',['search','--search-string','Developer'],'forbidden');assert.equal(denied.status,1);assert.match(JSON.parse(denied.stderr).error,/403/);assert.equal(denied.stdout,'');
});
test('the supplied command runs with Electron Node, including paths outside the workspace',()=>{
 const electron=createRequire(import.meta.url)('electron'),context=sourceToolContext('jobnet-search',{executable:electron,electron:true});
 const command=context.command+' --help',win=process.platform==='win32';
 const result=spawnSync(win?'powershell.exe':'/bin/sh',win?['-NoProfile','-Command',command]:['-c',command],{cwd:path.dirname(root),encoding:'utf8',timeout:15000});
 assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/occupations/);
 const resultWithData=run('jobindex-search',['search','-q','C# developer','--page','2','--jobage','7','--sort','date','--limit','1'],'jobindex-search',electron);assert.equal(resultWithData.status,0,resultWithData.stderr);assert.equal(JSON.parse(resultWithData.stdout).results.length,1);
});
