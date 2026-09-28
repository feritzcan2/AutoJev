// Read-only replay of agent tool text. Prints byte totals, never candidate data.
import {readFile} from 'node:fs/promises';
import {compactTaskContext,jobReceipt} from '../app/agent-payloads.mjs';
import {rankDecision} from '../app/ranking.mjs';
const file=process.argv[2];if(!file)throw Error('Usage: node scripts/audit-agent-payloads.mjs conversation.jsonl');
const calls=new Map(),totals=new Map();let profile;
for(const line of (await readFile(file,'utf8')).split('\n')){
 let row;try{row=JSON.parse(line);}catch{continue;}
 if(row.isSidechain)continue;
 const blocks=row.message?.content;if(!Array.isArray(blocks))continue;
 for(const block of blocks){
  if(block.type==='tool_use')calls.set(block.id,block.name.split('__').at(-1));
  if(block.type!=='tool_result'||!Array.isArray(block.content))continue;
  const name=calls.get(block.tool_use_id);
  for(const part of block.content){
   if(part.type!=='text')continue;
   let before;try{before=JSON.parse(part.text);}catch{continue;}
   let after;
   if(name==='get_task_context'&&before.profile){profile=before.profile;after=compactTaskContext(before);}
   if(name==='get_source_instructions'&&before.skillText){after={...before};if(after.toolReference===after.skillText)delete after.toolReference;}
   if(name==='add_job'&&before.job&&profile)after={duplicate:before.duplicate,job:jobReceipt(before.job,rankDecision(profile,before.job))};
   if(name==='record_job_rank'&&before.id&&profile)after=jobReceipt(before,rankDecision(profile,before));
   if(!after)continue;
   const total=totals.get(name)??{calls:0,beforeBytes:0,afterBytes:0};total.calls++;
   total.beforeBytes+=Buffer.byteLength(JSON.stringify(before));total.afterBytes+=Buffer.byteLength(JSON.stringify(after));totals.set(name,total);
  }
 }
}
console.log(JSON.stringify(Object.fromEntries([...totals].map(([name,t])=>[name,{...t,reductionPercent:Math.round((1-t.afterBytes/t.beforeBytes)*1000)/10}])),null,2));
