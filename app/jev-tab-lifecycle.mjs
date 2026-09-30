export const RESEARCH_TAB_LIMIT=12;

export function protectedResearchTabs(browser,state,{keepSources=true}={}){
  const protectedTabs=new Set([browser.homeId,...browser.tabJobs.keys(),...(state.jobs??[]).map(job=>job.resumeContext?.tabId).filter(Boolean),...(state.activeSourceTabIds??[]),...(keepSources?state.sourceTabIds??[]:[])]);
  let changed=true;
  while(changed){
    changed=false;
    for(const slot of browser.tabs.values())if(slot.openerId!==browser.homeId&&protectedTabs.has(slot.openerId)&&!protectedTabs.has(slot.id)){protectedTabs.add(slot.id);changed=true;}
  }
  return protectedTabs;
}

// Executed in each frame. A search query is disposable; application data,
// authentication and verification steps must survive automatic cleanup.
export function disposableResearchDocument(root){
  const document=root.ownerDocument;
  if(document.readyState==='loading')return false;
  const visible=e=>e.getClientRects().length>0;
  const hint=e=>[e.name,e.id,e.getAttribute('aria-label'),e.getAttribute('placeholder'),...(e.labels??[])].map(v=>typeof v==='string'?v:v?.textContent??'').join(' ');
  const searchQuery=e=>e.matches('input[type="search"],[role="searchbox"]')||/\b(job\s*title|jobtitel|keywords?|stichwort\w*|suchbegriff|arama)\b/i.test(hint(e));
  const searchControl=e=>{
    if(!e.matches('input')||!['text','search'].includes(e.type))return false;
    // Some search bars are unnamed comboboxes without a form/search role.
    // Require a small group with a query field AND an explicit search action.
    for(let group=e.parentElement;group&&!group.matches('body,html');group=group.parentElement){
      const fields=[...group.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select')];
      if(fields.length>6)break;
      if(fields.some(searchQuery)&&[...group.querySelectorAll('button,input[type="submit"],[role="button"]')].some(b=>/^(?:search(?: jobs)?|find jobs|jobs finden|suchen|suche|ara|iş ara)$/i.test((b.getAttribute('aria-label')||b.innerText||b.value||'').trim())))return true;
    }
    return false;
  };
  const defaultAlertEmail=e=>e.type==='email'&&e.value===e.defaultValue&&e.form&&/job[\s_-]*alert|newsletter|saved[\s_-]*search|notification[\s_-]*subscription/i.test(hint(e.form));
  if(/verify (?:that )?you(?:'re| are) (?:a )?human|complete (?:the |this )?captcha|verification code|security code|doğrulama kodu/i.test(document.body?.innerText??''))return false;
  if([...document.querySelectorAll('input[type="password"],input[type="file"],[autocomplete="one-time-code"],iframe[src*="captcha"],iframe[title*="challenge" i]')].some(visible))return false;
  return ![...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')].some(e=>{
    if(e.matches('input[type="hidden"],input[type="submit"],input[type="button"],input[type="reset"]'))return false;
    if(e.matches('input[type="search"],[role="searchbox"]')||e.closest('[role="search"]'))return false;
    if(e.matches('input')&&['text','search'].includes(e.type)&&/^(q|query|search|searchquery|keywords?|location|where|what)$/i.test(e.name||e.id))return false;
    if(searchControl(e)||defaultAlertEmail(e))return false;
    if(e.matches('input[type="checkbox"],input[type="radio"]'))return e.checked!==e.defaultChecked;
    if(e.type==='file')return e.files.length>0;
    if(e.tagName==='SELECT')return [...e.options].some(option=>option.selected!==option.defaultSelected);
    return Boolean((e.value??e.textContent??'').trim());
  });
}

export async function disposableResearchTab(slot){
  if(slot.verification||slot.page.isClosed())return false;
  const signal=AbortSignal.timeout(1000);
  try{
    for(const frame of slot.page.frames()){
      signal.throwIfAborted();
      if(!await frame.locator(':root').evaluate(disposableResearchDocument,undefined,{timeout:1000,signal}))return false;
    }
    return true;
  }catch{return false;}
}
