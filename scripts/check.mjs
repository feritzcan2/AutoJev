import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
function* files(dir) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) yield* files(file);
    else yield file;
  }
}
const run = (...args) => {
  const result = spawnSync(process.execPath, args, {stdio: 'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const dirs = ['app', 'src', 'scripts', 'tests'];
for (const dir of dirs)
  for (const name of files(dir)) if (/\.(mjs|js|cjs)$/.test(name)) run('--check', name);
run('node_modules/prettier/bin/prettier.cjs', '--check', ...dirs);
// Files opt into type checking with a leading `// @ts-check`.
run('node_modules/typescript/bin/tsc', '-p', 'tsconfig.json');
