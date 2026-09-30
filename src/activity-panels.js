import {activityView,workerActivityView,ageLabel,elapsedLabel} from './activity.js';
import {renderMessageText} from './message-text.js';

export function activityPanels(single,{openLink,notice}){
 const parts=['title','detail','state','age','link','events'];
 for(const name of parts)single.querySelector(`#now-${name}`).dataset.activityPart=name;
 const template=single.cloneNode(true),row=document.createElement('section'),cards=new Map();
 template.querySelectorAll('[data-web-only]').forEach(element=>element.remove());
 row.className='worker-activity';row.hidden=true;row.setAttribute('aria-label','Worker’ların şu anki işleri');single.after(row);
 let candidate=null;
 function bind(panel){
  const card={panel,parts:Object.fromEntries(parts.map(name=>[name,panel.querySelector(`[data-activity-part="${name}"]`)]))};
  card.parts.link.onclick=async()=>{try{if(card.view?.url)await openLink(card.view.url);}catch(error){notice(error.message);}};
  return card;
 }
 const primary=bind(single);
 function create(worker){
  const panel=template.cloneNode(true);panel.removeAttribute('id');panel.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));
  panel.dataset.activityWorkerId=worker.id;panel.setAttribute('aria-label',`${worker.name} şu anki işi`);
  const label=document.createElement('b');label.className='now-worker';label.textContent=worker.name;panel.querySelector('.now-label').prepend(label);
  row.append(panel);const card=bind(panel);cards.set(worker.id,card);return card;
 }
 function draw(card,view,history){
  card.view=view;const {panel,parts:p}=card;
  panel.dataset.tone=view.tone;p.title.textContent=view.title;renderMessageText(p.detail,view.detail);p.state.textContent=view.state;
  p.age.textContent=view.running&&view.at?elapsedLabel(view.at):ageLabel(view.at);p.age.title=view.at?new Date(view.at).toLocaleString('tr-TR'):'';p.link.hidden=!view.url;
  if(!history)return;
  p.events.replaceChildren(...view.history.map(event=>{
   const li=document.createElement('li'),time=document.createElement('time'),label=document.createElement('span'),d=event.data;
   time.textContent=new Date(event.at).toLocaleTimeString('tr-TR');
   label.textContent=event.kind==='agent_context_restart'?`Context eşiği aşıldı${d.peakPercent==null?'':` (%${d.peakPercent.toLocaleString('tr-TR',{maximumFractionDigits:1})})`}; yeni oturum hazırlanıyor`:event.kind==='agent_activity'?d.message:event.kind==='question_asked'?d.question:event.kind==='question_answered'?'Kullanıcı yanıtı kaydedildi':event.kind==='submission_recorded'?`${d.company}: gönderim onayı kaydedildi`:event.kind==='job_found'?`${d.company} · ${d.role}: ilan bulundu`:`${d.company}: ${d.note??d.status}`;
   li.append(time,label);return li;
  }));
  if(!view.history.length){const li=document.createElement('li');li.textContent='Henüz kaydedilmiş işlem yok.';p.events.append(li);}
 }
 return {update(snapshot,history=false){
  if(candidate!==snapshot?.workspace?.id){candidate=snapshot?.workspace?.id;cards.clear();row.replaceChildren();row.scrollLeft=0;history=true;}
  const workers=snapshot?.workers??[],multiple=workers.length>1&&!snapshot?.progress;single.hidden=multiple;row.hidden=!multiple;
  if(!multiple){cards.clear();row.replaceChildren();draw(primary,snapshot?.activity??activityView(snapshot),history);return;}
  for(const [id,card] of cards)if(!workers.some(w=>w.id===id)){card.panel.remove();cards.delete(id);}
  for(const worker of workers){const existing=cards.get(worker.id),card=existing??create(worker);draw(card,workerActivityView(snapshot,worker),history||!existing);}
 }};
}
