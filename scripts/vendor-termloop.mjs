import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const destination=path.join(root,'vendor/termloop');
const modules=['agents','agent-runtime','launch','terminal','platform','domain','terminal-wire'];
const clients=['terminal-wire','terminal-surface'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(directory,prefix=''){
 const result=[];
 for(const item of await readdir(directory,{withFileTypes:true})){
  if(['node_modules','dist','target','UPSTREAM.json'].includes(item.name))continue;
  const relative=path.posix.join(prefix,item.name);
  if(item.isDirectory())result.push(...await files(path.join(directory,item.name),relative));
  else if(item.isFile())result.push(relative);
 }
 return result.sort();
}
if(process.argv.includes('--verify')){
 const manifest=JSON.parse(await readFile(path.join(destination,'UPSTREAM.json'),'utf8'));
 const actual=await files(destination);
 if(JSON.stringify(actual)!==JSON.stringify(Object.keys(manifest.files).sort()))throw Error('TermLoop source inventory differs from its pinned manifest');
 for(const file of actual)if(sha256(await readFile(path.join(destination,file)))!==manifest.files[file])throw Error(`TermLoop checksum mismatch: ${file}`);
 console.log(`Verified vendored TermLoop ${manifest.revision} (${actual.length} files)`);
}else{
 const source=process.argv[2],revision=process.argv[3];
 if(!source||!/^[a-f0-9]{40}$/.test(revision??''))throw Error('Usage: node scripts/vendor-termloop.mjs /path/to/termloop FULL_SHA');
 const git=args=>execFileSync('git',['-C',path.resolve(source),...args],{maxBuffer:32*1024*1024});
 if(git(['rev-parse',`${revision}^{commit}`]).toString().trim()!==revision)throw Error('Revision must identify an exact commit');
 await rm(destination,{recursive:true,force:true});await mkdir(destination,{recursive:true});
 const selected=['Cargo.toml','LICENSE','tsconfig.base.json',...modules.map(name=>`modules/${name}`),...clients.map(name=>`clients/${name}`)];
 const tracked=git(['ls-tree','-r','--name-only',revision,'--',...selected]).toString().trim().split('\n').filter(file=>!file.endsWith('/AGENTS.md'));
 for(const file of tracked){const target=path.join(destination,file);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,git(['show',`${revision}:${file}`]));}
 const cargo=await readFile(path.join(destination,'Cargo.toml'),'utf8');
 await writeFile(path.join(destination,'Cargo.toml'),cargo.replace(/members = \[[\s\S]*?\]/,'members = '+JSON.stringify(modules.map(name=>`modules/${name}`))));
 await writeFile(path.join(destination,'package.json'),JSON.stringify({name:'jobloop-termloop-source',private:true,packageManager:'pnpm@10.14.0'},null,2)+'\n');
 await writeFile(path.join(destination,'pnpm-workspace.yaml'),'packages:\n  - clients/terminal-wire\n  - clients/terminal-surface\n');
 const pnpm=(args,cwd=destination)=>{const r=execFileSync(process.platform==='win32'?'pnpm.cmd':'pnpm',args,{cwd,stdio:'inherit',shell:process.platform==='win32'});return r;};
 pnpm(['install','--ignore-scripts']);
 await mkdir(path.join(destination,'packages'),{recursive:true});
 for(const name of clients){pnpm(['--filter',`@termloop/${name}`,'build']);pnpm(['pack','--pack-destination',path.join(destination,'packages')],path.join(destination,'clients',name));}
 const checksums={};for(const file of await files(destination))checksums[file]=sha256(await readFile(path.join(destination,file)));
 await writeFile(path.join(destination,'UPSTREAM.json'),JSON.stringify({repository:'https://github.com/feritzcan2/termloop',revision,license:'GPL-3.0-or-later',adaptations:['Workspace members narrowed to the Rust dependencies used by JobLoop.','JS workspace narrowed to terminal-wire and terminal-surface. Packages built with upstream build/pack scripts.'],files:checksums},null,2)+'\n');
 console.log(`Vendored TermLoop ${revision}`);
}
