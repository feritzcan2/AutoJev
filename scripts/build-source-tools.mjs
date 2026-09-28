import {execFileSync,spawnSync} from 'node:child_process';
import {mkdir,cp,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceIntegrations} from '../app/source-integrations.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),bun=process.env.JOBLOOP_BUN||'bun';
await mkdir(path.join(root,'dist/source-tools'),{recursive:true});
for(const source of sourceIntegrations){
 const cwd=path.join(root,'vendor/ai-job-search/.agents/skills',source.id+'-search/cli');
 execFileSync(bun,['install','--frozen-lockfile','--ignore-scripts',...(process.platform==='darwin'?['--cpu=*']:[])],{cwd,stdio:'inherit'});
 const output=path.join(root,'dist/source-tools',source.id+'.mjs');
 execFileSync(bun,['build','src/cli.ts','--target=bun','--outdir',path.dirname(output),'--entry-naming',path.basename(output)],{cwd,stdio:'inherit'});
 const manifest=JSON.parse(await readFile(path.join(cwd,'package.json'),'utf8'));
 if(manifest.dependencies['@bunli/core'])for(const arch of process.platform==='darwin'?['arm64','x64']:[process.arch]){
  const name=`@opentui/core-${process.platform}-${arch}`;
  await cp(path.join(cwd,'node_modules',name),path.join(root,'dist/source-tools/node_modules',name),{recursive:true,dereference:true});
 }
 const check=spawnSync(bun,[output,'--help'],{cwd:root,encoding:'utf8',timeout:20000});
 // The two dependency-free upstream CLIs print usage and exit 1 for --help.
 if(![0,1].includes(check.status)||check.error||!/usage|commands|options/i.test(check.stdout)||check.stderr.trim())throw Error(`Bundled ${source.id} failed its help smoke: ${check.error??check.stderr}`);
}
