import {execFileSync} from 'node:child_process';
import {readFile,readdir,realpath,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
const root=process.cwd(),output=path.join(root,'dist/licenses'),seen=new Set(),inventory=[];
await rm(output,{recursive:true,force:true});
await mkdir(output,{recursive:true});
async function record(directory,{name,version,license,repository,licenseFile}){
 const id=`${name.replace(/[^A-Za-z0-9_.-]/g,'_')}-${version}`,destination=path.join(output,id),files=[];
 await mkdir(destination,{recursive:true});
 for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.isFile()&&/^(licen[sc]e|copying|notice|ofl|patents|authors)(?:$|[._-])/i.test(entry.name)){await copyFile(path.join(directory,entry.name),path.join(destination,entry.name));files.push(entry.name);}
 for(const candidate of [licenseFile,'dist/LICENSE'].filter(Boolean))try{if(path.isAbsolute(candidate)||candidate.includes('..'))continue;await copyFile(path.join(directory,candidate),path.join(destination,path.basename(candidate)));files.push(path.basename(candidate));}catch(error){if(error.code!=='ENOENT')throw error;}
 inventory.push({name,version,license:license??'See upstream notices',repository:repository&&typeof repository==='object'?repository.url:repository,files:[...new Set(files)].map(file=>`${id}/${file}`)});
}
async function locate(directory,name){
 for(let current=directory;;current=path.dirname(current)){
  try{return await realpath(path.join(current,'node_modules',name));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(path.dirname(current)===current)return null;
 }
}
async function visit(directory){
 directory=await realpath(directory);if(seen.has(directory))return;seen.add(directory);
 const manifest=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
 await record(directory,manifest);
 for(const [name,required] of [...Object.keys(manifest.dependencies??{}).map(name=>[name,true]),...Object.keys(manifest.optionalDependencies??{}).map(name=>[name,false]),...Object.keys(manifest.peerDependencies??{}).map(name=>[name,false])]){
  const child=await locate(directory,name);if(child)await visit(child);else if(required&&!manifest.optionalDependencies?.[name])throw Error(`Missing dependency license source: ${manifest.name} -> ${name}`);
 }
}
await visit(root);
for(const name of ['linkedin','freehire','jobindex','jobnet','jobdanmark','jobbank'])await visit(path.join(root,'vendor/ai-job-search/.agents/skills',name+'-search/cli'));
const metadata=JSON.parse(execFileSync('cargo',['metadata','--locked','--format-version','1','--manifest-path','engine/Cargo.toml'],{encoding:'utf8',maxBuffer:32*1024*1024}));
for(const item of metadata.packages)await record(path.dirname(item.manifest_path),{name:`rust-${item.name}`,version:item.version,license:item.license,repository:item.repository,licenseFile:item.license_file});
const unique=[...new Map(inventory.map(item=>[`${item.name}@${item.version}`,item])).values()].sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
await writeFile(path.join(output,'index.json'),JSON.stringify(unique,null,2)+'\n');
console.log(`Collected license notices for ${unique.length} JavaScript and Rust packages`);
