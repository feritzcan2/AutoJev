(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  // Consent managers commonly render inside open shadow roots. Traverse those
  // roots and hit-test their real controls; never click through an overlay.
  const parent=e=>e.assignedSlot||e.parentElement||e.getRootNode()?.host||null;
  const contains=(root,e)=>{for(let p=e;p;p=parent(p))if(p===root)return true;return false;};
  const closest=(e,selector)=>{for(let p=e;p;p=parent(p))if(p.matches?.(selector))return p;return null;};
  const queryAll=(root,selector)=>{
    const found=[...root.querySelectorAll(selector)];
    for(const host of root.querySelectorAll('*'))if(host.shadowRoot)found.push(...queryAll(host.shadowRoot,selector));
    return found;
  };
  const hitAt=(x,y)=>{
    let hit=document.elementFromPoint(x,y);
    while(hit?.shadowRoot){const next=hit.shadowRoot.elementFromPoint(x,y);if(!next||next===hit)break;hit=next;}
    return hit;
  };
  const safe = e => !['password','file','hidden'].includes(e.type);
  // A styled checkbox/radio often lays its transparent native input over the
  // box it draws; that input is still the visible click surface.
  const drawnToggle = e => e.tagName==='INPUT' && ['checkbox','radio'].includes(e.type) &&
    e.checkVisibility({checkVisibilityCSS:true}) && getComputedStyle(e).pointerEvents!=='none' &&
    !!e.parentElement?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && (()=>{
      const r=e.getBoundingClientRect(),b=e.parentElement.getBoundingClientRect();
      return r.width>=8&&r.height>=8&&r.left>=b.left-1&&r.right<=b.right+1&&r.top>=b.top-1&&r.bottom<=b.bottom+1;
    })();
  const visible = e => !closest(e,'[aria-hidden="true"],[inert]') &&
    (e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) || drawnToggle(e));
  // A transparent native select laid over a styled caption still receives the
  // pointer and is operated by value, never by a click on its pixels. Treat it
  // as a control when it is not hidden by CSS and, while in view, a hit at its
  // center lands on the select itself rather than on a widget covering it.
  const operableSelect = e => {
    if (e.tagName!=='SELECT' || closest(e,'[aria-hidden="true"],[inert]') || !e.checkVisibility({checkVisibilityCSS:true}) || getComputedStyle(e).pointerEvents==='none') return false;
    const r=e.getBoundingClientRect();if (r.width<=1 || r.height<=1) return false;
    if (r.bottom<=0 || r.right<=0 || r.top>=innerHeight || r.left>=innerWidth) return true;
    return hitAt(Math.max(0,r.left)+(Math.min(innerWidth,r.right)-Math.max(0,r.left))/2,Math.max(0,r.top)+(Math.min(innerHeight,r.bottom)-Math.max(0,r.top))/2)===e;
  };
  const inView = e => {
    const r=e.getBoundingClientRect();
    return visible(e) && r.width>1 && r.height>1 && r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth;
  };
  // React Select hides its search input after selection and renders a separate
  // value. Scope this component adapter to one actual combobox, never a form.
  const componentPart=(e,part)=>[...e.classList].some(c=>c.endsWith('__'+part));
  cache.combo=e=>{
    if(e?.tagName!=='INPUT'||e.getAttribute('role')!=='combobox')return null;
    for(let p=e.parentElement,depth=0;p&&depth<4;p=p.parentElement,depth++){
      if(p.matches('form,body,dialog'))break;
      if(componentPart(p,'control')&&p.querySelectorAll('input[role="combobox"]').length===1){
        // A single choice shows one value; a multiple choice shows one chip per answer.
        const values=[...p.querySelectorAll('div,span')].filter(n=>(componentPart(n,'single-value')||componentPart(n,'multi-value__label'))&&visible(n));
        return {control:p,values:values.map(n=>(n.innerText||'').replace(/\s+/g,' ').trim()).filter(Boolean)};
      }
    }
    // A select combobox: a read-only, often transparent input, or an empty
    // search input, over a box that shows the choice as text beside it, or a
    // placeholder while nothing is chosen.
    if(!(e.readOnly||!e.value)||!(e.hasAttribute('aria-controls')||e.hasAttribute('aria-owns')))return null;
    const row=e.getBoundingClientRect();
    // Labels, buttons and links in the box are never the choice; next to an
    // editable input only text on the input's own row is.
    const choice=(n,p)=>{
      for(let m=n;m&&m!==p;m=m.parentElement)if(m.matches('label,button,a,[role="button"],[role="listbox"]'))return false;
      if(e.readOnly)return true;
      const r=n.getBoundingClientRect();return r.top<row.bottom&&r.bottom>row.top;
    };
    let box=null;
    for(let p=e.parentElement,depth=0;p&&depth<3;p=p.parentElement,depth++){
      if(p.matches('form,body,dialog,label')||p.querySelectorAll('input,select,textarea').length!==1)break;
      if(!visible(p))continue;
      box??=p;
      const placeholder=n=>/placeholder/i.test(n.className?.baseVal??n.className??'');
      const values=[...p.querySelectorAll('*')].filter(n=>!n.contains(e)&&!n.childElementCount&&choice(n,p)&&
        ![...p.querySelectorAll('*')].some(m=>placeholder(m)&&m.contains(n))&&visible(n))
        .map(n=>(n.textContent||'').replace(/\s+/g,' ').trim()).filter(Boolean);
      if(values.length||[...p.querySelectorAll('*')].some(placeholder))return {control:p,values};
    }
    return box?{control:box,values:[]}:null;
  };
  // Custom checkboxes/radios often hide the native input. Only its associated
  // HTML label may stand in for it; nearby text is never guessed as a target.
  // Resolve a safe scroll destination independently of viewport hit testing.
  // A styled native input can be covered by its own label's decoration.
  const labelsFor=e=>[...(e.labels||[])].filter(l=>l.control===e && visible(l) &&
    !closest(l,'[aria-disabled="true"],[inert]'));
  cache.scrollTarget=e=>{
    if (!e?.isConnected || closest(e,'[aria-hidden="true"],[aria-disabled="true"],[inert]')) return null;
    if (e.tagName==='INPUT' && ['checkbox','radio'].includes(e.type))
      return labelsFor(e)[0] || (visible(e)?e:null);
    if(!visible(e)){const combo=cache.combo(e);if(combo&&visible(combo.control))return combo.control;}
    return visible(e)||operableSelect(e)?e:null;
  };
  // A site may draw the box with the element that names the input
  // (aria-labelledby) laid over it; a click there is a click on the box.
  const drawnByName=(e,hit)=>!!hit && e.tagName==='INPUT' && ['checkbox','radio'].includes(e.type) &&
    (e.getAttribute('aria-labelledby')||'').split(/\s+/).some(id=>{const n=id&&e.getRootNode().getElementById?.(id);return n&&contains(n,hit);}) &&
    !closest(hit,'a[href],button,input,select,textarea,[role="link"],[role="button"]');
  cache.target=e=>{
    if (!cache.scrollTarget(e)) return null;
    if (e.tagName==='INPUT' && ['checkbox','radio'].includes(e.type)) {
      if (inView(e)){const r=e.getBoundingClientRect(),hit=hitAt(r.x+r.width/2,r.y+r.height/2);if(contains(e,hit)||drawnByName(e,hit))return e;}
      return labelsFor(e).find(inView) || null;
    }
    return cache.scrollTarget(e);
  };
  cache.clickPoint=e=>{
    const target=cache.target(e);if (!target) return null;
    const proxy=target!==e;
    for (const r of target.getClientRects()) {
      const left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
      if (right<=left || bottom<=top) continue;
      for (const [fx,fy] of proxy ? [[.5,.5],[.1,.5],[.9,.5],[.1,.1],[.9,.9]] : [[.5,.5]]) {
        const x=left+(right-left)*fx,y=top+(bottom-top)*fy,hit=hitAt(x,y);
        // A combobox's chosen value drawn over its input belongs to the same box.
        if (!hit || !contains(target,hit) && !(target===e && (contains(cache.combo(e)?.control,hit) || drawnByName(e,hit)))) continue;
        // Clicking a link/button inside a label must not activate that control.
        const interactive=closest(hit,'a[href],button,input,select,textarea,[role="link"],[role="button"]');
        if (proxy && interactive && interactive!==e && contains(target,interactive)) continue;
        return {x,y};
      }
    }
    return null;
  };
  // Slots have no layout box of their own. Read their assigned content (or
  // fallback), while preserving hidden/inert and CSS visibility restrictions.
  const nameVisible=e=>visible(e)||(e.tagName==='SLOT' &&
    !closest(e,'[aria-hidden="true"],[inert]') && getComputedStyle(e).display==='contents' &&
    getComputedStyle(e).visibility==='visible' && getComputedStyle(e).opacity!=='0');
  const nameChildren=e=>e.tagName==='SLOT' ?
    (e.assignedNodes().length?e.assignedNodes({flatten:true}):e.childNodes) : e.childNodes;
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(e.getRootNode().getElementById?.(id)||document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...nameChildren(e)].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && nameVisible(n) && !n.matches('[role="listbox"],[role="option"],.dropdown-container') ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  // Some custom dropdown triggers have a real click handler but no ARIA role.
  // Discover only small, named leaf controls; never invoke framework handlers
  // or promote a form/container merely because events bubble through it.
  // In Jev's isolated world a framework's handler properties are not visible,
  // so an inline onclick attribute or a pointer cursor that starts at this
  // element (not inherited from a clickable ancestor) also counts.
  const ownPointer=e=>getComputedStyle(e).cursor==='pointer'&&(!e.parentElement||getComputedStyle(e.parentElement).cursor!=='pointer');
  const customClick=e=>{
    if(!e.matches('div,span'))return false;
    const handler=typeof e.onclick==='function'||e.hasAttribute('onclick')||Object.keys(e).some(k=>k.startsWith('__reactProps$')&&typeof Object.getOwnPropertyDescriptor(e,k)?.value?.onClick==='function')||ownPointer(e);
    if(!handler||!visible(e)||e.querySelector(selector))return false;
    const label=name(e).trim();return label.length>0&&label.length<=200;
  };
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
      if (['text','email','url','tel','date'].includes(e.type)) return 'textbox';
    }
    if(customClick(e))return 'button';
    return null;
  };
  // Closed cookie widgets can retain aria-modal on a zero-height shell.
  // A boxless active dialog may still contain a visible positioned panel.
  const modalSurface=e=>visible(e)&&[e,...queryAll(e,'*')].some(n=>{
    if(!visible(n))return false;
    const r=n.getBoundingClientRect();return r.width>1&&r.height>1;
  });
  // Dialog semantics scope the page only for a layer over it: a native modal
  // dialog, or an open dialog in (or, when boxless, holding) a fixed layer.
  // A closed <dialog> kept in the layout by CSS, an inline widget that carries
  // dialog roles (a date picker), and a non-modal popup that a field outside
  // it controls (suggestions) stay part of the page and never hide the form.
  const fixedLayer=n=>getComputedStyle(n).position==='fixed';
  const ownedPopup=d=>!d.matches('[aria-modal="true"]')&&queryAll(document,'[aria-controls],[aria-owns]').some(c=>!contains(d,c)&&
    [...(c.getAttribute('aria-controls')||'').split(/\s+/),...(c.getAttribute('aria-owns')||'').split(/\s+/)]
      .some(id=>{const t=id&&(c.getRootNode().getElementById?.(id)||document.getElementById(id));return !!t&&contains(d,t);}));
  const overlay=e=>{
    if(e.tagName==='DIALOG'&&!e.open)return false;
    if(e.matches('dialog:modal'))return true;
    if(ownedPopup(e))return false;
    for(let p=e;p&&p.nodeType===1;p=parent(p))if(fixedLayer(p))return true;
    const r=e.getBoundingClientRect();
    return (r.width<=1||r.height<=1)&&queryAll(e,'*').some(n=>visible(n)&&fixedLayer(n));
  };
  const modal=queryAll(document,'dialog[open],[role="dialog"],[aria-modal="true"]').filter(e=>modalSurface(e)&&overlay(e)).at(-1);
  const root=modal||document.body;
  // Read semantic state, never infer selection from color, focus or click success.
  // Resolve a question from a labelled group or one bounded field wrapper; no
  // site-specific selectors and no association with a whole form's first label.
  cache.choice=e=>{
    if(!e?.isConnected)return null;
    const r=role(e),pressed=e.getAttribute('aria-pressed');
    const native=e.tagName==='INPUT'&&['radio','checkbox'].includes(e.type);
    const attribute=native?'checked':['radio','checkbox','switch'].includes(r)?'aria-checked':r==='button'&&['true','false','mixed'].includes(pressed)?'aria-pressed':null;
    if(!attribute)return null;
    const raw=native?String(e.checked):e.getAttribute(attribute);
    let question='';
    for(let p=parent(e),depth=0;p&&contains(root,p)&&depth<5;p=parent(p),depth++){
      if(p.matches('form,body,dialog,[role="dialog"]'))break;
      if(p.matches('fieldset,[role="group"],[role="radiogroup"]')){
        const ids=(p.getAttribute('aria-labelledby')||'').split(/\s+/);
        question=ids.map(id=>name(document.getElementById(id))).filter(Boolean).join(' ')||p.getAttribute('aria-label')||name([...p.children].find(n=>n.tagName==='LEGEND'));
        if(question)break;
      }
      const labels=[...p.children].filter(n=>n.tagName==='LABEL'&&visible(n)&&!n.contains(e)&&!n.querySelector(selector));
      if(labels.length===1&&p.querySelectorAll('label').length===1){question=name(labels[0]);break;}
      if(p.querySelectorAll('label,legend,[role="group"],[role="radiogroup"]').length>1)break;
    }
    const semantic=window.__jobloopFieldContext?.(e);
    if(!question&&semantic?.question!==name(e))question=semantic?.question||'';
    if(!question&&['checkbox','switch'].includes(r))question=semantic?.label||name(e);
    return {question,option:name(e)||r,selected:raw==='true'?true:raw==='false'?false:null,attribute};
  };
  // A select-only dropdown: a combobox or a button that opens a listbox/tree
  // popup (not a menu or dialog). Labelled triggers are answer fields.
  cache.popupTrigger=e=>!!e&&!['INPUT','TEXTAREA','SELECT'].includes(e.tagName)&&(e.getAttribute('role')==='combobox'||
    (role(e)==='button'&&['listbox','tree','true'].includes(e.getAttribute('aria-haspopup'))&&(e.hasAttribute('aria-labelledby')||e.hasAttribute('aria-label')||e.labels?.length>0)));
  const fieldContext=e=>e.matches('input,textarea,select,[role="combobox"],[role="textbox"],[role="checkbox"],[role="radio"]')||cache.popupTrigger(e)?window.__jobloopFieldContext?.(e):null;
  // Button-driven picklists isolated in a shadow component, with one local
  // label and one dropdown. Never infer ownership from a whole form/page.
  cache.buttonList=e=>{
    if(e?.tagName!=='BUTTON'||e.form&&e.type!=='button')return null;
    const r=e.getRootNode();if(!r.host||r.querySelectorAll('button').length!==1)return null;
    const label=e.closest('label'),lists=r.querySelectorAll('.dropdown > ul');
    if(!label||lists.length!==1)return null;
    const question=[...label.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join(' ').trim();
    const caption=e.querySelector('.value');
    if(!question||!caption)return null;
    const items=[...lists[0].children];
    if(!items.length||items.some(n=>n.tagName!=='LI'||n.querySelector('a,button,input,select,textarea')||getComputedStyle(n).cursor!=='pointer'))return null;
    return {question,caption:caption.textContent.trim(),list:lists[0],items};
  };
  const choiceLabel=(e,choice)=>choice?.question?choice.question+' → '+choice.option:cache.buttonList(e)?.question||fieldContext(e)?.label||name(e)||role(e);
  const candidates=queryAll(root,selector);
  for(const e of queryAll(root,'div,span'))if(customClick(e)&&!candidates.includes(e))candidates.push(e);
  // Associate suggestions with their input, never with matching text elsewhere
  // in the page. Some widgets expose plain divs rather than ARIA options.
  const listOptions=lists=>{
    const options=[];
    for(const list of lists.filter(visible)){
      let items=queryAll(list,'[role="option"],[role="treeitem"]').filter(n=>!n.querySelector('[role="treeitem"]'));
      if(!items.length){
        const group=list.querySelector('.dropdown-results')||list;
        items=[...group.children].filter(n=>n.matches('div,li')&&!n.querySelector('input,button,a,select,textarea')&&getComputedStyle(n).cursor==='pointer');
      }
      for(const item of items){
        if(item.matches('a[href],input,select,textarea,button:not([type="button"])')||item.querySelector('a[href],button,input,select,textarea'))continue;
        const label=(item.innerText||'').replace(/\s+/g,' ').trim();
        if(!label||label.length>500||!visible(item)||item.closest('[aria-disabled="true"],[inert]')||item.matches(':disabled'))continue;
        options.push({node:identity(item),label,selected:item.getAttribute('aria-selected')==='true'||[...item.classList].some(c=>c.endsWith('__option--is-selected'))});
      }
    }
    return options;
  };
  const idList=(e,key)=>(e.getAttribute(key)||'').split(/\s+/).filter(Boolean);
  const byId=(e,id)=>e.getRootNode().getElementById?.(id)||document.getElementById(id);
  const deepActive=()=>{let a=document.activeElement;while(a?.shadowRoot?.activeElement)a=a.shadowRoot.activeElement;return a;};
  // The popup of a dropdown trigger, by ARIA only: aria-controls/owns, a list
  // labelled by the same label or by the trigger, or (while expanded) the one
  // list holding focus or the trigger's active descendant. Never page text.
  const popupLists=e=>{
    const owned=[...idList(e,'aria-controls'),...idList(e,'aria-owns')].map(id=>byId(e,id)).filter(Boolean);
    if(owned.length)return owned;
    const all=queryAll(document,'[role="listbox"],[role="tree"]').filter(l=>!e.contains(l)&&visible(l));
    const labels=new Set([...idList(e,'aria-labelledby'),e.id].filter(Boolean));
    const labelled=all.filter(l=>idList(l,'aria-labelledby').some(id=>labels.has(id)));
    if(labelled.length)return labelled;
    if(e.getAttribute('aria-expanded')!=='true')return [];
    const active=deepActive(),descendant=byId(e,e.getAttribute('aria-activedescendant')||'');
    const focused=all.filter(l=>[active,descendant].some(n=>n&&(contains(l,n)||idList(n,'aria-controls').includes(l.id))));
    return focused.length===1?focused:[];
  };
  // Visible caption of a trigger: its own text, without popups or placeholders.
  const caption=e=>{
    const parts=[];
    const walk=n=>{for(const c of n.childNodes){
      if(c.nodeType===3)parts.push(c.textContent);
      else if(c.nodeType===1&&visible(c)&&!c.matches('[role="listbox"],[role="tree"],[role="option"],[role="treeitem"]'))walk(c);
    }};
    walk(e);
    const text=parts.join(' ').replace(/\s+/g,' ').trim();
    const placeholders=[e,...e.querySelectorAll('[data-placeholder],[aria-placeholder],[placeholder]')].flatMap(n=>[n.getAttribute('aria-placeholder'),n.getAttribute('data-placeholder'),n.getAttribute('placeholder')]);
    return placeholders.includes(text)?'':text;
  };
  cache.autocomplete=e=>{
    if(cache.popupTrigger(e)){
      if(!e.isConnected||e.matches(':disabled')||closest(e,'[aria-disabled="true"],[inert]'))return null;
      const lists=popupLists(e),options=listOptions(lists);
      // A search box in the popup: one that controls the list, or the focused
      // input that shares a small container with the list and no other input.
      const active=deepActive(),near=l=>{for(let p=l,d=0;p&&d<6;p=p.parentElement,d++)if(p.contains(active))return p.querySelectorAll('input').length===1;return false;};
      const search=queryAll(document,'input[aria-controls]').find(n=>visible(n)&&lists.some(l=>l.id&&idList(n,'aria-controls').includes(l.id)))||
        (active?.tagName==='INPUT'&&['text','search'].includes(active.type)&&visible(active)&&lists.some(near)?active:null);
      return {association:'popup',editable:false,searchable:true,search:search?identity(search):null,value:caption(e),selectedLabels:[],
        expanded:e.getAttribute('aria-expanded')==='true'||lists.some(visible),options};
    }
    const pick=cache.buttonList(e);
    if(pick){
      if(e.matches(':disabled')||closest(e,'[aria-disabled="true"],[inert]'))return null;
      const expanded=visible(pick.list)&&pick.list.getBoundingClientRect().height>1&&pick.list.parentElement.getBoundingClientRect().height>1;
      return {association:'shadow-button-list',editable:false,value:pick.caption,selectedLabels:[],
        expanded,options:expanded?pick.items.filter(visible).map(item=>({
          node:identity(item),label:item.textContent.replace(/\s+/g,' ').trim(),selected:item.getAttribute('aria-selected')==='true'
        })):[]};
    }

    // A read-only input is a list only as a select-only combobox.
    const selectOnly=e?.readOnly&&e.getAttribute('role')==='combobox';
    if(!e?.isConnected||e.tagName!=='INPUT'||!['text','search'].includes(e.type)||e.readOnly&&!selectOnly||e.matches(':disabled')||e.closest('[aria-disabled="true"],[inert]'))return null;
    const ids=(e.getAttribute('aria-controls')||e.getAttribute('aria-owns')||'').split(/\s+/).filter(Boolean);
    let lists=ids.map(id=>e.getRootNode().getElementById?.(id)||document.getElementById(id)).filter(Boolean),association=ids.length?'aria':null;
    if(!ids.length){
      for(let p=parent(e),depth=0;p&&contains(root,p)&&depth<5;p=parent(p),depth++){
        if(p.matches('form,body,dialog,[role="dialog"]'))break;
        if([...p.querySelectorAll('input:not([type="hidden"]),textarea,select')].filter(n=>!n.closest('[aria-hidden="true"]')).length!==1)break;
        const found=[...p.querySelectorAll('[role="listbox"],.dropdown-container,.autocomplete-results,.suggestions,[role="menu"]')];
        if(found.length){lists=found;association='field';break;}
      }
    }
    if(!lists.length&&e.getAttribute('role')!=='combobox'&&!e.hasAttribute('aria-autocomplete'))return null;
    const options=listOptions(lists);
    return {association,options,expanded:e.getAttribute('aria-expanded')==='true'||lists.some(visible),selectedLabels:cache.combo(e)?.values??[],
      ...(selectOnly?{editable:false,searchable:false}:{})};
  };
  const suggestionOwners=new Map();
  for(const e of candidates){
    const autocomplete=cache.autocomplete(e);if(!autocomplete)continue;
    for(const option of autocomplete.options){
      suggestionOwners.set(option.node,identity(e));
      const node=cache.nodes.get(option.node);if(!candidates.includes(node))candidates.push(node);
    }
  }
  // An open dropdown may mark the page behind its popup aria-hidden; its
  // rendered trigger, whose popup is shown, stays the same control.
  const openTrigger=e=>e.getAttribute('aria-expanded')==='true' &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && !closest(e,'[inert]') &&
    (e.getAttribute('aria-controls')||e.getAttribute('aria-owns')||'').split(/\s+/)
      .some(id=>{const p=id&&(e.getRootNode().getElementById?.(id)||document.getElementById(id));return !!p&&visible(p);});
  cache.controlGuard=e=>{
    if (!e?.isConnected || !safe(e) || (!visible(e)&&!cache.scrollTarget(e)&&!operableSelect(e)&&!openTrigger(e))) return null;
    return [performance.timeOrigin,location.href,identity(e),e.tagName,e.type,role(e),choiceLabel(e,cache.choice(e)),
      e.value??null,e.checked??null,e.matches(':disabled'),!!closest(e,'[aria-disabled="true"],[inert]'),e.readOnly??null,
      e.required??null,e.form?identity(e.form):null,e.form?.action??null,
      e.tagName==='SELECT'?[...e.options].map(o=>[o.value,o.label,o.disabled,!!o.closest('optgroup[disabled]')]):null,cache.choice(e),cache.combo(e)?.values??null,e.getAttribute('href')];
  };
  const controls=[],control_guards={};let fieldCount=0,otherCount=0;
  for(const e of candidates){
    if(!safe(e)||e.matches(':disabled')||closest(e,'[aria-disabled="true"],[inert]'))continue;
    const rname=role(e);if(!rname)continue;
    const choice=cache.choice(e);
    if(!choice&&!['INPUT','TEXTAREA','SELECT'].includes(e.tagName)&&!['button','link','textbox','combobox','checkbox','radio','switch'].includes(rname))continue;
    // Long forms: page links and buttons must not crowd out later answer fields.
    const field=!!choice||['INPUT','TEXTAREA','SELECT'].includes(e.tagName)||!['button','link'].includes(rname);
    if(field?fieldCount>=200:otherCount>=80){if(fieldCount>=200&&otherCount>=80)break;continue;}
    const guard=cache.controlGuard(e);if(!guard)continue;
    if(field)fieldCount++;else otherCount++;
    const node=identity(e);control_guards[node]=guard;
    controls.push({node,...fieldContext(e),label:choiceLabel(e,choice),role:rname,value:e.value??'',required:fieldContext(e)?.required??(e.required?true:null),...(choice?{choice}:{}),
      visible:!!cache.clickPoint(e),nativeSelect:e.tagName==='SELECT',optionCount:e.options?.length,
      // Option names let the agent find a select by what it offers (a date
      // order, a region) even when the select has no label of its own.
      ...(e.tagName==='SELECT'?{selectedLabel:e.selectedOptions[0]?.label??'',options:[...e.options].slice(0,12).map(o=>o.label)}:{}),
      ...(cache.autocomplete(e)?{autocomplete:true,selectedLabels:cache.autocomplete(e).selectedLabels,suggestions:cache.autocomplete(e).options.map(o=>o.label).slice(0,20)}:{})});
  }
  // Discover nested scrolling from actual controls, including forms in dialogs.
  // With a modal open, never choose the background document as a fallback.
  const scrollNodes=new Set();
  for(const e of candidates)for(let p=parent(e);p&&contains(root,p);p=parent(p)){
    if(p.clientHeight>60&&p.scrollHeight>p.clientHeight+2&&/auto|scroll|overlay/.test(getComputedStyle(p).overflowY)&&inView(p))scrollNodes.add(p);
  }
  if(!modal&&document.scrollingElement.scrollHeight>innerHeight+2)scrollNodes.add(document.scrollingElement);
  cache.scrollState=e=>e===document.scrollingElement?{top:scrollY,height:e.scrollHeight,viewport:innerHeight}:{top:e.scrollTop,height:e.scrollHeight,viewport:e.clientHeight};
  const scrollTargets=[...scrollNodes].slice(0,8).map(e=>({node:identity(e),label:e===document.scrollingElement?'Page':e.getAttribute('aria-label')||'Form content',...cache.scrollState(e)}));
  cache.scrollGuard=e=>e?.isConnected&&scrollNodes.has(e)?[performance.timeOrigin,location.href,identity(e),modal?identity(modal):null,...Object.values(cache.scrollState(e))]:null;
  const scroll_guards=Object.fromEntries(scrollTargets.map(s=>[s.node,cache.scrollGuard(cache.nodes.get(s.node))]));
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    queryAll(document,'input,textarea,select').filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    const target=cache.target(e);if (!target) return null;
    const scope=closest(e,'form,dialog,[role="dialog"],article,li,tr,[role="row"]') || parent(e);
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||'',identity(target),name(target),e.getAttribute('aria-pressed'),cache.choice(e)];
  };
  const actions=[];
  for (const e of candidates) {
    if (!safe(e) || e.matches(':disabled') || closest(e,'[aria-disabled="true"]')) continue;
    const target=cache.target(e);if (!target) continue;
    if(!cache.clickPoint(e))continue;
    const r=target.getBoundingClientRect(), x=Math.max(0,r.x)+(Math.min(innerWidth,r.right)-Math.max(0,r.x))/2, y=Math.max(0,r.y)+(Math.min(innerHeight,r.bottom)-Math.max(0,r.y))/2, rname=suggestionOwners.has(identity(e))?'option':role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const choice=cache.choice(e);
    const base={node:identity(e),role:rname,label:choiceLabel(e,choice),...(choice?{choice}:{}),
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded','pressed']) {
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
  const words=[], textRoots=[root,...queryAll(root,'*').filter(e=>e.shadowRoot).map(e=>e.shadowRoot)];
  const range=document.createRange(); let node,length=0;
  for(const textRoot of textRoots){
   const walker=document.createTreeWalker(textRoot,NodeFilter.SHOW_TEXT);
   while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
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
