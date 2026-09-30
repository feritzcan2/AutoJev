import {boundedText} from './automation-templates.mjs';

// A partial scan is unfinished work, not a request for human intervention.
// Keep a structured reason so the UI need not infer this from a prose summary.
export function sourceStop(run,input){
 if(run.kind!=='run'||!run.sourceUrl||run.recordId||!['failed','blocked'].includes(input.status))return null;
 const stop=input.stop;
 if(!stop||!['access','technical','user_input','incomplete'].includes(stop.kind))throw Error('Kaynak duruşu için stop.kind ve stop.evidence gerekli. Kalan sayfa, sorgu veya detay varsa incomplete kullan; bu durumda aynı görevde devam et.');
 if(stop.kind==='incomplete')throw Error('Eksik kapsam hata veya erişim engeli değildir. Devam noktasını kaydet ve kalan sayfa, sorgu ve detayları aynı görevde işle.');
 const evidence=boundedText(stop.evidence,'Gerçek engelin kanıtı',2000);
 if(stop.kind==='technical'){
  const issues=Object.values(run.scanIssues??{}),ids=stop.issueIds;
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>!issues.some(issue=>issue.id===id&&issue.verified)))throw Error('Teknik duruş için bu turda araçla doğrulanmış issueIds gerekli. Yükleme sorunu için recheck_scan_page kullan; gerçek tarayıcı hatasını bir kez yeniden kontrol et. Açıklama tek başına kanıt değildir.');
  const selected=issues.filter(issue=>ids.includes(issue.id));
  const remaining=(run.scan?.pendingUrls??[]).filter(url=>!selected.some(issue=>issue.global||issue.url===url));
  if(remaining.length)throw Error(`Sorun tüm kaynağı durdurmuyor. Önce erişilebilir ${remaining.length} bekleyen adresi işle: ${remaining.slice(0,3).join(', ')}. Yalnızca doğrulanmış sorunlu adresleri sona bırak.`);
  return {kind:stop.kind,evidence,issueIds:ids};
 }
 return {kind:stop.kind,evidence};
}
