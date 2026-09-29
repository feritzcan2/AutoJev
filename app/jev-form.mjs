import {observedId,actionIdentity} from './jev-ids.mjs';
import {installFormSemantics} from './form-semantics.mjs';

// Read-only preflight, including rendered fields below the fold. Never invokes
// checkValidity/reportValidity (which dispatch events), changes focus or submits.
export async function inspectApplicationForm(page,slot=null){
 const fields=[],unavailableFrames=[],submitControls=[];let truncated=false;
 for(const frame of page.frames()){
  try{
   if(frame.parentFrame()){
    const element=await frame.frameElement();
    try{if(!await element.evaluate(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!e.closest('[inert],[aria-hidden="true"]')))continue;}finally{await element.dispose();}
   }
   await frame.evaluate(installFormSemantics);
   const result=await frame.evaluate(()=>{
    const visible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!e.closest('[inert],[aria-hidden="true"]');
    const clean=s=>(s??'').replace(/\s+/g,' ').trim().slice(0,1000);
    const refs=(e,name)=>(e.getAttribute(name)??'').split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ');
    const queryAll=(root,selector)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>queryAll(e.shadowRoot,selector))];
    const modalSurface=e=>visible(e)&&[e,...queryAll(e,'*')].some(n=>{
     if(!visible(n))return false;
     const r=n.getBoundingClientRect();return r.width>1&&r.height>1;
    });
    const modal=queryAll(document,'dialog[open],[role="dialog"],[aria-modal="true"]').filter(modalSurface).at(-1),root=modal??document;
    const nodes=queryAll(root,'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),textarea,select,[role="combobox"],[role="checkbox"],[role="radio"]').filter(e=>visible(e)&&!e.matches(':disabled')&&e.getAttribute('aria-disabled')!=='true');
    return {documentOrigin:performance.timeOrigin,truncated:nodes.length>100,
     submitControls:queryAll(root,'button,input[type="submit"],[role="button"]').filter(visible).filter(e=>/submit|send application|bewerb|apply|başvur|gönder/i.test(clean(e.getAttribute('aria-label')||e.innerText||e.value||''))).slice(0,10).map(e=>({label:clean(e.getAttribute('aria-label')||e.innerText||e.value),disabled:e.disabled||e.getAttribute('aria-disabled')==='true'})),
     fields:nodes.slice(0,100).map(e=>{
     const semantic=window.__jobloopFieldContext(e),label=semantic.label;
     const type=e.getAttribute('role')||e.type||e.tagName.toLowerCase();
     const required=semantic.required;
     const message=clean(e.validationMessage||refs(e,'aria-errormessage'));
     const invalid=e.getAttribute('aria-invalid')==='true'||e.validity?.valid===false;
     const field={node:window.__jevFast?.ids.get(e),...semantic,label,type,required,invalid,...(message?{validationMessage:message}:{})};
     if(type==='file'){field.files=[...(e.files??[])].map(f=>({name:f.name,size:f.size}));field.accept=e.accept||null;field.multiple=Boolean(e.multiple);}
     if(type!=='password'&&Number.isInteger(e.maxLength)&&e.maxLength>=0)field.maxLength=e.maxLength;
     const language=e.closest('[lang]')?.getAttribute('lang')||document.documentElement.lang;if(language)field.language=language;
     if(type!=='password')field.filled=['checkbox','radio'].includes(type)?Boolean(e.checked||e.getAttribute('aria-checked')==='true'):type==='file'?Boolean(e.files?.length):typeof e.value==='string'?Boolean(e.value.trim()):null;
     return field;
    })};
   });
   const current=slot&&frame===page.mainFrame()&&slot.observed?.page_key[0]===result.documentOrigin;
   truncated||=result.truncated;submitControls.push(...result.submitControls.map(control=>({...control,frameUrl:frame.url()})));fields.push(...result.fields.map(({node,...f})=>{
    const controlId=current?[...(slot.controls??[])].find(([,saved])=>saved.kind==='control'&&saved.node===node&&saved.owner===slot.owner)?.[0]:undefined;
    const fieldId=current?[...(slot.fillFields??[])].find(([,saved])=>saved.action.node===node&&saved.owner===slot.owner)?.[0]:undefined;
    return {...f,...(controlId?{controlId}:{}),...(fieldId?{fieldId}:{}),frameUrl:frame.url()};
   }));
  }catch{unavailableFrames.push(frame.url());}
 }
 return {fields,missingRequired:fields.filter(f=>f.required===true&&f.filled===false).map(({label,question,type,frameUrl})=>({label,question,type,frameUrl})),submitControls,unavailableFrames,truncated,readOnly:true,notice:'Rendered fields on the current step only; required=null means unknown, not optional. Later steps may add fields. This inspection is not submission-outcome evidence.'};
}

// Only ordinary, observed text fields. Dropdowns, consent, credentials, files and
// submission remain separate reviewed operations. Keep actual element handles.
function inspectField(e){
  const type=e.tagName==='TEXTAREA'?'textarea':e.type;
  if(!(e.tagName==='TEXTAREA'||e.tagName==='INPUT'&&['text','search','number','email','tel','url','date'].includes(type))||
    window.__jevFast?.autocomplete(e)||e.getAttribute('role')==='combobox'||e.hasAttribute('list')||e.hasAttribute('aria-autocomplete')||
    !e.isConnected||e.readOnly||e.matches(':disabled')||e.closest('[aria-disabled="true"],[aria-readonly="true"],[inert],[aria-hidden="true"]')||
    !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return null;
  const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
  let hit=document.elementFromPoint(x,y);
  while(hit?.shadowRoot){const next=hit.shadowRoot.elementFromPoint(x,y);if(!next||next===hit)break;hit=next;}
  for(let host=e.getRootNode()?.host;host;host=host.getRootNode()?.host)if(host.closest('[aria-disabled="true"],[aria-readonly="true"],[inert],[aria-hidden="true"]'))return null;
  if(!r.width||!r.height||x<0||y<0||x>=innerWidth||y>=innerHeight||!e.contains(hit))return null;
  return {type,value:e.value,required:e.required,maxLength:e.maxLength,min:e.min,max:e.max,step:e.step,valid:e.validity.valid,
    signature:[e.tagName,type,e.id,e.name,e.getAttribute('role'),e.getAttribute('placeholder'),e.autocomplete,e.pattern,e.maxLength,e.required,e.form?.action??null,e.form?.method??null,e.min,e.max,e.step]};
}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Scroll/viewport changes during focus or textarea resize are not field edits.
// Keep document identity, URL and every input's identity/value/state guarded.
const sameFormState=(a,b)=>!!a&&!!b&&equal([a[0],a[1],a[6]],[b[0],b[1],b[6]]);
const sameText=(actual,expected,type)=>actual===expected||type==='tel'&&/^\+?[\d\s().-]+$/.test(actual)&&/^\+?[\d\s().-]+$/.test(expected)&&actual.replace(/[\s().-]/g,'')===expected.replace(/[\s().-]/g,'');
export async function clearFillFields(slot){
  const fields=slot.fillFields;slot.fillFields=new Map();
  if(fields)await Promise.all([...fields.values()].map(f=>f.input.dispose().catch(()=>{})));
}
export async function captureFillFields(slot,owner,previous=new Map()){
  const fields=[];
  for(const action of slot.observed.actions.filter(a=>a.kind==='fill').slice(0,40)){
    const handle=await slot.page.evaluateHandle(node=>window.__jevFast?.nodes.get(node),action.node),input=handle.asElement();
    const details=input?await input.evaluate(inspectField):null;
    if(!details){await handle.dispose();continue;}
    const identity=JSON.stringify([actionIdentity(slot.observed,action),details]);
    const saved=[...previous].find(([,entry])=>entry.owner===owner&&entry.identity===identity);
    const fieldId=saved?.[0]??observedId('f');
    slot.fillFields.set(fieldId,{input,action,details,owner,identity});
    fields.push({fieldId,label:action.label,type:details.type,value:details.value,required:details.required,maxLength:details.maxLength,...(details.type==='date'?{format:'YYYY-MM-DD',min:details.min,max:details.max,step:details.step}:{})});
  }
  return fields;
}
// Ignore framework node replacement, but preserve semantic identity, order and
// every non-secret field value. Unexpected fields/user edits still stop a batch.
function semanticFormState(){
 const query=root=>[...root.querySelectorAll('input,textarea,select'),...[...root.querySelectorAll('*')].filter(n=>n.shadowRoot).flatMap(n=>query(n.shadowRoot))];
 return [performance.timeOrigin,location.href,query(document).filter(e=>!['password','hidden'].includes(e.type)).map(e=>[
  e.tagName,e.type,e.id,e.name,e.getAttribute('aria-label'),[...(e.labels||[])].map(l=>l.textContent.trim()).join(' '),e.form?.id,e.form?.action,e.disabled,e.readOnly,e.required,e.value,e.checked,e.selectedIndex
 ])];
}
async function recoverField(slot,entry){
 // Only stable IDs/names captured from an observed field may recover a clone.
 const [, ,id,name]=entry.details.signature;if(!id&&!name)return false;
 const handle=await slot.page.evaluateHandle(({id,name})=>{
  const query=root=>[...root.querySelectorAll('input,textarea'),...[...root.querySelectorAll('*')].filter(n=>n.shadowRoot).flatMap(n=>query(n.shadowRoot))];
  const matches=query(document).filter(e=>id?e.id===id:e.name===name);
  return matches.length===1?matches[0]:null;
 },{id,name});
 const input=handle.asElement(),details=input?await input.evaluate(inspectField):null;
 const label=input?await input.evaluate(e=>window.__jobloopFieldContext?.(e)?.label):null;
 if(!details||!equal(details.signature,entry.details.signature)||label!==entry.action.label){await handle.dispose();return false;}
 await entry.input.dispose().catch(()=>{});entry.input=input;return true;
}
export async function fillKnownFields(slot,fields,owner,reader){
  if(fields.some(field=>slot.controls?.has(field.fieldId)))return {status:'invalid_target',results:fields.map(({fieldId})=>({fieldId,status:'not_attempted'})),message:'controlId yazılabilir fieldId değildir. Yalnızca fillFields içindeki fieldId değerlerini kullan; liste boşsa alan yazma desteği yok. Aynı kontrolü tekrar gönderme.'};
  // Removed, consumed or foreign-session IDs cannot write.
  if(fields.some(field=>!slot.fillFields?.has(field.fieldId)))return {status:'stale',results:fields.map(({fieldId})=>({fieldId,status:'not_attempted'})),message:'Alan kimlikleri eski; dönen güncel fillFields listesini kullan. Ek observe gerekmez.'};
  // Validate the complete mapping before touching any field, then consume it.
  const entries=fields.map(field=>{
    const saved=slot.fillFields?.get(field.fieldId);
    if(!saved||saved.owner!==owner)throw Error('Bu oturuma ait güncel alan kimliği gerekli; son gözlemdeki fillFields listesini kullan.');
    if(saved.details.type==='date'){
      const valid=/^\d{4}-\d{2}-\d{2}$/.test(field.text)&&Number.isFinite(Date.parse(field.text))&&new Date(field.text).toISOString().slice(0,10)===field.text;
      if(!valid)throw Error('Tarih YYYY-MM-DD biçiminde geçerli bir takvim tarihi olmalı; hiçbir alan doldurulmadı.');
      if(saved.details.min&&field.text<saved.details.min||saved.details.max&&field.text>saved.details.max)throw Error('Tarih alanın min/max sınırları dışında; hiçbir alan doldurulmadı.');
    }
    if(saved.details.maxLength>=0&&field.text.length>saved.details.maxLength)throw Error('Metin alanın izin verdiği uzunluğu aşıyor; hiçbir alan doldurulmadı.');
    return {...saved,...field};
  });
  const handles=new Map(fields.map(({fieldId})=>[fieldId,slot.fillFields.get(fieldId)]));
  for(const {fieldId} of fields)slot.fillFields.delete(fieldId);
  slot.pending=null;
  const expected=structuredClone(slot.observed.page_key),guards=slot.observed.guards;
  const results=entries.map(e=>({fieldId:e.fieldId,label:e.action.label,status:'not_attempted'}));
  let status='ready';
  let semanticExpected=await slot.page.evaluate(semanticFormState);
  try{
    for(let i=0;i<entries.length;i++){
      const entry=entries[i],result=results[i];let began=false;
      try{
        const current=await slot.page.evaluate(reader);
        if(i>0&&!await entry.input.evaluate(e=>e.isConnected).catch(()=>false))await recoverField(slot,entry);
        const details=await entry.input.evaluate(inspectField);
        const semanticCurrent=await slot.page.evaluate(semanticFormState);
        if(!current||!details||!(i===0?sameFormState(current.page_key,expected):equal(semanticCurrent,semanticExpected))||!(i===0?equal(current.guards[entry.action.node],guards[entry.action.node]):true)||!equal(details.signature,entry.details.signature)){
          result.status=status='stale';break;
        }
        if(sameText(details.value,entry.text,details.type)){result.status=details.valid?'unchanged':'invalid';if(!details.valid){status='invalid';break;}continue;}
        began=true;
        await entry.input.fill(entry.text,{timeout:2000});
        await entry.input.evaluate(e=>e.blur());
        await new Promise(resolve=>setTimeout(resolve,50));
        if(!await entry.input.evaluate(e=>e.isConnected).catch(()=>false))await recoverField(slot,entry);
        const after=await entry.input.evaluate(e=>e.isConnected?{value:e.value,valid:e.validity.valid}:null);
        if(!after){result.status=status='uncertain';break;}
        if(!sameText(after.value,entry.text,details.type)){result.status=status='uncertain';break;}
        if(!after.valid){result.status=status='invalid';break;}
        result.status='filled';
        const state=expected[6].find(field=>field[0]===entry.action.node);if(state)state[1]=after.value;
        const nextSemantic=await slot.page.evaluate(semanticFormState);
        const desired=structuredClone(semanticExpected);
        const matches=desired[2].filter(f=>entry.details.signature[2]?f[2]===entry.details.signature[2]:entry.details.signature[3]?f[3]===entry.details.signature[3]:false);
        if(matches.length===1){matches[0][11]=after.value;if(!equal(desired,nextSemantic)&&i<entries.length-1){status='stale';break;}}
        else if(!sameFormState((await slot.page.evaluate(reader)).page_key,expected)&&i<entries.length-1){status='stale';break;}
        semanticExpected=nextSemantic;
        slot.history.push({action:entry.action.label,kind:'fill',operation:'TYPE_TEXT',text:entry.text});
      }catch{result.status=status=began?'uncertain':'stale';break;}
    }
    // A later change/blur can clear an earlier input. Verify the complete result,
    // including the last field, before returning success. Never retry mutations.
    const final=await slot.page.evaluate(reader).catch(()=>null);
    const formChanged=!sameFormState(final?.page_key,expected);
    if(status==='ready'&&(!final||!equal(final.page_key.slice(0,2),expected.slice(0,2))))status='stale';
    for(let i=0;i<entries.length;i++)if(['filled','unchanged'].includes(results[i].status)){
      if(!await entries[i].input.evaluate(e=>e.isConnected).catch(()=>false))await recoverField(slot,entries[i]);
      const verified=await entries[i].input.evaluate(e=>e.isConnected?{value:e.value,valid:e.validity.valid}:null).catch(()=>null);
      if(!verified||!sameText(verified.value,entries[i].text,entries[i].details.type)){results[i].status='uncertain';status='uncertain';}
      else if(!verified.valid){results[i].status='invalid';if(status!=='uncertain')status='invalid';}
    }
    slot.history=slot.history.slice(-60);
    const verifiedCount=results.filter(r=>['filled','unchanged'].includes(r.status)).length;
    return {status,results,verifiedCount,formChanged,message:status==='ready'?'İstenen alan değerleri doğrulandı. Dönen güncel gözlemi kullan; bu alanları tekrar doldurma. Gönderim yapılmadı.':`${verifiedCount}/${results.length} alan doğrulandı. Yalnızca doğrulanmayan veya not_attempted alanları incele; filled/unchanged alanları tekrar doldurma. Güncel alan haritası bu sonuçta var.`};
  }finally{await Promise.all([...handles.values(),...entries].map(f=>f.input.dispose().catch(()=>{})));}
}
