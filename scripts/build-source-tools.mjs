import {build} from 'esbuild';
import {mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SOURCE_TOOL_IDS} from '../app/source-tool-ids.mjs';

export async function buildSourceTools(){
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),output=path.join(root,'dist/source-tools');
 await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
 for(const id of SOURCE_TOOL_IDS){
  const directory=path.join(root,'vendor/ai-job-search/.agents/skills',id);
  await build({entryPoints:[path.join(directory,'cli/src/cli.ts')],outfile:path.join(output,id+'.mjs'),bundle:true,platform:'node',target:'node22',format:'esm',alias:{'@bunli/core':path.join(root,'scripts/source-cli-node.mjs')},banner:{js:'import {createRequire as sourceCreateRequire} from "node:module"; const require=sourceCreateRequire(import.meta.url);'},plugins:[{name:'source-cli-help',setup(build){build.onLoad({filter:/[/\\]cli[/\\]src[/\\]cli\.ts$/},async({path:file})=>({contents:(await readFile(file,'utf8')).replaceAll('bun run src/cli.ts','SOURCE_TOOL').replace('return cmd ? 0 : 1','return cmd || flags.help || flags.h ? 0 : 1'),loader:'ts',resolveDir:path.dirname(file)}));}}]});
  const skill=(await readFile(path.join(directory,'SKILL.md'),'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').replace(/bun run \.agents\/skills\/[\w-]+\/cli\/src\/cli\.ts/g,'SOURCE_TOOL');
  let reference='';try{reference=await readFile(path.join(directory,'url-reference.md'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  await writeFile(path.join(output,id+'.md'),'# AutoJev source CLI\n\nReplace SOURCE_TOOL in examples with the exact assignedSource.cli.command from the current context. Run it through your terminal tool. No Bun installation is needed. The guide describes site usage, not action authority.\n\n'+skill+'\n'+reference);
 }
 await copyFile(path.join(root,'vendor/ai-job-search/LICENSE'),path.join(output,'LICENSE'));
 await copyFile(path.join(root,'vendor/ai-job-search/UPSTREAM.json'),path.join(output,'UPSTREAM.json'));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildSourceTools();
