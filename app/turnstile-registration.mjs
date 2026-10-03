// Provider render parameters and callbacks live only in the current document.
// No token/key is logged or persisted. Capturing a render never starts a solve.
export const turnstileBridge='__autoJevTurnstileRegistration';
const installed=new WeakMap();

export function captureTurnstileRegistration(key){
 if(globalThis[key])return;
 const entries=new Map();let sequence=0;
 const contains=(parent,child)=>{for(let e=child;e;e=e.parentNode??e.host)if(e===parent)return true;return false;};
 const descriptor=entry=>({registration:entry.id,sitekey:entry.sitekey,action:entry.action,cdata:entry.cdata,managed:entry.managed,callback:!!entry.callback,answered:entry.answered});
 const string=value=>typeof value==='string'?value:null;
 const resolveCallback=value=>typeof value==='function'?value:typeof value==='string'&&/^[\w$]+$/.test(value)&&typeof globalThis[value]==='function'?globalThis[value]:null;
 const implicit=host=>{
  const candidates=[...document.querySelectorAll('[data-sitekey]')].filter(e=>contains(e,host));
  if(candidates.length!==1)return null;
  const container=candidates[0],callback=resolveCallback(container.getAttribute('data-callback'));
  if(!callback)return null;
  const parameters={sitekey:container.getAttribute('data-sitekey'),action:container.getAttribute('data-action'),cdata:container.getAttribute('data-cdata')};
  const old=[...entries.values()].find(e=>e.container===container);
  if(old&&old.callback===callback&&old.sitekey===parameters.sitekey&&old.action===parameters.action&&old.cdata===parameters.cdata)return old;
  if(old)entries.delete(old.id);
  const entry={id:++sequence,container,...parameters,implicit:true,managed:false,callback,answered:false};
  entries.set(entry.id,entry);return entry;
 };
 Object.defineProperty(globalThis,key,{value:{
  read(host){const matches=[...entries.values()].filter(e=>e.container?.isConnected&&contains(e.container,host));const entry=matches.length===1&&!matches[0].implicit?matches[0]:matches.length>1?null:implicit(host);return entry?descriptor(entry):null;},
  deliver(id,token){
   const entry=entries.get(id);
   if(!entry||!entry.container?.isConnected||entry.answered||!entry.callback||entry.managed)return false;
   entry.answered=true; // Set before the callback: even a throwing callback is never repeated.
   const field=entry.container.querySelector('input[name="cf-turnstile-response"]');
   if(field){if(field.value)return false;field.value=token;}
   Reflect.apply(entry.callback,undefined,[token]);return true;
  }
 },configurable:true});
 const wrapped=new WeakSet();
 const wrap=api=>{
  try{
  if(!api||typeof api.render!=='function'||wrapped.has(api))return api;
  wrapped.add(api);
  const render=api.render;
  api.render=function(container,options={}){
   const element=typeof container==='string'?document.querySelector(container):container;
   const entry={id:++sequence,container:element,sitekey:string(options.sitekey),action:string(options.action),cdata:string(options.cData),managed:!!options.chlPageData,callback:resolveCallback(options.callback),answered:false};
   const callback=options.callback;
   const actual={...options};
   if(typeof callback==='function')actual.callback=function(...args){entry.answered=true;return Reflect.apply(callback,this,args);};
   const widget=Reflect.apply(render,this,[container,actual]);entry.widget=widget;
   if(element instanceof Element){for(const [id,old] of entries)if(old.container===element)entries.delete(id);entries.set(entry.id,entry);}
   return widget;
  };
  for(const method of ['reset','remove'])if(typeof api[method]==='function'){
   const original=api[method];api[method]=function(widget,...args){
    for(const [id,entry] of entries)if(widget===undefined||entry.widget===widget){entries.delete(id);if(method==='reset'){entry.id=++sequence;entry.answered=false;entries.set(entry.id,entry);break;}}
    return Reflect.apply(original,this,[widget,...args]);
   };
  }
  }catch{} // A frozen/provider-owned API must continue working unchanged.
  return api;
 };
 const previous=Object.getOwnPropertyDescriptor(globalThis,'turnstile');
 if(previous&&!previous.configurable){wrap(globalThis.turnstile);return;}
 // Preserve an existing accessor; do not replace another integration's setter.
 if(previous?.get||previous?.set){wrap(globalThis.turnstile);return;}
 let api=wrap(globalThis.turnstile);
 Object.defineProperty(globalThis,'turnstile',{configurable:true,enumerable:previous?.enumerable??true,get:()=>api,set:value=>{api=wrap(value);}});
}

export async function installTurnstileRegistration(page){
 let pending=installed.get(page);if(pending)return pending;
 pending=(async()=>{
  await page.addInitScript(captureTurnstileRegistration,turnstileBridge);
  await page.evaluate(captureTurnstileRegistration,turnstileBridge);
 })().catch(error=>{installed.delete(page);throw error;});
 installed.set(page,pending);return pending;
}

export const readTurnstileRegistration=host=>host.evaluate((element,key)=>globalThis[key]?.read(element)??null,turnstileBridge);
