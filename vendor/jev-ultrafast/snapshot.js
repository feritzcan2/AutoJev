(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const inView = e => {
    const r=e.getBoundingClientRect();
    return visible(e) && r.width>1 && r.height>1 && r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth;
  };
  // Custom checkboxes/radios often hide the native input. Only its associated
  // HTML label may stand in for it; nearby text is never guessed as a target.
  cache.target=e=>{
    if (!e?.isConnected || e.closest('[aria-hidden="true"],[inert]')) return null;
    if (e.tagName==='INPUT' && ['checkbox','radio'].includes(e.type)) {
      if (inView(e)) return e;
      return [...e.labels].find(l=>l.control===e && inView(l) && !l.closest('[aria-disabled="true"]')) || null;
    }
    return visible(e) ? e : null;
  };
  cache.clickPoint=e=>{
    const target=cache.target(e);if (!target) return null;
    const proxy=target!==e;
    for (const r of target.getClientRects()) {
      const left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
      if (right<=left || bottom<=top) continue;
      for (const [fx,fy] of proxy ? [[.5,.5],[.1,.5],[.9,.5],[.1,.1],[.9,.9]] : [[.5,.5]]) {
        const x=left+(right-left)*fx,y=top+(bottom-top)*fy,hit=document.elementFromPoint(x,y);
        if (!hit || !target.contains(hit)) continue;
        // Clicking a link/button inside a label must not activate that control.
        const interactive=hit.closest('a[href],button,input,select,textarea,[role="link"],[role="button"]');
        if (proxy && interactive && interactive!==e && target.contains(interactive)) continue;
        return {x,y};
      }
    }
    return null;
  };
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  const modal=[...document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]')].filter(visible).at(-1);
  const root=modal||document.body;
  const candidates=[...root.querySelectorAll(selector)];
  cache.controlGuard=e=>{
    if (!e?.isConnected || !safe(e) || (!visible(e)&&!cache.target(e))) return null;
    return [performance.timeOrigin,location.href,identity(e),e.tagName,e.type,role(e),name(e),
      e.value??null,e.checked??null,e.matches(':disabled'),!!e.closest('[aria-disabled="true"],[inert]'),e.readOnly??null,
      e.required??null,e.form?identity(e.form):null,e.form?.action??null,
      e.tagName==='SELECT'?[...e.options].map(o=>[o.value,o.label,o.disabled,!!o.closest('optgroup[disabled]')]):null];
  };
  const controls=[],control_guards={};
  for(const e of candidates){
    if(!safe(e)||e.matches(':disabled')||e.closest('[aria-disabled="true"],[inert]'))continue;
    const guard=cache.controlGuard(e),rname=role(e);if(!guard||!rname)continue;
    if(!['INPUT','TEXTAREA','SELECT'].includes(e.tagName)&&!['textbox','combobox','checkbox','radio','switch'].includes(rname))continue;
    const node=identity(e);control_guards[node]=guard;
    controls.push({node,label:name(e)||rname,role:rname,value:e.value??'',required:!!e.required,
      visible:!!cache.clickPoint(e),nativeSelect:e.tagName==='SELECT',optionCount:e.options?.length});
    if(controls.length>=80)break;
  }
  // Discover nested scrolling from actual controls, including forms in dialogs.
  // With a modal open, never choose the background document as a fallback.
  const scrollNodes=new Set();
  for(const e of candidates)for(let p=e.parentElement;p&&root.contains(p);p=p.parentElement){
    if(p.clientHeight>60&&p.scrollHeight>p.clientHeight+2&&/auto|scroll|overlay/.test(getComputedStyle(p).overflowY)&&inView(p))scrollNodes.add(p);
  }
  if(!modal&&document.scrollingElement.scrollHeight>innerHeight+2)scrollNodes.add(document.scrollingElement);
  cache.scrollState=e=>e===document.scrollingElement?{top:scrollY,height:e.scrollHeight,viewport:innerHeight}:{top:e.scrollTop,height:e.scrollHeight,viewport:e.clientHeight};
  const scrollTargets=[...scrollNodes].slice(0,8).map(e=>({node:identity(e),label:e===document.scrollingElement?'Page':e.getAttribute('aria-label')||'Form content',...cache.scrollState(e)}));
  cache.scrollGuard=e=>e?.isConnected&&scrollNodes.has(e)?[performance.timeOrigin,location.href,identity(e),modal?identity(modal):null,...Object.values(cache.scrollState(e))]:null;
  const scroll_guards=Object.fromEntries(scrollTargets.map(s=>[s.node,cache.scrollGuard(cache.nodes.get(s.node))]));
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    const target=cache.target(e);if (!target) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||'',identity(target),name(target)];
  };
  const actions=[];
  for (const e of candidates) {
    if (!safe(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const target=cache.target(e);if (!target) continue;
    if(!cache.clickPoint(e))continue;
    const r=target.getBoundingClientRect(), x=Math.max(0,r.x)+(Math.min(innerWidth,r.right)-Math.max(0,r.x))/2, y=Math.max(0,r.y)+(Math.min(innerHeight,r.bottom)-Math.max(0,r.y))/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      // Large native selects use the exact-option tool, not hundreds of actions.
      for (const o of e.options.length<=20?e.options:[]) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  const words=[], walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  const scroll=scrollTargets[0];
  if (scroll&&scroll.top+scroll.viewport<scroll.height-2) actions.push({id:'scroll_down',kind:'scroll',node:scroll.node,label:'Scroll down inside '+scroll.label,delta:560});
  if (scroll&&scroll.top>0) actions.push({id:'scroll_up',kind:'scroll',node:scroll.node,label:'Scroll up inside '+scroll.label,delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    focus:document.activeElement?identity(document.activeElement):null,scroll:{y:scrollY,height},scrollTargets,scroll_guards,controls,control_guards,actions,marker,page_key,guards,omitted_actions};
})()
