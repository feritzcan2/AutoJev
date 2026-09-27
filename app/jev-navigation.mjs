import {randomUUID,createHash} from 'node:crypto';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function captureControls(slot,owner){
  const previous=slot.controls??new Map();slot.controls=new Map();
  const capture=(items,kind,guards)=>items.map(({node,...item})=>{
    const guard=guards[node];
    const saved=[...previous].find(([,entry])=>entry.owner===owner&&entry.node===node&&entry.kind===kind&&same(entry.guard,guard));
    const controlId=saved?.[0]??randomUUID();slot.controls.set(controlId,{node,kind,guard,owner});
    return {controlId,...item};
  });
  return {controls:capture(slot.observed.controls??[],'control',slot.observed.control_guards),
    scrollTargets:capture(slot.observed.scrollTargets??[],'scroll',slot.observed.scroll_guards)};
}
export function progressKey(observed){
  return createHash('sha256').update(JSON.stringify([observed.page_key,observed.text,observed.focus,observed.scrollTargets,
    observed.actions.map(({rect,id,...a})=>a)])).digest('hex');
}
export function blockedRepeat(slot,key,state){return slot.noProgress?.get(key)===state;}
export function rememberProgress(slot,key,before,after){
  slot.noProgress??=new Map();
  if(before===after){slot.noProgress.set(key,after);if(slot.noProgress.size>40)slot.noProgress.delete(slot.noProgress.keys().next().value);}
  else slot.noProgress.delete(key);
  return before!==after;
}
export const stalled={status:'no_progress',executed:false,message:'Aynı işlem bu sayfa durumunda ilerleme sağlamadı. Tekrarlama; controls içindeki hedefi reveal ile görünür yap veya farklı gözlenen hedef kullan.'};

export async function navigateObserved(slot,name,args,owner,reader){
  const saved=slot.controls?.get(args.controlId);
  if(!saved)return {status:'stale',executed:false,message:'Kontrol kimliği eski; dönen güncel controls/scrollTargets listesini kullan. Ek observe gerekmez.'};
  if(saved.owner!==owner)throw Error('Bu oturuma ait güncel controlId gerekli; son controls/scrollTargets listesini kullan.');
  if((name==='browser_jev_scroll')!==(saved.kind==='scroll'))throw Error('Yanlış kontrol türü.');
  const current=await slot.page.evaluate(reader),guards=saved.kind==='scroll'?current?.scroll_guards:current?.control_guards;
  if(!same(guards?.[saved.node],saved.guard))return {status:'stale',executed:false,message:'Hedef değişti; dönen güncel kontrolü kullan.'};
  const key=JSON.stringify([name,saved.node,args.direction,args.option]),before=progressKey(current);
  if(blockedRepeat(slot,key,before))return stalled;
  slot.pending=null;let began=false;
  try{
    if(name==='browser_jev_select_option'){
      // Resolve only a unique, exact observed native option. No fuzzy answers,
      // arbitrary selector, checkbox, custom dropdown, or submit operation.
      const match=await slot.page.evaluate(({node,option})=>{
        const e=window.__jevFast.nodes.get(node);
        if(e?.tagName!=='SELECT'||e.multiple||e.matches(':disabled')||e.closest('[aria-disabled="true"],[inert]'))return {error:'Etkin tek seçimli native SELECT gerekli.'};
        const matches=[...e.options].filter(o=>(o.value===option||o.label.trim()===option.trim()));
        if(matches.length!==1||matches[0].disabled||matches[0].closest('optgroup[disabled]'))return {error:'Tek ve etkin bir seçenek tam olarak eşleşmeli; başka yanıt tahmin edilmedi.'};
        const o=matches[0];return {value:o.value,label:o.label,index:o.index,unchanged:o.selected};
      },{node:saved.node,option:args.option});
      if(match.error)throw Error(match.error);
      if(match.unchanged)return {status:'ready',executed:false,selection:{...match,verified:true}};
      const handle=await slot.page.evaluateHandle(node=>window.__jevFast.nodes.get(node),saved.node);
      try{
        await handle.asElement().scrollIntoViewIfNeeded({timeout:2000});
        const actionable=await slot.page.evaluate(({node,guard})=>{
          const c=window.__jevFast,e=c.nodes.get(node);return JSON.stringify(c.controlGuard(e))===JSON.stringify(guard)&&!!c.clickPoint(e);
        },{node:saved.node,guard:saved.guard});
        if(!actionable)return {status:'stale',executed:false,message:'Seçim alanının üzeri kapalı veya alan değişti.'};
        began=true;await handle.asElement().selectOption({index:match.index},{timeout:2000});
        await new Promise(resolve=>setTimeout(resolve,100));
        const actual=await handle.evaluate(e=>e.isConnected?{value:e.value,index:e.selectedIndex}:null),verified=actual?.value===match.value&&actual?.index===match.index;
        if(!verified){const state=progressKey(await slot.page.evaluate(reader));rememberProgress(slot,key,state,state);}
        return {status:verified?'ready':'uncertain',executed:true,selection:{value:match.value,label:match.label,actual:actual?.value??null,verified}};
      }finally{await handle.dispose();}
    }
    if(name==='browser_jev_reveal'){
      const handle=await slot.page.evaluateHandle(node=>window.__jevFast.nodes.get(node),saved.node);
      try{
        began=true;await handle.asElement().scrollIntoViewIfNeeded({timeout:2000});
      }finally{await handle.dispose();}
    }else{
      began=true;await slot.page.evaluate(({node,direction})=>{
        const e=window.__jevFast.nodes.get(node);e.scrollBy({top:(direction==='down'?1:-1)*Math.min(560,e.clientHeight*.8),behavior:'instant'});
      },{node:saved.node,direction:args.direction});
    }
    const after=await slot.page.evaluate(reader),progress=rememberProgress(slot,key,before,progressKey(after));
    if(name==='browser_jev_reveal'){
      const visible=after.controls.find(c=>c.node===saved.node)?.visible===true;
      return {status:visible?'ready':'no_progress',executed:true,progress,visible,...(!visible?{message:stalled.message}:{})};
    }
    return {status:progress?'ready':'no_progress',executed:true,progress,...(!progress?{message:stalled.message}:{})};
  }catch(error){
    if(!began)throw error;
    return {status:'uncertain',executed:'unknown',message:'İşlem sonucu doğrulanamadı; güncel gözlemi kontrol et. '+error.message.split('\n')[0]};
  }
}

// Keep complete short field IDs every time; never truncate an ID or a consent
// label. Large dropdown options stay in the page, accessible by exact answer.
export function compactElements(elements){return elements.map(({options,...e})=>({...e,...(options?{optionCount:options.length,options:options.slice(0,5).map(o=>({...o,label:o.label.split(' → ').slice(1).join(' → ')})),optionsOmitted:Math.max(0,options.length-5)}:{})}));}
export function presentObservation(slot,value,{full=false}={}){
  if(!value.elements)return value;
  const previous=slot.presented,observationId=randomUUID();
  slot.presented={...value,observationId};
  if(full||!previous||previous.url!==value.url)return {...value,observationId,observationMode:'full'};
  const delta={...value,observationId,baseObservationId:previous.observationId,observationMode:'delta'};
  for(const key of ['text','links','title'])if(same(previous[key],value[key]))delete delta[key];
  delta.elements=value.elements.filter(e=>!previous.elements.some(old=>old.index===e.index&&same(old,e)));
  delta.removedElements=previous.elements.filter(old=>!value.elements.some(e=>e.index===old.index)).map(e=>e.index);
  // Field maps remain complete even when the descriptive page content is unchanged.
  return delta;
}
