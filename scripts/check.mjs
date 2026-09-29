import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
function* files(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const file=`${dir}/${entry.name}`;if(entry.isDirectory())yield* files(file);else yield file;}}
for (const dir of ['app','src','scripts','tests']) for (const name of files(dir)) {
  if (!/\.(mjs|js|cjs)$/.test(name)) continue;
  const result=spawnSync(process.execPath,['--check',name],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status??1);
}
