import {randomUUID} from 'node:crypto';

export const AUTOMATION_CONTEXT_BYTES=16000;
const partCharacters=8000;
const size=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
export const automationContextTools=[{
 name:'read_automation_context_part',
 description:'Read the next exact JSON fragment of the saved automation context using context.id and context.nextOffset. Read every part before browser work or decisions. No shell or file access is needed. This cache is separate from browser snapshots; fragments may end inside a JSON value.',
 inputSchema:{type:'object',properties:{contextId:{type:'string',minLength:1,maxLength:64},offset:{type:'integer',minimum:0}},required:['contextId','offset'],additionalProperties:false}
}];

// Owned by one workflow, so another run cannot retrieve its saved user data.
// Small responses keep their existing shape. Large responses retain every byte
// of the context projection without relying on provider spill files or Bash.
export class AutomationContext {
 capture(value){
  this.current=null;
  if(size(value)<=AUTOMATION_CONTEXT_BYTES)return value;
  this.current={id:randomUUID(),text:JSON.stringify(value)};
  return this.read({contextId:this.current.id,offset:0});
 }
 read({contextId,offset}){
  const saved=this.current;
  if(!saved||saved.id!==contextId)throw Error('Bağlam eski veya bu çalışmaya ait değil. get_automation_context ile güncel bağlamı al.');
  if(!Number.isSafeInteger(offset)||offset<0||offset>saved.text.length)throw Error('Geçersiz bağlam aralığı. Dönen context.nextOffset değerini kullan.');
  const build=end=>({
   context:{id:saved.id,totalCharacters:saved.text.length,offset,endOffset:end,nextOffset:end<saved.text.length?end:null},
   text:saved.text.slice(offset,end),
   notice:'Saved automation context JSON fragment. Read ALL parts with read_automation_context_part(contextId: context.id, offset: context.nextOffset) until nextOffset is null before browser work or decisions. Join text fragments in order. Do not use shell commands or request file permission.'
  });
  let end=Math.min(saved.text.length,offset+partCharacters);
  while(size(build(end))>AUTOMATION_CONTEXT_BYTES)end=offset+Math.floor((end-offset)*.75);
  if(end>offset&&end<saved.text.length&&/[\uD800-\uDBFF]/.test(saved.text[end-1])&&/[\uDC00-\uDFFF]/.test(saved.text[end]))end--;
  return build(end);
 }
}
