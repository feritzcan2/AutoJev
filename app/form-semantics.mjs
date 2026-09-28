// Runs inside each document. Associations are bounded to one field/group;
// never borrow the first question from a surrounding form or another field.
export function installFormSemantics(){
  const clean=s=>(s??'').replace(/\s+/g,' ').trim().slice(0,1000);
  const visible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!e.closest('[inert],[aria-hidden="true"]');
  const controls='input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select,[role="combobox"],[role="radio"],[role="checkbox"]';
  const labelText=e=>!e?'':e.nodeType===Node.TEXT_NODE?e.textContent:e.nodeType!==Node.ELEMENT_NODE||e.matches('input,textarea,select,script,style,.dropdown-container,[role="listbox"],[role="option"],[aria-hidden="true"]')?'':[...e.childNodes].map(labelText).join(' ');
  const refs=(e,key)=>(e.getAttribute(key)??'').split(/\s+/).map(id=>labelText(e.getRootNode().getElementById?.(id)||document.getElementById(id))).join(' ');
  window.__jobloopFieldContext=e=>{
    const explicit=clean(refs(e,'aria-labelledby')||e.getAttribute('aria-label')||[...(e.labels??[])].map(labelText).join(' '));
    const choice=['radio','checkbox'].includes(e.type)||['radio','checkbox'].includes(e.getAttribute('role'));
    let question='',help=clean(refs(e,'aria-describedby'));
    for(let p=e.parentElement,depth=0;p&&depth<5;p=p.parentElement,depth++){
      if(p.matches('form,body,dialog,[role="dialog"]'))break;
      const peers=[...p.querySelectorAll(controls)].filter(visible);
      const sameGroup=choice&&peers.every(n=>n===e||(n.type===e.type&&e.name&&n.name===e.name)||p.matches('fieldset,[role="radiogroup"]'));
      if(peers.some(n=>n!==e&&!n.contains(e)&&!e.contains(n))&&!sameGroup)break;
      if(p.matches('fieldset,[role="group"],[role="radiogroup"]'))question=clean(refs(p,'aria-labelledby')||p.getAttribute('aria-label')||[...p.children].find(n=>n.tagName==='LEGEND')?.textContent);
      if(!question){
        const preceding=[...p.children].filter(n=>!n.contains(e)&&!n.matches(controls)&&!n.querySelector(controls)&&visible(n)&&(n.compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING));
        const headings=preceding.filter(n=>n.matches('label,legend,h1,h2,h3,h4,h5,h6,[role="heading"]'));
        const texts=(headings.length?headings:preceding).map(n=>clean(n.textContent)).filter(Boolean);
        if(texts.length){question=texts[0];if(!help)help=texts.slice(1).join(' ');}
      }
      if(question)break;
    }
    const label=explicit||question||clean(e.getAttribute('placeholder'))||'';
    const required=e.required||e.getAttribute('aria-required')==='true'||/\*/.test(`${label} ${question}`)?true:e.getAttribute('aria-required')==='false'||/\boptional\b|isteğe bağlı/i.test(`${label} ${question}`)?false:null;
    return {label,question:question||explicit,help,required,...(choice?{option:explicit||clean(e.value)}:{})};
  };
}
