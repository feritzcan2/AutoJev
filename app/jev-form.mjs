import {randomUUID} from 'node:crypto';

// Only ordinary, observed text fields. Dropdowns, consent, credentials, files and
// submission remain separate reviewed operations. Keep actual element handles.
function inspectField(e){
  const type=e.tagName==='TEXTAREA'?'textarea':e.type;
  if(!(e.tagName==='TEXTAREA'||e.tagName==='INPUT'&&['text','email','tel','url'].includes(type))||
    e.getAttribute('role')==='combobox'||e.hasAttribute('list')||e.hasAttribute('aria-autocomplete')||
    !e.isConnected||e.readOnly||e.matches(':disabled')||e.closest('[aria-disabled="true"],[aria-readonly="true"],[inert],[aria-hidden="true"]')||
    !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return null;
  const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
  if(!r.width||!r.height||x<0||y<0||x>=innerWidth||y>=innerHeight||!e.contains(document.elementFromPoint(x,y)))return null;
  return {type,value:e.value,required:e.required,maxLength:e.maxLength,valid:e.validity.valid,
    signature:[e.tagName,type,e.id,e.name,e.getAttribute('role'),e.getAttribute('placeholder'),e.autocomplete,e.pattern,e.maxLength,e.required,e.form?.action??null,e.form?.method??null]};
}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function clearFillFields(slot){
  const fields=slot.fillFields;slot.fillFields=new Map();
  if(fields)await Promise.all([...fields.values()].map(f=>f.input.dispose().catch(()=>{})));
}
export async function captureFillFields(slot,owner){
  const fields=[];
  for(const action of slot.observed.actions.filter(a=>a.kind==='fill').slice(0,40)){
    const handle=await slot.page.evaluateHandle(node=>window.__jevFast?.nodes.get(node),action.node),input=handle.asElement();
    const details=input?await input.evaluate(inspectField):null;
    if(!details){await handle.dispose();continue;}
    const fieldId=randomUUID();
    slot.fillFields.set(fieldId,{input,action,details,owner});
    fields.push({fieldId,label:action.label,type:details.type,value:details.value,required:details.required,maxLength:details.maxLength});
  }
  return fields;
}
export async function fillKnownFields(slot,fields,owner,reader){
  // Validate the complete mapping before touching any field, then consume it.
  const entries=fields.map(field=>{
    const saved=slot.fillFields?.get(field.fieldId);
    if(!saved||saved.owner!==owner)throw Error('Bu oturuma ait güncel alan kimliği gerekli; son gözlemdeki fillFields listesini kullan.');
    if(saved.details.maxLength>=0&&field.text.length>saved.details.maxLength)throw Error('Metin alanın izin verdiği uzunluğu aşıyor; hiçbir alan doldurulmadı.');
    return {...saved,...field};
  });
  const handles=slot.fillFields;slot.fillFields=new Map();slot.pending=null;
  const expected=structuredClone(slot.observed.page_key),guards=slot.observed.guards;
  const results=entries.map(e=>({fieldId:e.fieldId,label:e.action.label,status:'not_attempted'}));
  let status='ready';
  try{
    for(let i=0;i<entries.length;i++){
      const entry=entries[i],result=results[i];let began=false;
      try{
        const current=await slot.page.evaluate(reader),details=await entry.input.evaluate(inspectField);
        if(!current||!details||!equal(current.page_key,expected)||!equal(current.guards[entry.action.node],guards[entry.action.node])||!equal(details.signature,entry.details.signature)){
          result.status=status='stale';break;
        }
        if(details.value===entry.text){result.status=details.valid?'unchanged':'invalid';if(!details.valid){status='invalid';break;}continue;}
        began=true;
        await entry.input.fill(entry.text,{timeout:2000});
        await entry.input.evaluate(e=>e.blur());
        await new Promise(resolve=>setTimeout(resolve,50));
        const after=await entry.input.evaluate(e=>({value:e.value,valid:e.validity.valid}));
        if(after.value!==entry.text){result.status=status='uncertain';break;}
        if(!after.valid){result.status=status='invalid';break;}
        result.status='filled';
        const state=expected[6].find(field=>field[0]===entry.action.node);state[1]=entry.text;
        slot.history.push({action:entry.action.label,kind:'fill',operation:'TYPE_TEXT',text:entry.text});
      }catch{result.status=status=began?'uncertain':'stale';break;}
    }
    // A later change/blur can clear an earlier input. Verify the complete result,
    // including the last field, before returning success. Never retry mutations.
    const final=await slot.page.evaluate(reader).catch(()=>null);
    if(status==='ready'&&(!final||!equal(final.page_key,expected)))status='stale';
    for(let i=0;i<entries.length;i++)if(['filled','unchanged'].includes(results[i].status)){
      const verified=await entries[i].input.evaluate(e=>e.isConnected?{value:e.value,valid:e.validity.valid}:null).catch(()=>null);
      if(verified?.value!==entries[i].text){results[i].status='uncertain';status='uncertain';}
      else if(!verified.valid){results[i].status='invalid';if(status!=='uncertain')status='invalid';}
    }
    slot.history=slot.history.slice(-60);
    return {status,results,message:status==='ready'?'Alan değerleri doğrulandı. Gönderim yapılmadı.':'Kalan alanlar doldurulmadı. Son gözlemi ve alan sonuçlarını kontrol et; doğrulanamayan yazmayı körlemesine tekrarlama.'};
  }finally{await Promise.all([...handles.values()].map(f=>f.input.dispose().catch(()=>{})));}
}
