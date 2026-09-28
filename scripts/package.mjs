import {execFileSync} from 'node:child_process';
import {readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ci=process.argv.includes('--ci'),directory=process.argv.includes('--dir');
const run=(file,args,env=process.env)=>execFileSync(file,args,{cwd:root,stdio:'inherit',env});
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(process.env.JOBLOOP_RELEASE_TAG&&process.env.JOBLOOP_RELEASE_TAG!==`v${manifest.version}`)throw Error('Release tag must match package.json version');
run(process.execPath,['scripts/vendor-termloop.mjs','--verify']);
run(process.execPath,['scripts/build.mjs']);
run(process.execPath,['scripts/build-source-tools.mjs']);
run(process.execPath,['scripts/build-engine.mjs','--release',...(process.platform==='darwin'?['--universal']:[])]);
run(process.execPath,['scripts/collect-licenses.mjs']);
if(!ci&&process.platform==='darwin'){
 if(!process.env.JOBLOOP_SIGNING_IDENTITY||!process.env.CSC_KEYCHAIN)throw Error('macOS releases require an isolated Developer ID signing keychain');
 run('codesign',['--force','--options','runtime','--timestamp','--keychain',process.env.CSC_KEYCHAIN,'--sign',process.env.JOBLOOP_SIGNING_IDENTITY,'engine/target/release/jobloop-engine']);
}
await rm(path.join(root,'release'),{recursive:true,force:true});
run(process.execPath,['node_modules/electron-builder/cli.js','--config',ci?'electron-builder-ci.yml':'electron-builder.yml','--publish','never',...(process.platform==='darwin'?['--mac','--universal']:process.platform==='win32'?['--win','--x64']:['--linux','--x64']),...(!ci&&process.platform==='darwin'?['-c.forceCodeSigning=true']:[]),...(directory?['--dir']:[])],{...process.env,...(ci?{CSC_IDENTITY_AUTO_DISCOVERY:'false'}:{})});
