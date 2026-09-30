import {boundedText} from './automation-templates.mjs';

// A partial scan is unfinished work, not a request for human intervention.
// Keep a structured reason so the UI need not infer this from a prose summary.
export function sourceStop(run,input){
 if(run.kind!=='run'||!run.sourceUrl||run.recordId||!['failed','blocked'].includes(input.status))return null;
 const stop=input.stop;
 if(!stop||!['access','technical','user_input','incomplete'].includes(stop.kind))throw Error('Kaynak duruşu için stop.kind ve stop.evidence gerekli. Kalan sayfa, sorgu veya detay varsa incomplete kullan; bu durumda aynı görevde devam et.');
 if(stop.kind==='incomplete')throw Error('Eksik kapsam hata veya erişim engeli değildir. Devam noktasını kaydet ve kalan sayfa, sorgu ve detayları aynı görevde işle.');
 const evidence=boundedText(stop.evidence,'Gerçek engelin kanıtı',2000);
 return {kind:stop.kind,evidence};
}
