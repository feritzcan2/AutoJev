import {execFileSync} from 'node:child_process';
import {mkdir,cp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceIntegrations} from '../app/source-integrations.mjs';
import {auditSourceTool} from './audit-dependencies.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),bun=process.env.JOBLOOP_BUN||'bun';
await rm(path.join(root,'dist/source-tools'),{recursive:true,force:true});
await mkdir(path.join(root,'dist/source-tools'),{recursive:true});
for(const source of sourceIntegrations){
 const cwd=path.join(root,'vendor/ai-job-search/.agents/skills',source.id+'-search/cli');
 execFileSync(bun,['install','--frozen-lockfile','--ignore-scripts',...(process.platform==='darwin'?['--cpu=*']:[])],{cwd,stdio:'inherit'});
 auditSourceTool(cwd,{install:false});
 const output=path.join(root,'dist/source-tools',source.id+'.mjs');
 // Native packages stay external so Bun selects the running architecture.
 // OpenTUI's static platform imports otherwise pull in every OS while bundling.
 execFileSync(bun,['build','src/cli.ts','--target=bun','--external=@opentui/core-*','--outdir',path.dirname(output),'--entry-naming',path.basename(output)],{cwd,stdio:'inherit'});
 const manifest=JSON.parse(await readFile(path.join(cwd,'package.json'),'utf8'));
 if(manifest.dependencies['@bunli/core'])for(const arch of process.platform==='darwin'?['arm64','x64']:[process.arch]){
  const name=`@opentui/core-${process.platform}-${arch}`;
  await cp(path.join(cwd,'node_modules',name),path.join(root,'dist/source-tools/node_modules',name),{recursive:true,dereference:true});
 }
}
if(!process.argv.includes('--skip-tests'))execFileSync(process.execPath,['scripts/smoke-source-tools.mjs'],{cwd:root,stdio:'inherit'});
