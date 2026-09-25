import './question-form.css';
const node=(tag,value)=>{const e=document.createElement(tag);if(value!==undefined)e.textContent=value;return e;};
export function questionForm(candidate,q,submit){
 const form=node('form');form.className='candidate-question-form';const key=`jobloop-question:${candidate}:${q.id}`;let draft={};try{draft=JSON.parse(localStorage.getItem(key)??'{}');}catch{}
 const fields=q.fields??[{id:'answer',label:q.question,type:'text',required:true}],readers=new Map();
 const save=()=>{const values=Object.fromEntries([...readers].map(([id,read])=>[id,read()]));try{localStorage.setItem(key,JSON.stringify(values));}catch{}};
 for(const f of fields){const box=node('fieldset'),legend=node('legend',f.label+(f.required?' *':''));box.append(legend);if(f.help)box.append(node('p',f.help));
  if(f.type==='multiselect'){
   const checks=f.options.map(option=>{const label=node('label'),input=node('input');input.type='checkbox';input.value=option;input.checked=Array.isArray(draft[f.id])&&draft[f.id].includes(option);input.onchange=save;label.append(input,node('span',option));box.append(label);return input;});
   readers.set(f.id,()=>checks.filter(i=>i.checked).map(i=>i.value));
  }else if(f.type==='boolean'||f.type==='select'){
   const select=node('select');select.setAttribute('aria-label',f.label);select.required=f.required;select.append(new Option('Seçiniz…',''));
   for(const option of f.type==='boolean'?['Evet','Hayır']:f.options)select.append(new Option(option,f.type==='boolean'?String(option==='Evet'):option));
   if(draft[f.id]!==undefined&&draft[f.id]!==null)select.value=String(draft[f.id]);select.onchange=save;box.append(select);readers.set(f.id,()=>select.value===''?null:f.type==='boolean'?select.value==='true':select.value);
  }else{
   const input=node(f.type==='text'?'textarea':'input');if(f.type!=='text')input.type=f.type;if(f.type==='number')input.step='any';input.required=f.required;input.setAttribute('aria-label',f.label);input.value=draft[f.id]??'';input.oninput=save;box.append(input);readers.set(f.id,()=>input.value===''?null:f.type==='number'?Number(input.value):input.value);
  }
  form.append(box);
 }
 const error=node('p');error.className='question-form-error';error.setAttribute('role','alert');const button=node('button',q.fields?'Yanıtları gönder':'Yanıtla');button.className='primary';button.type='submit';form.append(error,button);
 form.onsubmit=async event=>{event.preventDefault();if(button.disabled||!form.reportValidity())return;const values=Object.fromEntries([...readers].map(([id,read])=>[id,read()]));for(const f of fields)if(f.required&&Array.isArray(values[f.id])&&!values[f.id].length){error.textContent=`${f.label}: en az bir seçenek seç`;return;}button.disabled=true;error.textContent='';try{await submit(q.fields?values:values.answer);localStorage.removeItem(key);}catch(e){error.textContent=e.message;}finally{button.disabled=false;}};
 return form;
}
