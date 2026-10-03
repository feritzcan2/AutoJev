import {boundedText} from './automation-templates.mjs';

// A partial scan is unfinished work, not a request for human intervention. The
// agent only names an access barrier or a missing user fact; loading failures
// are verified by the app itself and become a technical stop with a retry.
export function sourceStop(run,input){
 if(run.kind!=='run'||!run.sourceUrl||run.recordId||!['failed','blocked'].includes(input.status))return null;
 const stop=input.stop,verified=Object.values(run.scanIssues??{}).filter(issue=>issue.verified);
 if(stop&&['access','user_input'].includes(stop.kind))return {kind:stop.kind,evidence:boundedText(stop.evidence,'Gerçek engelin kanıtı',2000)};
 if(stop&&stop.kind!=='technical')throw Error('Kaynak duruşu için stop.kind access veya user_input gerekli. Eksik kapsam engel değildir; kalan sayfa ve detayları aynı görevde işle.');
 if(!verified.length)throw Error('Doğrulanmış bir yükleme hatası yok. Erişim engeli için stop.kind=access, eksik kullanıcı bilgisi için user_input bildir; aksi halde kalan işe devam et.');
 const remaining=(run.scan?.pendingUrls??[]).filter(url=>!verified.some(issue=>issue.global||issue.url===url));
 if(remaining.length)throw Error(`Sorun tüm kaynağı durdurmuyor. Önce erişilebilir ${remaining.length} bekleyen adresi işle: ${remaining.slice(0,3).join(', ')}.`);
 return {kind:'technical',evidence:boundedText(stop?.evidence??verified[0].evidence,'Gerçek engelin kanıtı',2000),issueIds:verified.map(issue=>issue.id)};
}
