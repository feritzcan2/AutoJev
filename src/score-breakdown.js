import {eligibilityLabels,assessmentEligibility} from './scoring-state.js';
const labels={technical:'Teknik / mesleki uyum',experience:'Deneyim',role:'Rol',preferences:'Çalışma tercihleri'};
const levels={direct:'Doğrudan',partial:'Kısmen',transferable:'Aktarılabilir',unknown:'Doğrulanmadı',mismatch:'Uyumsuz'};
const matches={met:'Karşılanıyor',partial:'Kısmen',unknown:'Doğrulanmadı',unmet:'Karşılanmıyor'};
const sources={cv:'CV',facts:'Profil',preferences:'Tercihler'};
const el=(tag,text)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;return node;};
export function scoreBreakdown(assessment){
 const root=el('section');root.className='record-score-breakdown';root.setAttribute('aria-label','Puan hesabı');
 root.append(el('p',eligibilityLabels[assessmentEligibility(assessment)]));
 if(assessment.eligibilityReason)root.append(el('p',assessment.eligibilityReason));
 const c=assessment.calculation;
 if(!c){if(assessment.score!==null)root.append(el('p','Puan, agent değerlendirmesine göre kaydedildi.'));return root;}
 root.append(el('h4','Puan hesabı'));
 const table=el('table'),head=el('thead'),titles=el('tr'),body=el('tbody');
 for(const label of ['Kriter','Eşleşme','Puan','Ağırlık','Katkı']){const th=el('th',label);th.scope='col';titles.append(th);}head.append(titles);
 for(const d of c.dimensions){const row=el('tr');for(const text of [labels[d.key],levels[d.level],d.points+'/100','%'+d.weight,Number(d.contribution.toFixed(2))])row.append(el('td',text));body.append(row);}
 table.append(head,body);root.append(table);
 root.append(el('p',c.cap===null?`Ağırlıklı toplam: ${c.score}/100.`:`Ağırlıklı toplam: ${c.rawScore}/100 · Zorunlu şart sınırı: ${c.cap} · Sonuç: ${c.score}/100.`));
 if(c.eligibility!=='verified')root.append(el('p',c.eligibility==='mismatch'?'Zorunlu bir şart veya temel uyum karşılanmıyor.':'Zorunlu şartlar veya temel uyum henüz tam doğrulanmadı.'));
 const evidence=el('details');evidence.append(el('summary','Kriter kanıtları ve zorunlu şartlar'));
 for(const d of [...c.dimensions,...c.requirements]){
  const item=el('div');item.append(el('h4',d.key?labels[d.key]+' · '+levels[d.level]:'Zorunlu şart · '+matches[d.match]),el('p',d.reason));
  if(d.listingQuote)item.append(el('p','İlan: '+d.listingQuote));
  item.append(el('p',d.candidateQuote?`${sources[d.candidateSource]}: ${d.candidateQuote}`:'Aday kanıtı doğrulanmadı.'));evidence.append(item);
 }
 root.append(evidence);return root;
}
