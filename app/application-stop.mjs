// Only explicit, job-scoped stop replies. A negative answer to a form field,
// 'skip the CAPTCHA', or a sentence containing 'skip' is not a cancellation.
export function isStopReply(answer,job,question){
 if(typeof answer!=='string')return false;
 const clean=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/ı/g,'i').replace(/[’']/g,'').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+/g,' ').trim();
 const reply=clean(answer).replace(/^(?:(?:tmm|tamam|ok|okay|lutfen|please) )+/,'').replace(/ (lutfen|please)$/,'').replace(/^(?:(?:hayir|yok|no) )+(?=basvurma$|devam etme$|do not apply$|do not continue$)/,'');
 if(['evet','yes'].includes(reply)&&!question?.fields?.length){
  const prompt=clean(question?.question??'');
  if(/(?:^| )basvuruyu tamamen durdurmami onayliyor musun(?: evet ya da hayir diye yanitla)?$/.test(prompt))return true;
 }
 const company=clean(job.company),subjects=['bunu','bu isi','bu ilani','bu basvuruyu','this application','this job',company,company+'i',company+'yi'];
 // A phonetic company spelling is accepted only with the explicit Turkish cancel command.
 const cancel=reply.match(/^iptal et (\p{L}+)$/u);
 const phonetic=value=>value.replace(/(.)\1+/g,'$1').replace(/[aeiou]/g,'');
 if(cancel&&/^[a-z]{4,}$/.test(company)&&cancel[1].length>=4){
  const target=cancel[1].replace(/(?:yi|i)$/,'');
  if(phonetic(target).length>=2&&phonetic(target)===phonetic(company))return true;
 }
 const verbs=['iptal et','atla','gec','birak','durdur','vazgec','skip','stop','cancel'];
 return verbs.includes(reply)||['devam etme','basvurma','do not continue','do not apply'].includes(reply)||subjects.some(s=>verbs.some(v=>reply===`${s} ${v}`||reply===`${v} ${s}`));
}
