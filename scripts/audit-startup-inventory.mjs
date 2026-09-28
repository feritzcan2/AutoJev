// Static bytes only: no credentials, settings values, candidate facts or content.
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {tools as jobTools} from '../app/mcp.mjs';
import {jevTools} from '../app/jev-browser.mjs';
import {AGENTS_MD} from '../app/prompts.mjs';
const bytes=v=>Buffer.byteLength(typeof v==='string'?v:JSON.stringify(v));
const workspace=process.argv[2];
const instructions=[];
if(workspace){
 for(let dir=path.resolve(workspace);;dir=path.dirname(dir)){
  for(const name of ['AGENTS.md','CLAUDE.md','CLAUDE.local.md','.claude/CLAUDE.md']){
   const file=path.join(dir,name);try{instructions.push({file,bytes:(await stat(file)).size});}catch{}
  }
  if(path.dirname(dir)===dir)break;
 }
}
let pluginCount=null;
try{const settings=JSON.parse(await readFile(path.join(os.homedir(),'.claude/settings.json'),'utf8'));pluginCount=Object.values(settings.enabledPlugins??{}).filter(Boolean).length;}catch{}
const inventory=list=>({count:list.length,bytes:bytes(list),largest:list.map(t=>({name:t.name,bytes:bytes(t)})).sort((a,b)=>b.bytes-a.bytes).slice(0,8)});
console.log(JSON.stringify({generatedAgentsBytes:bytes(AGENTS_MD),instructions,enabledUserPluginCount:pluginCount,jobTools:inventory(jobTools),jevTools:inventory(jevTools),limitations:'Static inventory, not tokens. Deferred tool discovery means these schemas are not necessarily all present in the first request. Provider system instructions, plugin injections and built-in tools are not exposed in the transcript. Do not subtract these bytes from input tokens.'},null,2));
