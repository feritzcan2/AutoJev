import {captchaProvider} from './captcha-provider.mjs';

// Turnstile may put its checkbox inside a closed shadow root. CDP can read
// the actual element without guessing a coordinate or changing page scripts.
export async function findTurnstileCheckbox(page,report=()=>{}){
 const found=[],deadline=Date.now()+1500;
 report('provider_not_ready');
 for(const frame of page.frames()){
  if(!frame.parentFrame())continue;
  let session,host;
  try{
   host=await frame.frameElement();
   // With scoped CDP attachment the host can be visible before the child
   // navigation arrives. Only a known provider host justifies this short wait;
   // the loaded frame URL must independently confirm the provider afterward.
   if(captchaProvider(frame.url())?.provider!=='turnstile'&&captchaProvider(await host.getAttribute('src'))?.provider!=='turnstile')continue;
   report('frame_hidden');
   if(!await host.evaluate(e=>{const r=e.getBoundingClientRect();return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&r.width>16&&r.height>16&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;}))continue;
   report('frame_loading');
   await frame.waitForURL(url=>captchaProvider(url.href)?.provider==='turnstile',{waitUntil:'domcontentloaded',timeout:Math.max(1,deadline-Date.now())});
   session=await page.context().newCDPSession(frame);
   const {root}=await session.send('DOM.getDocument',{depth:-1,pierce:true}),nodes=[root],candidates=[];
   while(nodes.length){
    const node=nodes.pop(),attrs=Object.fromEntries((node.attributes??[]).reduce((pairs,v,i,a)=>i%2?pairs:[...pairs,[v,a[i+1]]],[]));
    if(node.nodeName==='INPUT'&&attrs.type==='checkbox'||attrs.role==='checkbox')candidates.push(node.backendNodeId);
    nodes.push(...(node.children??[]),...(node.shadowRoots??[]));
   }
   report(candidates.length?'checkbox_not_actionable':'checkbox_not_ready');
   for(const backendNodeId of candidates){
    const {object}=await session.send('DOM.resolveNode',{backendNodeId});
    const ownedSession=session;
    const evaluate=async fn=>{
     const result=await ownedSession.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(){return (${fn.toString()})(this);}`,returnByValue:true});
     if(result.exceptionDetails)throw Error('Doğrulama kontrolü okunamadı.');return result.result.value;
    };
    const read=e=>{
     const r=e.getBoundingClientRect(),root=e.getRootNode(),hit=root.elementFromPoint?.(r.x+r.width/2,r.y+r.height/2);
     const labels=[...(e.labels??[])],x=r.x+r.width/2,y=r.y+r.height/2;
     // Styled native checkboxes can be transparent hit targets over a visible
     // label. Require that association, visible label text, and the actual
     // input at the click point; opacity alone must not hide an active control.
     const styled=e.matches('input[type="checkbox"]')&&Number(getComputedStyle(e).opacity)===0&&e.checkVisibility({checkVisibilityCSS:true})&&labels.some(l=>{
      const b=l.getBoundingClientRect();return l.textContent.trim()&&!l.closest('[inert],[aria-hidden="true"]')&&l.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&x>=b.left&&x<b.right&&y>=b.top&&y<b.bottom;
     });
     if(!e.isConnected||e.disabled||e.checked||e.closest('[inert],[aria-hidden="true"]')||['true','mixed'].includes(e.getAttribute('aria-checked'))||!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!styled||r.width<5||r.height<5||r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth||hit!==e&&!e.contains(hit))return null;
     return {origin:performance.timeOrigin,x,y,label:(e.getAttribute('aria-label')||labels.map(l=>l.textContent).join(' ')||e.textContent||'').trim()};
    };
    const meta=await evaluate(read);
    if(!meta?.label){await session.send('Runtime.releaseObject',{objectId:object.objectId});continue;}
    found.push({frame,meta,backendNodeId,evaluate,read,session:ownedSession,dispose:()=>ownedSession.detach().catch(()=>{})});
   }
   if(found.some(c=>c.session===session))session=null;
  }catch{report('frame_unavailable');}finally{await host?.dispose().catch(()=>{});await session?.detach().catch(()=>{});}
 }
 if(found.length===1){report('checkbox_ready');return found[0];}
 if(found.length>1)report('multiple_checkboxes');
 await Promise.all(found.map(c=>c.dispose()));return null;
}

