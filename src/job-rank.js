const labels={technical:'Teknik · %40',experience:'Deneyim · %30',role:'Hedef rol · %20',preferences:'Çalışma tercihleri · %10'};
export function jobRankCell(job,element){
 const cell=element('td','rank-cell'),rank=job.rank,decision=job.rankDecision;
 cell.dataset.state=decision?.state??'pending';
 if(!rank){cell.append(element('span','rank-pending',['submitted','skipped'].includes(job.status)?'—':'Puanlanacak'));return cell;}
 const detail=element('details','rank-details');
 detail.append(element('summary','rank-score',rank.score===null?'—':`${rank.score}/100`));
 detail.append(element('p','',rank.summary));
 for(const [key,value] of Object.entries(rank.dimensions??{}))detail.append(element('p','',`${labels[key]??key}: ${value.score}/100 — ${value.reason}`));
 for(const [key,label] of [['strengths','Eşleşmeler'],['gaps','Doğrulanmış eksikler'],['uncertainties','Belirsiz bilgiler']]){
  if(!rank[key]?.length)continue;
  detail.append(element('strong','',label));const list=element('ul');for(const text of rank[key])list.append(element('li','',text));detail.append(list);
 }
 for(const blocker of rank.blockers??[])detail.append(element('p','',`Uyum notu: ${blocker.requirement}\nİlan: ${blocker.listingEvidence}\nProfil: ${blocker.candidateEvidence}`));
 if(rank.evidence)detail.append(element('p','rank-evidence',`İlan kanıtı: ${rank.evidence}`));
 detail.append(element('small','',`Değerlendirme: ${new Date(rank.rankedAt).toLocaleString('tr-TR')} · Başarı olasılığı değildir.`));
 cell.append(detail);
 if(decision?.label)cell.append(element('small','rank-label',decision.state==='eligible'&&decision.label!=='Kullanıcı sıraya aldı'?'Puan koşulu karşılanıyor':decision.label));
 return cell;
}
