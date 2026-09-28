import {observedId} from './jev-ids.mjs';
import {randomUUID,createHash} from 'node:crypto';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function captureControls(slot,owner){
  const previous=slot.controls??new Map();slot.controls=new Map();
  const capture=(items,kind,guards)=>items.map(({node,...item})=>{
    const guard=guards[node];
    const saved=[...previous].find(([,entry])=>entry.owner===owner&&entry.node===node&&entry.kind===kind&&same(entry.guard,guard));
    const controlId=saved?.[0]??observedId(kind==='scroll'?'s':'c');slot.controls.set(controlId,{node,kind,guard,owner});
    const read=slot.optionLists?.get(node);
    const field=kind==='control'?[...(slot.fillFields??[])].find(([,f])=>f.owner===owner&&f.action.node===node):null;
    const recommendedTool=field?'browser_jev_fill_fields':item.nativeSelect?'browser_jev_select_option':item.choice?'browser_jev_select_choice':item.autocomplete?'browser_jev_autocomplete':null;
    return {controlId,...item,...(field?{fieldId:field[0]}:{}),...(recommendedTool?{recommendedTool}:{}),...(read?.owner===owner&&same(read.guard,guard)&&read.completeReturned?{optionsRead:{complete:true,count:read.options.length,listId:read.id,nextAction:'Use the previously returned full list; select its exact label/value without another list query.'}}:{})};
  });
  return {controls:capture(slot.observed.controls??[],'control',slot.observed.control_guards),
    scrollTargets:capture(slot.observed.scrollTargets??[],'scroll',slot.observed.scroll_guards)};
}
export function progressKey(observed){
  // Focus alone is not evidence that a click opened a form or submitted it.
  return createHash('sha256').update(JSON.stringify([observed.page_key,observed.text,observed.scrollTargets,
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
  if(name==='browser_jev_list_options'){
    slot.pending=null;
    slot.optionLists??=new Map();
    let list=slot.optionLists.get(saved.node),cached=list?.owner===owner&&same(list.guard,saved.guard);
    if(!cached){
      const result=await slot.page.evaluate(node=>{
        const e=window.__jevFast.nodes.get(node);
        if(e?.tagName!=='SELECT')return null;
        return [...e.options].map(o=>({index:o.index,label:o.label,value:o.value,selected:o.selected,disabled:o.disabled||!!o.closest('optgroup[disabled]'),group:o.closest('optgroup')?.label??null}));
      },saved.node);
      if(!result)return {status:'unsupported',executed:false,message:'Native SELECT gerekli; autocomplete için browser_jev_autocomplete kullan.'};
      list={id:observedId('o'),owner,guard:saved.guard,options:result,completeReturned:false};slot.optionLists.set(saved.node,list);
      if(slot.optionLists.size>80)slot.optionLists.delete(slot.optionLists.keys().next().value);
    }
    const repeatedFullList=list.completeReturned,query=args.query??'',offset=args.offset??0,limit=args.limit??null;
    const normalize=value=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/ı/g,'i').replace(/\s+/g,' ').trim();
    const terms=normalize(query).split(' ').filter(Boolean),matches=list.options.filter(o=>terms.every(term=>normalize([o.label,o.value,o.group??''].join(' ')).includes(term)));
    const options=matches.slice(offset,limit===null?undefined:offset+limit),nextOffset=offset+options.length<matches.length?offset+options.length:null;
    if(!query.trim()&&offset===0&&nextOffset===null)list.completeReturned=true;
    return {status:'ready',executed:false,controlId:args.controlId,listId:list.id,cached:Boolean(cached),alreadyRead:repeatedFullList,query,offset,optionCount:list.options.length,matchCount:matches.length,options,nextOffset,nextAction:'select_option',message:repeatedFullList?'Bu listenin tamamı zaten döndü. Tekrar sorgulama; bilinen yanıtla eşleşen tam etiket/değeri seç.':'Dönen seçenekleri sakla; bilinen yanıtı seçmek için ek liste sorgusu veya reveal gerekmez.'};
  }
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
        if(matches.length!==1||matches[0].disabled||matches[0].closest('optgroup[disabled]'))return {needsSelection:true,optionCount:e.options.length,reason:matches.length>1?'ambiguous':matches.length===0?'no_match':'disabled'};
        const o=matches[0];return {value:o.value,label:o.label,index:o.index,unchanged:o.selected};
      },{node:saved.node,option:args.option});
      if(match.error)throw Error(match.error);
      if(match.needsSelection){const list=slot.optionLists?.get(saved.node),known=list?.owner===owner&&same(list.guard,saved.guard)&&list.completeReturned;return {status:'needs_selection',executed:false,optionCount:match.optionCount,reason:match.reason,message:known?'Tam ve etkin seçenek eşleşmedi. Tam liste zaten döndü; o listedeki gerçek etiket/değeri kullan. Listeyi tekrar isteme veya başka yazım tahmin etme.':'Tam ve etkin seçenek eşleşmedi. browser_jev_list_options ile tüm seçenekleri oku; gerçek etiket/değeri kullan. Başka yazım tahmin etme; observe veya screenshot gerekmez.'};}
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
// A model often requests full=true after every action. An explicit lost-base
// reason distinguishes reconstruction from routine fresh reads; neither path
// skips the actual page observation or outcome verification.
export function observationPolicy(name,args,status){
 const recovery=name==='browser_jev_observe'&&args.full===true&&args.fullReason==='context_loss';
 return {standalone:true,full:name==='browser_jev_open'||recovery||name==='browser_jev_select_choice'&&['stale','blocked'].includes(status)||name==='browser_jev_fill_fields'&&['stale','invalid_target'].includes(status)};
}
export function presentObservation(slot,value,{full=false,standalone=false}={}){
  if(!value.elements)return value;
  const previous=slot.presented,ownerChanged=slot.presentedOwner!==slot.owner,observationId=randomUUID();
  slot.presentedOwner=slot.owner;
  slot.presented={...value,observationId,mapDeltas:true};
  if(full||!previous||ownerChanged||previous.url!==value.url)return {...slot.presented,observationMode:'full',...(standalone?{controlMaps:'replace'}:{})};
  if(standalone){
    // Actionable state is a complete current replacement, never a patch that
    // requires the model to reconstruct opaque IDs from earlier turns.
    const compact={...slot.presented,observationMode:'compact',controlMaps:'replace',mapDeltas:false};
    // elements duplicates clickTargets/controls; model next/act uses the
    // original internal snapshot, which is retained untouched.
    delete compact.elements;
    if(same(previous.text,value.text)){delete compact.text;compact.textUnchanged=true;}
    if(same(previous.links,value.links))delete compact.links;
    if(Array.isArray(value.history))compact.history=value.history.slice(-1);
    return compact;
  }
  const delta={...slot.presented,baseObservationId:previous.observationId,observationMode:'delta'};
  for(const key of ['text','links','title'])if(same(previous[key],value[key]))delete delta[key];
  delta.elements=value.elements.filter(e=>!previous.elements.some(old=>old.index===e.index&&same(old,e)));
  delta.removedElements=previous.elements.filter(old=>!value.elements.some(e=>e.index===old.index)).map(e=>e.index);
  // IDs survive only while their owner, DOM identity and meaning match.
  // The consumed click/fill ID is retired; unaffected IDs remain usable.
  for(const [key,id,removed] of [['controls','controlId','removedControls'],['clickTargets','targetId','removedClickTargets'],['fillFields','fieldId','removedFillFields'],['scrollTargets','controlId','removedScrollTargets']]){
    if(!Array.isArray(value[key]))continue;
    const before=new Map((previous[key]??[]).map(item=>[item[id],item]));
    const current=new Map(value[key].map(item=>[item[id],item]));
    delta[key]=[...current.values()].filter(item=>!same(before.get(item[id]),item));
    delta[removed]=[...before.keys()].filter(id=>!current.has(id));
  }
  // History is context, not an action map. Keep the latest change only; a
  // full observation still carries the recent history for recovery.
  if(same(previous.history,value.history))delete delta.history;
  else if(Array.isArray(value.history))delta.history=value.history.slice(-1);
  // Upload handles are still one-observation replacements.
  return delta;
}
