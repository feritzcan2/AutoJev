import './preparation.css';

export const preparationLabel=p=>p?.stale?'Güncellenmeli':({queued:'Hazırlık sırasında',inspecting:'Form inceleniyor',drafting:'Belgeler hazırlanıyor',waiting:'Bilgi bekliyor',partial:'Kısmen hazır',ready:'Hazırlık tamamlandı'})[p?.status]??'Başvuru hazırlığı';
const node=(tag,className='',text)=>{const e=document.createElement(tag);e.className=className;if(text!==undefined)e.textContent=text;return e;};
const itemStates={pending:'Hazırlanacak',ready:'Hazır',missing:'Eksik',omitted:'İsteğe bağlı · Atlandı'};

export function createPreparationUI(api,{refresh,notice}){
 const dialog=node('dialog','preparation-dialog');dialog.id='preparation-dialog';dialog.setAttribute('aria-label','Başvuru hazırlığı');document.body.append(dialog);
 let candidate=null,job=null,snapshot=null,editing=false,busy=false;
 const active=()=>snapshot?.workers?.some(w=>w.campaign?.task?.jobId===job?.id&&!w.campaign.task.report)||snapshot?.campaign?.task?.jobId===job?.id&&!snapshot.campaign.task.report;
 function button(label,action,style='quiet'){
  const b=node('button',style,label);b.type='button';b.onclick=async()=>{b.disabled=true;try{await action();}catch(error){notice(error.message);}finally{b.disabled=false;}};return b;
 }
 async function queue(id,j){const result=await api.prepareApplication(id,j.id);notice(result.message);await refresh();}
 function close(){dialog.close();editing=false;}
 function header(){
  const head=node('div','preparation-head'),copy=node('div');copy.append(node('span','preparation-eyebrow','BAŞVURU HAZIRLIĞI'),node('h2','',job.company),node('p','',job.role));head.append(copy,button('Kapat',close));return head;
 }
 async function edit(item){
  const id=candidate,j=job,revision=j.preparation.revision;
  const content=item.kind==='answer'?item.answer??'':await api.readDocument(id,item.documentPath);
  if(candidate!==id||job?.id!==j.id||!dialog.open)return;
  editing=true;const form=node('form','preparation-editor'),label=node('label','',item.label),input=node('textarea'),error=node('p','preparation-error');input.value=content;input.rows=14;input.maxLength=item.maxLength??12000;label.append(input);error.setAttribute('role','alert');
  const actions=node('div','preparation-actions'),save=node('button','primary','Kaydet');save.type='submit';actions.append(button('Geri',()=>{editing=false;render();}),save);form.append(label,error,actions);dialog.replaceChildren(header(),form);
  form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{await api.editPreparation(id,j.id,{revision,requirementId:item.id,content:input.value});editing=false;await refresh();notice('Düzenleme kaydedildi.');}catch(e){error.textContent=e.message;}finally{save.disabled=false;}};input.focus();
 }
 async function download(){
  const result=await api.exportPreparation(candidate,job.id),bytes=Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'})),a=node('a');
  a.href=url;a.download=result.name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 function render(){
  if(!job?.preparation||editing)return;
  const p=job.preparation,position=dialog.scrollTop,body=node('div','preparation-body'),summary=node('div','preparation-summary');
  summary.append(node('strong','',preparationLabel(p)),node('p','',p.note??'İlanın başvuru formu incelenecek; gereken belgeler ve cevaplar burada görünecek.'));
  if(p.stale)summary.append(node('p','preparation-warning','Profil veya CV değişti. Başvurmadan önce hazırlığı güncelle.'));
  if(p.coverageNote)summary.append(node('p','preparation-coverage',`${p.coverage==='complete'?'Form incelendi':'Formun bir kısmı incelendi'} · ${p.coverageNote}`));
  body.append(summary);
  const list=node('div','preparation-requirements');
  for(const item of p.requirements??[]){
   const row=node('section','preparation-requirement'),top=node('div','preparation-item-top'),copy=node('div'),actions=node('div','preparation-item-actions');
   copy.append(node('h3','',item.label),node('small','',[{required:'Zorunlu',optional:'İsteğe bağlı',unknown:'Zorunluluk bilinmiyor'}[item.required],item.format,item.language,item.maxLength?`${item.maxLength} karakter`:null,item.userEdited?'Sen düzenledin':null].filter(Boolean).join(' · ')));
   top.append(copy,node('span',`preparation-item-state ${item.status}`,itemStates[item.status]));row.append(top);
   if(item.note)row.append(node('p','preparation-item-note',item.note));
   if(item.answer)row.append(node('pre','preparation-answer',item.answer));
   if(item.documentPath){
    const id=candidate;actions.append(button('Aç ↗',()=>api.openDocument(id,item.documentPath)));
    if(/\.(md|txt)$/i.test(item.documentPath))actions.append(button('Önizle',async()=>{const text=await api.readDocument(id,item.documentPath);const preview=node('pre','preparation-answer',text);row.querySelector('.preparation-answer')?.remove();row.insertBefore(preview,actions);}));
   }
   if(p.hold&&!active()&&['found','blocked','prepared'].includes(job.status)&&(item.kind==='answer'||/\.(md|txt)$/i.test(item.documentPath??'')))actions.append(button('Düzenle',()=>edit(item)));
   if(item.status==='missing'&&snapshot?.questions?.some(q=>q.jobId===job.id&&q.answer===null))actions.append(button('Yanıtla',()=>{close();document.getElementById('questions')?.scrollIntoView({behavior:'smooth',block:'start'});}));
   if(actions.childElementCount)row.append(actions);list.append(row);
  }
  if(!list.childElementCount)list.append(node('p','preparation-empty','Form incelendikçe gereken dosyalar ve sorular burada görünecek.'));
  body.append(list);
  const actions=node('div','preparation-actions');
  if(p.requirements?.length)actions.append(button('Dosyaları indir',download));
  if(job.preparationQueueState==='available')actions.append(button('Hazırlığı güncelle',async()=>{busy=true;try{await queue(candidate,job);}finally{busy=false;render();}}));
  if(job.manualQueueState?.state==='available'&&!active())actions.append(button('Başvur',async()=>{const result=await api.queueApplication(candidate,job.id);notice(result.message);await refresh();},'primary'));
  for(const b of actions.children)b.disabled=busy;
  if(p.hold)body.append(node('p','preparation-footnote','Belgeler hazır olduğunda Başvur ile devam edebilirsin.'));
  dialog.replaceChildren(header(),body,actions);dialog.scrollTop=position;
 }
 dialog.addEventListener('close',()=>{editing=false;});
 return {
  update(id,next){snapshot=next;if(candidate!==null&&candidate!==id){close();job=null;candidate=null;return;}if(dialog.open){job=next?.jobs?.find(j=>j.id===job?.id);if(!job){close();return;}render();}},
  action(id,j){
   if(!api.prepareApplication)return null;
   if(j.preparation)return button('Hazırlık',()=>{candidate=id;job=j;editing=false;render();dialog.showModal();});
   if(!['available','queued','active'].includes(j.preparationQueueState)||['working','submitting','uncertain'].includes(j.status))return null;
   const b=button(j.preparationQueueState==='queued'?'Hazırlık sırasında':'Hazırla',()=>queue(id,j));b.disabled=j.preparationQueueState!=='available';b.setAttribute('aria-label',`${j.company} başvurusunu hazırla`);return b;
  }
 };
}
