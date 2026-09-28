import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceIntegrations} from '../app/source-integrations.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export function auditSourceTool(cwd,{install=true}={}){
 const bun=process.env.JOBLOOP_BUN||'bun';
 if(install)execFileSync(bun,['install','--frozen-lockfile','--ignore-scripts'],{cwd,stdio:'inherit',timeout:120000});
 // Bun audits the complete lockfile; it currently has no production-only flag.
 // A registry error also fails the build, rather than silently skipping a check.
 execFileSync(bun,['audit','--json'],{cwd,stdio:'inherit',timeout:120000});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 // Windows package-manager shims require cmd.exe. Both arguments are constants.
 execFileSync(process.platform==='win32'?'pnpm.cmd':'pnpm',['audit','--prod'],{cwd:root,stdio:'inherit',shell:process.platform==='win32',timeout:120000});
 for(const {id} of sourceIntegrations){
  console.log(`Auditing ${id} source dependencies`);
  auditSourceTool(path.join(root,'vendor/ai-job-search/.agents/skills',id+'-search/cli'));
 }
}
