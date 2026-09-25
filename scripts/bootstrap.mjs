import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function run(cmd,args,cwd=root){const p=spawnSync(cmd,args,{cwd,stdio:'inherit'});if(p.status!==0)process.exit(p.status??1);}
for(const name of ['terminal-wire','terminal-surface'])run('pnpm',['--filter',`@termloop/${name}`,'build'],path.join(root,'../termloop'));
run('pnpm',['install','--force']);
run(process.execPath,['node_modules/electron/install.js']);
run('pnpm',['build']);run('pnpm',['engine:build']);
