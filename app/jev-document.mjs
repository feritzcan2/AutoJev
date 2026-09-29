// Executed in the page. Read rendered DOM content without scrolling, clicking,
// form values or hidden application state. Unlike the action snapshot, reading
// is not limited to the viewport. The automation layer paginates this result.
export function renderedDocument(){
 const body=document.body;if(!body)return {url:location.href,text:'',links:[]};
 const words=[],links=[],seenLinks=new Set(),range=document.createRange();
 const stack=[body];
 while(stack.length){
  const node=stack.pop();
  if(node.nodeType===Node.TEXT_NODE){
   const text=node.textContent.replace(/\s+/g,' ').trim();if(!text)continue;
   range.selectNodeContents(node);
   if([...range.getClientRects()].some(r=>r.width>0&&r.height>0))words.push(text);
   continue;
  }
  if(node.nodeType!==Node.ELEMENT_NODE)continue;
  const e=node;
  if(e.matches('script,style,noscript,template,input,textarea,select,[hidden],[aria-hidden="true"],[inert]'))continue;
  const style=getComputedStyle(e);
  if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)continue;
  // Closed details render only their summary. Do not include collapsed content.
  if(e.tagName==='DETAILS'&&!e.open){const summary=[...e.children].find(c=>c.tagName==='SUMMARY');if(summary)stack.push(summary);continue;}
  if(e.tagName==='A'&&e.hasAttribute('href')&&[...e.getClientRects()].some(r=>r.width>0&&r.height>0)){
   let url;try{url=new URL(e.href,location.href);}catch{}
   if(url&&['http:','https:'].includes(url.protocol)&&!url.username&&!url.password){
    const label=(e.getAttribute('aria-label')||e.innerText||'').replace(/\s+/g,' ').trim(),key=JSON.stringify([url.href,label]);
    if(!seenLinks.has(key)){seenLinks.add(key);links.push({text:label,url:url.href});}
    // Place the real link next to its card text as well as in the link index.
    words.push(`Link: ${label?label+' — ':''}${url.href}`);
   }
  }
  const assigned=e.tagName==='SLOT'?e.assignedNodes({flatten:true}):[];
  const children=assigned.length?assigned:e.shadowRoot?.childNodes??e.childNodes;
  for(let i=children.length-1;i>=0;i--)stack.push(children[i]);
 }
 return {url:location.href,text:words.join('\n'),links};
}

export async function documentObservation(slot,value){
 const document=await slot.page.evaluate(renderedDocument);
 if(document.url!==value.url)throw Error('Sayfa okuma sırasında yönlendi; browser_read ile güncel sayfayı tekrar oku.');
 const result={...value,observationMode:'document',controlMaps:'replace',mapDeltas:false,
  viewportText:value.text??slot.presented?.text??'',text:document.text,links:document.links,
  reading:{scope:'rendered_document',truncated:false,unreadFrames:slot.page.frames().length-1,
   guidance:'Includes currently rendered main-document text and actual links below the fold, including open shadow roots. Hidden content, form values and iframe contents are excluded. Lazy or virtualized listings may require browser_jev_scroll with a current scrollTargets.controlId, then another read. No guessed URLs. Read details through observed links when list cards omit addresses. An absent address remains unknown.'}};
 delete result.textUnchanged;
 // Action IDs come from the current guarded viewport snapshot. Document links
 // are reading/navigation evidence, never a replacement click target map.
 return result;
}
