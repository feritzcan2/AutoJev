import path from 'node:path';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runtimeResourceRoot} from './runtime-paths.mjs';
import {SOURCE_TOOL_IDS} from './source-tool-ids.mjs';
export {SOURCE_TOOL_IDS};
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const shellQuote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
const powershellQuote=value=>"'"+value.replaceAll("'","''")+"'";
export function sourceToolContext(tool,{directory=path.join(runtimeResourceRoot({root}),'dist/source-tools'),executable=process.execPath,electron=Boolean(process.versions.electron),platform=process.platform,exists=existsSync}={}){
 if(!tool)return null;
 const script=path.join(directory,tool+'.mjs');
 if(!SOURCE_TOOL_IDS.includes(tool)||!exists(script))return {id:tool,available:false,message:'Kaynak aracı bu AutoJev kurulumunda bulunamadı. Uygulamayı güncelle veya tarayıcıyı kullan.'};
 const command=platform==='win32'?`${electron?'$env:ELECTRON_RUN_AS_NODE=\'1\'; ':''}& ${powershellQuote(executable)} ${powershellQuote(script)}`:`${electron?'ELECTRON_RUN_AS_NODE=1 ':''}${shellQuote(executable)} ${shellQuote(script)}`;
 return {id:tool,available:true,command,shell:platform==='win32'?'PowerShell':'POSIX',instructions:'Read assignedSource.skill for this source’s saved guide, or run command with --help using your native terminal tool. Append CLI arguments to command. Use this CLI for the assigned source. A CLI limit or truncated feed is not full coverage; preserve pagination and pending details. This CLI reads public listings; it does not submit, schedule or write application records. Follow scanInstructions: process and save one results page before requesting the next; report each search response with sourceRead on save_scan_progress. These production scan rules do not expand a trial beyond its access check. Save results and progress through the existing automation tools. To resume CLI work, read saved pending URLs with get_scan_queue view=entries and use the CLI detail command. A sourceRead on progress/completion reports your actual CLI response; it is an agent report, not a browser snapshot.'};
}
