import {execFileSync} from 'node:child_process';
import {mkdir,chmod} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const release=process.argv.includes('--release'),universal=process.argv.includes('--universal');
if(universal&&process.platform!=='darwin')throw Error('Universal builds require macOS');
const run=(command,args)=>execFileSync(command,args,{cwd:root,stdio:'inherit'});
const args=['build','--locked','--manifest-path','engine/Cargo.toml','--target-dir','engine/target',...(release?['--release']:[])];
if(universal){
 if(!release)throw Error('Universal builds require --release');
 run('rustup',['target','add','aarch64-apple-darwin','x86_64-apple-darwin']);
 for(const target of ['aarch64-apple-darwin','x86_64-apple-darwin'])run('cargo',[...args,'--target',target]);
 await mkdir(path.join(root,'engine/target/release'),{recursive:true});
 run('lipo',['-create','engine/target/aarch64-apple-darwin/release/jobloop-engine','engine/target/x86_64-apple-darwin/release/jobloop-engine','-output','engine/target/release/jobloop-engine']);
 await chmod(path.join(root,'engine/target/release/jobloop-engine'),0o755);
 run('lipo',['engine/target/release/jobloop-engine','-verify_arch','arm64','x86_64']);
}else run('cargo',args);
