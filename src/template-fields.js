export function templateFields(root,fields,values={},prefix='criteria-'){
 root.replaceChildren();
 for(const field of fields){const label=document.createElement('label');label.textContent=field.label;
  const select=['choice','boolean'].includes(field.type),input=document.createElement(select?'select':field.type&&field.type!=='text'?'input':'textarea');
  input.name=prefix+field.id;input.required=field.required;input.maxLength=6000;
  if(select){input.add(new Option('Seç…',''));for(const [value,title]of field.type==='boolean'?[['true','Evet'],['false','Hayır']]:(field.options??[]).map(value=>[value,value]))input.add(new Option(title,value));}
  else if(input.tagName==='INPUT'){input.type=['number','money'].includes(field.type)?'number':field.type;input.step='any';}
  input.placeholder=field.question;input.value=values[field.id]??'';label.append(input);root.append(label);
 }
}
export const templateValues=(form,fields,prefix='criteria-')=>Object.fromEntries(fields.map(f=>[f.id,form.elements[prefix+f.id]?.value??'']));
