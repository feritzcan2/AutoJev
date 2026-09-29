// Keep navigation evidence outside the paged document text so an agent does
// not have to search escaped JSON just to find the current scroll position.
export function browserNavigation(response){
 const text=(response.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
 let page;try{page=JSON.parse(text.replace(/^Page URL: [^\n]+\n/,''));}catch{return undefined;}
 if(!Array.isArray(page.scrollTargets))return undefined;
 const scrollTargets=page.scrollTargets.slice(0,8).filter(s=>[s.top,s.height,s.viewport].every(Number.isFinite)).map(s=>{
  const remainingDown=Math.max(0,s.height-s.viewport-s.top);
  return {controlId:s.controlId,label:String(s.label??'').slice(0,120),top:s.top,height:s.height,viewport:s.viewport,remainingDown,atBottom:remainingDown<=2};
 });
 const pagination=(page.pagination??[]).filter(p=>p.url===null||typeof p.url==='string'&&p.url.length<=2000).slice(0,16).map(p=>{
  const targets=(page.clickTargets??[]).filter(t=>t.label===p.text);
  return {text:String(p.text??'').slice(0,120),url:p.url,kind:p.kind,current:p.current,disabled:p.disabled,...(targets.length===1?{targetId:targets[0].targetId}:{})};
 });
 const result={scrollTargets,pagination,paginationCount:page.pagination?.length??0,
  guidance:scrollTargets.some(s=>!s.atBottom)?'More content remains below. Continue with fresh scroll control IDs before concluding that pagination is missing. Use actual pagination URLs with their filters intact.':'At the current scroll boundary. Inspect pagination controls and freshly loaded content; this alone does not prove the last results page.'};
 while(Buffer.byteLength(JSON.stringify(result),'utf8')>5000&&pagination.length)pagination.pop();
 return result;
}
