import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function run(cmd,args){const p=spawnSync(cmd,args,{cwd:root,stdio:'inherit',shell:process.platform==='win32'&&cmd==='pnpm'});if(p.status!==0)process.exit(p.status??1);}
run(process.execPath,['scripts/vendor-termloop.mjs','--verify']);
run('pnpm',['install','--frozen-lockfile']);
run('pnpm',['build']);run('pnpm',['engine:build']);
if(process.argv.includes('--source-tools'))run('pnpm',['sources:install']);
