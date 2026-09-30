import {jobSearchTemplate} from './templates/job-search.mjs';
import {withAgentDefaults} from './agent-settings.mjs';
import {templateContract} from './template-contract.mjs';
const field=(id,label,question,required=true)=>({id,label,question,required});
export const automationTemplates=[
 jobSearchTemplate,
 {id:'housing',recordOperations:{prepare:{label:'Mesajı hazırla'},execute:{label:'Mesaj gönder',reviewLabel:'Onayla ve mesaj gönder',successCriteria:'The website shows this exact message sent to this listing or a new thread containing it.'}},table:{title:'Ev arama akışı',columns:[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'İlan',type:'text'},{key:'location',label:'Konum',type:'text'},{key:'rent',label:'Kira (€)',type:'money'},{key:'rooms',label:'Oda',type:'number'}]},version:1,title:'Ev arama',icon:'⌂',description:'İlanları takip et, kriterlerine uyan evleri bul ve ev sahiplerine yaz.',kind:'web',records:{identity:'url'},defaultMode:'prepare',fields:[field('location','Konum','Hangi şehir ve semtlerde ev arıyorsun?'),field('budget','Toplam kira sınırı','Aidat ve ek giderler dahil kira sınırın nedir?'),field('requirements','Ev kriterleri','Oda sayısı, taşınma tarihi ve kesin şartların neler?'),field('introduction','Tanıtım ve mesaj','Ev sahibine hangi bilgilerini iletebiliriz? Nasıl bir mesaj istersin?',false)],steps:['Seçilen sitelerde yeni ilanları bul','Kesin şartları ve tercihleri değerlendir','Uygun ilan için kişisel mesaj hazırla','Yetki varsa gönder ve sonucu doğrula'],guidance:'Record each listing with its exact URL, total rent, location, availability, matching reasons and unknowns. Never invent income, employment, documents or personal facts. Prepare an individual message using only provided facts. Contact a listing at most once. Follow responses only through the configured website.'},
 {id:'appointment',recordOperations:{prepare:{label:'Randevuyu hazırla'},execute:{label:'Rezervasyon yap',reviewLabel:'Onayla ve rezervasyon yap',successCriteria:'The portal confirms the exact date, time, center and applicant, ideally with a booking reference. Availability alone is insufficient.'}},table:{title:'Randevu akışı',columns:[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'İlan',type:'text'},{key:'location',label:'Merkez',type:'text'},{key:'date',label:'Randevu tarihi',type:'date'}]},version:1,title:'Randevu takibi',icon:'◷',description:'Seçtiğin portalda uygun tarihleri takip et; bildir, hazırla veya yetkin kapsamında randevu al.',kind:'web',defaultMode:'observe',fields:[field('service','Randevu türü','Hangi hizmet, ülke veya başvuru türü için randevu gerekiyor?'),field('location','Başvuru merkezi','Hangi şehir ve merkezler uygun?'),field('dates','Tarih aralığı','Hangi tarihler ve saatler uygun?'),field('applicants','Başvuran bilgileri','Kaç kişi için randevu gerekiyor? Portalın istediği bilgileri veya eksikleri belirt.',false)],steps:['Seçilen portalda oturumu kontrol et','Uygun tarihleri incele','Bulunan seçenekleri kaydet','Yetki ve güncel uygunluk varsa rezervasyon yap ve doğrula'],guidance:'Use only the configured appointment portal and user criteria. Availability is not a reservation. Record the observed date, center and time in the result. Before booking, recheck availability and exact applicant details. Never cancel an existing appointment, make a payment or change application details without separate explicit user instructions. Ask for manual browser takeover for login, MFA and access barriers. Do not bypass site protections. A trial validates observation only, never claim it has tested booking.'},
 {id:'custom',table:{title:'Takip akışı',columns:[{key:'source',label:'Kaynak',type:'text'},{key:'title',label:'Kayıt',type:'text'}]},version:1,title:'Özel otomasyon',icon:'✳',description:'Ne yapmak istediğini anlat; asistan sorularla işleyişi ve kuralları hazırlasın.',kind:'web',defaultMode:'observe',fields:[field('outcome','Beklenen sonuç','Bu otomasyonun hangi sonucu üretmesini istiyorsun?'),field('rules','Seçim kuralları','Hangi durumlarda işlem yapmalı, neleri dışarıda bırakmalı?'),field('completion','Bitiş koşulu','Hangi durumda tamamlanmış sayılmalı veya durmalı?')],steps:['Kaynakları incele','Kurallara göre değerlendir','Sonucu veya işlem taslağını kaydet','Yetki kapsamında uygula ve doğrula'],guidance:'Clarify the intended outcome, selection rules and stopping condition. Use the fixed browser capabilities supplied by this app. Do not install code, create background loops or promise unsupported integrations. The user can start tracking after setup review. Each source automatically gets a read-only trial on its first scheduled turn; later turns run its workflow.'}
];
export function automationTemplate(id){const template=automationTemplates.find(t=>t.id===id);if(!template)throw Error('Template bulunamadı');return templateContract(structuredClone(template));}
export const defaultAutomationSettings=withAgentDefaults();

export function webUrl(value){
 let url;try{url=new URL(value);}catch{throw Error('Geçerli bir web adresi gir');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Kullanıcı bilgisi içermeyen HTTP veya HTTPS adresi gerekli');
 url.hash='';return url.toString();
}
export function boundedText(value,label,max=12000,{empty=false}={}){
 if(typeof value!=='string'||(!empty&&!value.trim())||value.length>max)throw Error(`${label}: ${empty?'0':'1'}–${max} karakter gerekli`);
 return value.trim();
}
export function planInput(template,input,previous={}){
 const criteria=input.criteria??previous.criteria??{};
 if(!criteria||typeof criteria!=='object'||Array.isArray(criteria))throw Error('Kriterler geçersiz');
 const allowed=new Set(template.fields.map(f=>f.id));
 for(const key of Object.keys(criteria))if(!allowed.has(key))throw Error('Bilinmeyen kriter: '+key+'. Geçerli alanlar: '+[...allowed].join(', '));
 const sources=input.sources??previous.sources??[];
 if(!Array.isArray(sources)||sources.length>20)throw Error('En fazla 20 kaynak ekle');
 for(const f of template.fields){const value=criteria[f.id];if(value==null||value==='')continue;if(['number','money'].includes(f.type)&&(!Number.isFinite(Number(value))||String(value).trim()===''))throw Error(f.label+': sayı gerekli');if(f.type==='boolean'&&!['true','false'].includes(value))throw Error(f.label+': evet/hayır gerekli');if(f.type==='choice'&&!f.options?.includes(value))throw Error(f.label+': geçerli seçenek gerekli');if(f.type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))throw Error(f.label+': geçerli tarih gerekli');if(f.type==='url')webUrl(value);}
 return {title:boundedText(input.title??previous.title??template.title,'Ad',150),goal:boundedText(input.goal??previous.goal??'','Amaç',6000,{empty:true}),criteria:Object.fromEntries(Object.entries(criteria).map(([key,value])=>[key,boundedText(value,key,6000,{empty:true})])),sources:[...new Set(sources.map(webUrl))],instructions:boundedText(input.instructions??previous.instructions??'','İşleyiş',12000,{empty:true}),facts:boundedText(input.facts??previous.facts??'','Kişisel bilgiler',12000,{empty:true})};
}
export function missingPlanFields(automation,template=automationTemplate(automation.templateId)){return [...(!automation.goal?['Amaç']:[]),...(!automation.sources.length?['En az bir kaynak adresi']:[]),...template.fields.filter(f=>f.required&&!automation.criteria[f.id]).map(f=>f.label)];}
export function reusableTemplate(input,normalize=templateContract){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Template geçersiz');
 if(!Array.isArray(input.fields)||input.fields.length>20||!Array.isArray(input.steps)||input.steps.length<1||input.steps.length>12)throw Error('Template soruları ve adımları eksik');
 const fields=input.fields.map(f=>{if(!/^[a-z][a-z0-9_]{0,49}$/.test(f.id)||typeof f.required!=='boolean')throw Error('Geçersiz soru alanı');return {id:f.id,label:boundedText(f.label,'Alan adı',150),question:boundedText(f.question,'Soru',1000),required:f.required,type:['text','number','money','date','url','boolean','choice'].includes(f.type)?f.type:'text',...(f.options?{options:f.options.map(v=>boundedText(v,'Seçenek',150))}:{})};});
 if(new Set(fields.map(f=>f.id)).size!==fields.length)throw Error('Soru alanları benzersiz olmalı');
 return normalize({version:2,kind:input.kind??'web',execution:input.execution,workflow:input.workflow,recordOperations:input.recordOperations,records:input.records,mail:input.mail,icon:'✳',title:boundedText(input.title,'Template adı',150),description:boundedText(input.description,'Açıklama',1000),fields,steps:input.steps.map(step=>boundedText(step,'Adım',500)),guidance:boundedText(input.guidance??'','İşleyiş',12000,{empty:true}),defaultMode:'observe',...(input.table?{table:automationTable(input.table)}:{})});
}

const types=new Set(['text','number','money','date','url']);
const builtins=new Set(['source','title']);
const reserved=new Set(['status','updatedAt','actions','__proto__','constructor','prototype']);
const column=(key,label,type='text')=>({key,label,type});
export function defaultAutomationTable(templateId){
 const template=automationTemplates.find(t=>t.id===templateId);return structuredClone(template?.table??{title:'İşlem akışı',columns:[column('source','Kaynak'),column('title','İlan')]});
}

export function automationTable(input){
 if(!input||!Array.isArray(input.columns)||input.columns.length<2||input.columns.length>10)throw Error('Tablo 2–10 sütun içermeli');
 const keys=new Set();
 const columns=input.columns.map(c=>{
  if(!c||typeof c.key!=='string'||!/^[a-z][a-z0-9_]{0,39}$/.test(c.key)||reserved.has(c.key)||keys.has(c.key))throw Error('Geçersiz veya yinelenen sütun anahtarı');
  keys.add(c.key);if(!types.has(c.type)||builtins.has(c.key)&&c.type!=='text')throw Error('Geçersiz sütun türü');
  return {key:c.key,label:boundedText(c.label,'Sütun adı',60),type:c.type};
 });
 if(![...builtins].every(key=>keys.has(key)))throw Error('Kaynak ve başlık sütunları korunmalı');
 return {title:boundedText(input.title,'Tablo adı',120),columns};
}
export function automationCells(input,table){
 if(!Array.isArray(input)||input.length>10)throw Error('En fazla 10 hücre güncellenebilir');
 const cells={},columns=new Map(table.columns.map(c=>[c.key,c]));
 for(const entry of input){
  const c=columns.get(entry?.key);
  if(!c||builtins.has(c.key)||Object.hasOwn(cells,c.key))throw Error(`Hücre için tanımlı, benzersiz bir özel sütun gerekli. Geçersiz anahtar: ${String(entry?.key)}. source ve title uygulama tarafından doldurulur; cells içine ekleme. Yazılabilir sütunlar: ${table.columns.filter(column=>!builtins.has(column.key)).map(column=>column.key).join(', ')}. Kaydı bu sütunlarla tekrar gönder.`);
  let value=boundedText(entry.value,'Hücre değeri',2000,{empty:true});
  if(value&&['number','money'].includes(c.type)){
   if(!/^-?\d+(?:\.\d+)?$/.test(value)||!Number.isFinite(Number(value)))throw Error('Sayısal hücre noktalı ondalık sayı olmalı');
   value=String(Number(value));
  }
  if(value&&c.type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))throw Error('Tarih YYYY-MM-DD biçiminde olmalı');
  if(value&&c.type==='url')value=webUrl(value);
  cells[c.key]=value;
 }
 return cells;
}
