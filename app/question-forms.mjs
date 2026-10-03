import {reusableFactKeys,consentScopes} from './candidate-answers.mjs';
const string={type:'string',minLength:1,maxLength:2000};
export const questionFieldsSchema={type:'array',minItems:1,maxItems:10,items:{type:'object',additionalProperties:false,required:['id','label','type'],properties:{id:{...string,maxLength:64},label:string,type:{type:'string',enum:['text','boolean','select','multiselect','date','number']},required:{type:'boolean'},help:string,factKey:{type:'string',enum:reusableFactKeys},consentScope:{type:'string',enum:consentScopes},options:{type:'array',minItems:2,maxItems:20,items:{...string,maxLength:200}}}}};
// Asked by the app when a verify task ends without portal proof. The
// applicant knows the outcome; the chosen option resolves the record.
export const OUTCOME_FIELD={id:'outcome',type:'select',label:'Bu başvuru gönderildi mi?',required:true,help:'Gönderilmedi dersen kayıt yeniden gönderilebilir duruma döner; Gönderildi dersen tamamlandı sayılır.',options:['Gönderildi','Gönderilmedi, yeniden gönderilebilir','Bilmiyorum, belirsiz kalsın']};
export function normalizeFields(fields){
 if(fields===undefined||fields===null)return null;
 if(!Array.isArray(fields)||!fields.length||fields.length>10)throw Error('Form 1–10 alan içermeli');
 const ids=new Set();return fields.map(f=>{
  if(!f||typeof f!=='object'||!/^\w[\w-]{0,63}$/.test(f.id??'')||ids.has(f.id))throw Error('Alan kimliği benzersiz olmalı');ids.add(f.id);
  if(typeof f.label!=='string'||!f.label.trim()||f.label.length>2000||!['text','boolean','select','multiselect','date','number'].includes(f.type))throw Error('Geçersiz form alanı');
  if(f.required!==undefined&&typeof f.required!=='boolean')throw Error('Geçersiz zorunluluk');
  if(f.help!==undefined&&(typeof f.help!=='string'||f.help.length>2000))throw Error('Geçersiz alan açıklaması');
  const field={id:f.id,label:f.label.trim(),type:f.type,required:f.required!==false,...(f.help?{help:f.help}:{})};
  if(f.factKey!==undefined){if(!reusableFactKeys.includes(f.factKey)||f.consentScope)throw Error('Genel aday bilgisi ile başvuru onayı ayrı alanlar olmalı');field.factKey=f.factKey;}
  if(f.consentScope!==undefined){if(!consentScopes.includes(f.consentScope))throw Error('Geçersiz onay kapsamı');field.consentScope=f.consentScope;}
  if(['select','multiselect'].includes(f.type)){if(!Array.isArray(f.options)||f.options.length<2||f.options.length>20||f.options.some(v=>typeof v!=='string'||!v.trim()||v.length>200)||new Set(f.options).size!==f.options.length)throw Error('Benzersiz cevap seçenekleri gerekli');field.options=f.options;}
  return field;
 });
}
export function validateAnswers(fields,values){
 if(!values||typeof values!=='object'||Array.isArray(values))throw Error('Form cevapları gerekli');
 if(Object.keys(values).some(id=>!fields.some(f=>f.id===id)))throw Error('Bilinmeyen cevap alanı');
 const result={};
 for(const f of fields){const v=values[f.id],empty=v===undefined||v===null||v===''||Array.isArray(v)&&!v.length;
  if(empty){if(f.required)throw Error(`${f.label}: cevap gerekli`);continue;}
  let valid=false;
  if(f.type==='text')valid=typeof v==='string'&&v.trim().length>0&&v.length<=5000;
  if(f.type==='boolean')valid=typeof v==='boolean';
  if(f.type==='number')valid=typeof v==='number'&&Number.isFinite(v);
  if(f.type==='select')valid=f.options.includes(v);
  if(f.type==='multiselect')valid=Array.isArray(v)&&v.length<=f.options.length&&new Set(v).size===v.length&&v.every(item=>f.options.includes(item));
  if(f.type==='date')valid=typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
  if(!valid)throw Error(`${f.label}: geçerli cevap gerekli`);result[f.id]=v;
 }
 const summary=fields.filter(f=>Object.hasOwn(result,f.id)).map(f=>`${f.label}: ${typeof result[f.id]==='boolean'?(result[f.id]?'Evet':'Hayır'):Array.isArray(result[f.id])?result[f.id].join(', '):result[f.id]}`).join('\n');
 if(!summary||summary.length>10000)throw Error('Cevap boş veya çok uzun');return{values:result,summary};
}
