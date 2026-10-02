import {randomUUID} from 'node:crypto';

// Bound the serialized response, not just the visible character count: JSON
// escaping and multi-byte text also contribute to provider tool output limits.
export const BROWSER_RESPONSE_BYTES=16000;
export const BROWSER_PART_CHARACTERS=8000;
const size=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const schema=properties=>({type:'object',properties,required:Object.keys(properties).filter(k=>!['offset','limit'].includes(k)),additionalProperties:false});
const snapshotId={type:'string',minLength:1,maxLength:64};
const offset={type:'integer',minimum:0};
export const browserSnapshotTools=[
 {name:'browser_read_part',description:'Read another part of a saved browser snapshot using its snapshotId and nextOffset. No browser navigation, fresh observation or step budget is consumed. All text remains available. Cached text is historical evidence; same-task text is cached in RAM while this app stays open; after an app restart read the page again; use the corrected snapshotId and offset returned by recovery. Browser actions still require a fresh snapshot. Continue fragments in order; a fragment can end inside a long line or JSON value.',inputSchema:schema({snapshotId,offset,limit:{type:'integer',minimum:1,maximum:BROWSER_PART_CHARACTERS}})},
 {name:'browser_search',description:'Search a saved browser snapshot for a literal phrase, case-insensitively. Returns exact offsets and surrounding text. Use browser_read_part at a returned contextOffset to inspect the complete listing and link. Continue search with nextOffset. Does not access the browser or certify current availability; a missing match in one page is not proof of no results.',inputSchema:schema({snapshotId,query:{type:'string',minLength:1,maxLength:200},offset,limit:{type:'integer',minimum:1,maximum:5}})}
];

// Each workflow owns its own cache. IDs cannot read another run's pages; a new
// observation, navigation or attempted interaction invalidates the old one.
export class BrowserSnapshot {
 invalidate(){this.current=null;}
 capture(result){
  const content=result.content??[],text=content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
  const snapshotId=randomUUID();
  this.current={id:snapshotId,url:result.url,text,...(result.readiness?{readiness:result.readiness}:{}),...(result.pageNavigation?{pageNavigation:result.pageNavigation}:{})};
  const snapshot={id:snapshotId,totalCharacters:text.length,offset:0,endOffset:text.length,nextOffset:null,complete:true};
  const full={...result,snapshot};
  if(size(full)<=BROWSER_RESPONSE_BYTES)return full;
  const page=this.read({snapshotId});
  const omitted=content.filter(p=>p.type!=='text').map(p=>p.type);
  if(omitted.length)page.omittedContentTypes=[...new Set(omitted)];
  return page;
 }
 get(id){
  if(!this.current||this.current.id!==id)throw Error('Sayfa gözlemi eski veya bu çalışmaya ait değil. Son yanıttaki snapshot.id ile devam et; gerekiyorsa browser_read ile güncel sayfayı oku.');
  return this.current;
 }
 read({snapshotId,offset=0,limit=BROWSER_PART_CHARACTERS}){
  const page=this.get(snapshotId);
  if(!integer(offset,0,page.text.length)||!integer(limit,1,BROWSER_PART_CHARACTERS))throw Error('Geçersiz sayfa aralığı. Dönen nextOffset değerini kullan.');
  const build=end=>({url:page.url,...(page.readiness?{readiness:page.readiness}:{}),...(page.pageNavigation?{pageNavigation:page.pageNavigation}:{}),content:[{type:'text',text:page.text.slice(offset,end)}],snapshot:{id:page.id,totalCharacters:page.text.length,offset,endOffset:end,nextOffset:end<page.text.length?end:null,complete:offset===0&&end===page.text.length},...(offset>0||end<page.text.length?{notice:'Bu, kaydedilmiş sayfanın bir parçasıdır. Devamı için browser_read_part(snapshotId, offset: nextOffset), belirli içerik için browser_search kullan. Parçaları okumak tarayıcı adımı harcamaz; tüm sayfayı okumuş sayılmazsın.'}:{})});
  let end=Math.min(page.text.length,offset+limit);
  // Preserve readable lines when possible, while retaining an exact cursor for
  // single enormous lines and snapshots containing serialized JSON.
  const line=page.text.lastIndexOf('\n',end-1);
  if(end<page.text.length&&line>=offset+Math.floor(limit/2))end=line+1;
  while(size(build(end))>BROWSER_RESPONSE_BYTES&&end>offset+1)end=offset+Math.max(1,Math.floor((end-offset)*.75));
  if(end<page.text.length&&end>offset+1&&/[\uD800-\uDBFF]/.test(page.text[end-1])&&/[\uDC00-\uDFFF]/.test(page.text[end]))end--;
  return build(end);
 }
 search({snapshotId,query,offset=0,limit=5}){
  const page=this.get(snapshotId);
  if(typeof query!=='string'||!query.trim()||query.length>200||!integer(offset,0,page.text.length)||!integer(limit,1,5))throw Error('Geçersiz sayfa araması. Kısa bir metin ve geçerli offset kullan.');
  const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');pattern.lastIndex=offset;
  const matches=[];let match,nextOffset=null;
  while((match=pattern.exec(page.text))){
   if(matches.length===limit){nextOffset=match.index;break;}
   const start=Math.max(0,match.index-200),end=Math.min(page.text.length,match.index+match[0].length+400);
   matches.push({offset:match.index,endOffset:match.index+match[0].length,contextOffset:start,text:page.text.slice(start,end)});
  }
  const result={url:page.url,snapshotId:page.id,totalCharacters:page.text.length,query,matches,nextOffset,cached:true};
  while(size(result)>BROWSER_RESPONSE_BYTES&&matches.length>1){result.nextOffset=matches.pop().offset;}
  return result;
 }
}
