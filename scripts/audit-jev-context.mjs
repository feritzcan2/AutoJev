// Read-only replay of Claude JSONL tool results. Prints only aggregate sizes;
// never prints candidate facts, browser text, documents or screenshots.
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {presentObservation} from '../app/jev-navigation.mjs';
const file=process.argv[2];
if(!file)throw Error('Usage: node scripts/audit-jev-context.mjs /path/to/conversation.jsonl');
const slots=new Map();let count=0,before=0,after=0,controls=0,omitted=0;
for(const line of (await readFile(file,'utf8')).split('\n')){
 let row;try{row=JSON.parse(line);}catch{continue;}
 if(row.isSidechain||!Array.isArray(row.message?.content))continue;
 for(const block of row.message.content){
  if(block.type!=='tool_result'||!Array.isArray(block.content))continue;
  for(const item of block.content){
   if(item.type!=='text')continue;
   let value;try{value=JSON.parse(item.text);}catch{continue;}
   if(!value?.tabId||!Array.isArray(value.controls)||!Array.isArray(value.elements))continue;
   // This audit accepts the old complete-control format only. Avoid treating
   // a new delta's partial controls as a complete historical observation.
   if('removedControls' in value)throw Error('This replay requires a transcript from before control deltas.');
   const slot=slots.get(value.tabId)??{};slots.set(value.tabId,slot);
   const presented=presentObservation(slot,value,{full:value.observationMode==='full'});
   const next={...value,controls:presented.controls,...(presented.removedControls?{removedControls:presented.removedControls}:{})};
   const reconstructed=new Map((slot.auditControls??[]).map(c=>[c.controlId,c]));
   if(presented.observationMode==='full')reconstructed.clear();
   for(const id of next.removedControls??[])reconstructed.delete(id);
   for(const control of next.controls)reconstructed.set(control.controlId,control);
   assert.ok(isDeepStrictEqual(reconstructed,new Map(value.controls.map(c=>[c.controlId,c]))),`Control reconstruction mismatch at observation ${count+1}`);
   slot.auditControls=[...reconstructed.values()];
   count++;before+=JSON.stringify(value).length;after+=JSON.stringify(next).length;
   controls+=value.controls.length;omitted+=value.controls.length-next.controls.length;
  }
 }
}
console.log(JSON.stringify({observations:count,beforeChars:before,afterChars:after,reductionPercent:before?Number(((1-after/before)*100).toFixed(2)):0,controls,omittedUnchangedControls:omitted,reconstructedWithoutLoss:true},null,2));
