import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
for (const dir of ['app','src','scripts','tests']) for (const name of readdirSync(dir)) {
  if (!/\.(mjs|js|cjs)$/.test(name)) continue;
  const result=spawnSync(process.execPath,['--check',`${dir}/${name}`],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status??1);
}
