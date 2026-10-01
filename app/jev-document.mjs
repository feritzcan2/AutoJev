// Executed in the page. Read rendered DOM content without scrolling, clicking,
// form values or hidden application state. Unlike the action snapshot, reading
// is not limited to the viewport. The automation layer paginates this result.
export function renderedDocument(){
 const body=document.body;if(!body)return {url:location.href,text:'',links:[]};
 const words=[],links=[],pagination=[],seenLinks=new Set(),range=document.createRange();
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
  if(e.matches('a,button,[role="button"],[role="link"]')&&[...e.getClientRects()].some(r=>r.width>0&&r.height>0)){
   const text=(e.getAttribute('aria-label')||e.innerText||'').replace(/\s+/g,' ').trim(),rel=e.getAttribute('rel')??'';
   const region=e.closest('nav,[role="navigation"],[class*="pagination" i],[data-testid*="pagination" i]');
   const regionLabel=region?[region.getAttribute('aria-label'),region.className,region.getAttribute('data-testid')].join(' '):'';
   if(/\b(next|prev)\b/i.test(rel)||region&&(/pagin|sayfa|seiten/i.test(regionLabel)||/^\d+$/.test(text)||/^(next|previous|volgende|vorige|sonraki|önceki)\b/i.test(text))){
    let url=null;try{const link=new URL(e.getAttribute('href'),location.href);if(e.hasAttribute('href')&&['http:','https:'].includes(link.protocol)&&!link.username&&!link.password)url=link.href;}catch{}
    pagination.push({text,url,rel,current:e.getAttribute('aria-current')==='page',disabled:e.matches(':disabled,[aria-disabled="true"]'),kind:e.tagName==='A'?'link':'button'});
   }
  }
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
 // Streaming render fragments are not listings until the site reveals them.
 // Report only readiness metadata; never expose the hidden fragment contents.
 const pendingFragments=body.querySelectorAll('[hidden][id^="S:"]').length;
 const busy=[...body.querySelectorAll('[aria-busy="true"]')].some(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
 const loading=document.readyState==='loading'||pendingFragments>0||busy;
 return {url:location.href,text:words.join('\n'),links,pagination,readiness:{loading,reason:pendingFragments?'stream_pending':busy?'aria_busy':loading?'document_loading':null}};
}

// Keep the full viewport when it contains anything absent from document text
// (for example a form value or frame). Only whitespace-equivalent duplicates
// can be omitted; this is not a summary of the page.
export function documentViewportText(documentText,viewportText=''){
 const normalized=documentText.replace(/\s+/g,' ').trim();
 return viewportText.split('\n').every(line=>normalized.includes(line.replace(/\s+/g,' ').trim()))?'':viewportText;
}

export async function documentObservation(slot,value){
 const document=await slot.page.evaluate(renderedDocument);
 if(document.url!==value.url)throw Error('Sayfa okuma sırasında yönlendi; browser_read ile güncel sayfayı tekrar oku.');
 const result={...value,observationMode:'document',controlMaps:'replace',mapDeltas:false,
  viewportText:documentViewportText(document.text,value.text??slot.presented?.text??''),text:document.text,links:document.links,pagination:document.pagination,
  reading:{scope:'rendered_document',truncated:false,readiness:document.readiness,unreadFrames:slot.page.frames().length-1,
   guidance:'Includes currently rendered main-document text and actual links below the fold, including open shadow roots. Hidden content, form values and iframe contents are excluded. Lazy or virtualized listings may require browser_jev_scroll with a current scrollTargets.controlId, then another read. No guessed URLs. Read details through observed links when list cards omit addresses. An absent address remains unknown.'}};
 delete result.textUnchanged;
 // These complete current maps already represent the actionable elements.
 // The browser retains its original snapshot for guarded next/act decisions.
 if(Array.isArray(result.controls)&&Array.isArray(result.clickTargets))delete result.elements;
 // Action IDs come from the current guarded viewport snapshot. Document links
 // are reading/navigation evidence, never a replacement click target map.
 return result;
}

export async function waitForDocument(slot,{attempts=8,delay=250}={}){
 // Bound a single observation, not the task. A stuck renderer remains visibly
 // pending and can be retried in a fresh read-only tab by the source worker.
 for(let i=0;i<attempts;i++){
  const state=await slot.page.evaluate(()=>({loading:document.readyState==='loading'||Boolean(document.querySelector('[hidden][id^="S:"]'))||[...document.querySelectorAll('[aria-busy="true"]')].some(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))}));
  if(!state.loading)return;
  await new Promise(resolve=>setTimeout(resolve,delay));
 }
}
