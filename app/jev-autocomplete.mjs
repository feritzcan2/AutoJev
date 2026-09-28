import {blockedRepeat,rememberProgress,progressKey,stalled} from './jev-navigation.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const normalize=value=>value.replace(/\s+/g,' ').trim();
const stale={status:'stale',executed:false,message:'Kontrol kimliği eski; dönen güncel controls listesini kullan. Ek observe gerekmez.'};

// Query + bounded wait + exact selection. No model, selectors from the caller,
// hidden-field writes, keyboard submission, or fuzzy candidate answers.
export async function selectAutocomplete(slot,args,owner,reader){
  const listOnly=args.option===undefined;
  const saved=slot.controls?.get(args.controlId);
  if(!saved)return stale;
  if(saved.owner!==owner)throw Error('Bu oturuma ait güncel controlId gerekli.');
  const observed=await slot.page.evaluate(reader);
  if(saved.kind!=='control'||!same(observed?.control_guards?.[saved.node],saved.guard))return stale;
  const key=JSON.stringify([listOnly?'autocomplete-options':'autocomplete',saved.node,args.text,args.option]),before=progressKey(observed);
  const selectionKey=listOnly?null:JSON.stringify(['autocomplete-select',saved.node,normalize(args.option)]);
  if(!listOnly&&(blockedRepeat(slot,key,before)||blockedRepeat(slot,selectionKey,before)))return stalled;
  slot.pending=null;
  const handle=await slot.page.evaluateHandle(node=>window.__jevFast.nodes.get(node),saved.node),input=handle.asElement();
  let wrote=false,clicked=false,opened=false;
  const read=()=>input.evaluate(e=>{
    const c=window.__jevFast,widget=c.autocomplete(e);
    if(!widget)return null;
    const guard=c.controlGuard(e);if(!guard)return null;
    // Query and selected-caption changes are expected during selection;
    // identity, label, ownership and form are not (guard slots 7 and 17).
    return {identity:guard.filter((_,i)=>i!==7&&i!==17),value:widget.value??e.value,valid:(e.validity?.valid??true)&&e.getAttribute('aria-invalid')!=='true',
      ...widget,options:widget.options.map(o=>({...o,point:c.clickPoint(c.nodes.get(o.node))})),point:c.clickPoint(e)};
  });
  const stop=async(status,message,extra={})=>{
    const state=await slot.page.evaluate(reader).catch(()=>null);
    if(state){const after=progressKey(state);rememberProgress(slot,key,after,after);if(clicked)rememberProgress(slot,selectionKey,after,after);}
    return {status,executed:wrote||clicked||opened,message,...extra};
  };
  try{
    const initial=await read();if(initial?.editable===false&&args.text!==undefined)return {status:'unsupported',executed:false,message:'Bu liste yazı alanı değil; text göndermeden seçenekleri listele veya option ile seç.'};if(!initial)return {status:'unsupported',executed:false,message:'Bu kontrol için ilişkilendirilmiş autocomplete bulunamadı; native select veya normal gözlenen hedefi kullan.'};
    await input.scrollIntoViewIfNeeded({timeout:2000});
    let current=await read();
    if(!current?.point||!same(current.identity,initial.identity))return stale;
    if(!current.expanded){opened=true;await slot.page.mouse.click(current.point.x,current.point.y);}
    if(args.text!==undefined){
      if(current.value!==args.text){wrote=true;await input.fill(args.text,{timeout:2000});}
      else await input.focus();
    }
    let match;
    const deadline=Date.now()+2500;
    do{
      current=await read();
      if(!current||!same(current.identity,initial.identity))return await stop('stale','Alan değişti; seçim yapılmadı.');
      if(listOnly){if(current.options.length)break;await new Promise(resolve=>setTimeout(resolve,100));continue;}
      const matches=current.options.filter(o=>normalize(o.label)===normalize(args.option));
      if(matches.length>1)return await stop('ambiguous','Birden fazla aynı adlı seçenek var; seçim yapılmadı.',{suggestions:current.options.map(o=>o.label).slice(0,20)});
      if(matches.length===1){match=matches[0];break;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()<deadline);
    if(listOnly)return {status:'ready',executed:wrote||opened,selected:false,query:current.value,expanded:current.expanded,optionCount:current.options.length,suggestions:current.options.map(o=>o.label),options:current.options.map(({label,selected})=>({label,selected})),message:current.options.length?'Gerçek seçenek etiketlerini kayıtlı yanıtla eşleştir; seçim yapılmadı.':'Bu sorgu için ilişkilendirilmiş seçenek görünmüyor. Tahmin yürütme; gerekiyorsa text="" ile geçici sorguyu temizleyip listeyi oku.'};
    if(!match)return await stop('needs_selection','Tam eşleşen seçenek bulunamadı; dönen seçeneklerden kanıtlanan yanıtı kullan. Aynı sorguyu tekrarlama.',{suggestions:current.options.map(o=>o.label).slice(0,20)});
    if(current.editable===false){
      const optionHandle=await slot.page.evaluateHandle(node=>window.__jevFast.nodes.get(node),match.node);
      try{await optionHandle.asElement().scrollIntoViewIfNeeded({timeout:2000});}finally{await optionHandle.dispose();}
      const fresh=await read();
      if(!fresh||!same(fresh.identity,initial.identity))return await stop('stale','Liste değişti; seçim yapılmadı.');
    }
    // Recheck the same option immediately before clicking. Never use an old point.
    const point=await input.evaluate((e,{node,label})=>{
      const c=window.__jevFast,widget=c.autocomplete(e),option=widget?.options.find(o=>o.node===node&&o.label===label);
      return option?c.clickPoint(c.nodes.get(node)):null;
    },match);
    if(!point)return await stop('stale','Seçeneğin üzeri kapalı veya hedef değişti; tıklanmadı.');
    clicked=true;await slot.page.mouse.click(point.x,point.y);
    await new Promise(resolve=>setTimeout(resolve,100));
    const verifyUntil=Date.now()+1000;
    let actual,verified=false;
    do{
      const state=await read();actual=state?.selectedLabels?.[0]||state?.value;
      verified=!!state&&same(state.identity,initial.identity)&&normalize(actual)===normalize(match.label)&&state.valid&&!state.expanded;
      if(verified)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()<verifyUntil);
    // Some widgets display a shortened value (e.g. +49 for Germany +49).
    // Reopen the same observed control and require the exact option's selected
    // state; never infer a match from a substring or the click itself.
    if(!verified){
      let state=await read();
      if(state?.selectedLabels.length&&state.valid&&!state.expanded&&same(state.identity,initial.identity)&&state.point){
        await slot.page.mouse.click(state.point.x,state.point.y);
        const until=Date.now()+1000;let selected=false;
        do{
          state=await read();
          const matches=state?.options.filter(o=>normalize(o.label)===normalize(match.label))??[];
          selected=!!state&&same(state.identity,initial.identity)&&matches.length===1&&matches[0].selected===true;
          if(selected)break;
          await new Promise(resolve=>setTimeout(resolve,100));
        }while(Date.now()<until);
        await input.press('Escape');
        state=await read();
        verified=selected&&!!state&&same(state.identity,initial.identity)&&state.valid&&!state.expanded;
        actual=state?.selectedLabels?.[0]||state?.value;
      }
    }
    slot.history.push({action:match.label,kind:'select',operation:'AUTOCOMPLETE'});slot.history=slot.history.slice(-60);
    const selection={label:match.label,actual,verified};
    if(!verified)return await stop('uncertain','Seçenek tıklandı fakat kabul edildiği doğrulanamadı. Dönen form kanıtını incele; işlemi körlemesine tekrarlama.',{selection});
    return {status:'ready',executed:true,selection,message:'Autocomplete seçimi doğrulandı. Dönen güncel gözlemi kullan; ek observe veya screenshot gerekmez.'};
  }catch(error){
    if(!wrote&&!clicked&&!opened)throw error;
    return await stop('uncertain','Autocomplete sonucu doğrulanamadı; dönen gözlemi incele. '+error.message.split('\n')[0]);
  }finally{await handle.dispose();}
}
