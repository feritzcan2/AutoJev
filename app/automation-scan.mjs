import {webUrl,boundedText} from './automation-templates.mjs';

// URLs come from the browser response, never from an agent-created page number.
export function observedLinks(response,pageUrl){
 const text=(response.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n'),links=new Set();
 const add=value=>{try{links.add(webUrl(new URL(value,pageUrl).href));}catch{}};
 try{const page=JSON.parse(text.slice(text.indexOf('\n')+1));for(const link of page.links??[])if(link.url)add(link.url);}catch{}
 for(const match of text.matchAll(/https?:\/\/[^\s"'<>\\\]\)]+/g))add(match[0]);
 for(const match of text.matchAll(/\/url:\s*["']?([^\s"']+)/g))add(match[1]);
 return [...links];
}

export function scanCheckpoint(run,input,{checkpoint=false}={}){
 if(run.kind!=='run'||!run.sourceUrl||run.recordId)throw Error('Tarama kapsamı yalnızca kaynak görevine aittir');
 if(!input||typeof input.complete!=='boolean'||!Array.isArray(input.pendingUrls)||input.pendingUrls.length>100)throw Error('Tarama kapsamı gerekli: complete, pendingUrls, reason, evidenceUrl');
 const pendingUrls=[...new Set(input.pendingUrls.map(webUrl))],origin=new URL(run.sourceUrl).origin;
 const known=new Set([run.sourceUrl,...(run.observedLinks??[]),...(run.scan?.pendingUrls??[])]);
 if(pendingUrls.some(url=>new URL(url).origin!==origin||!known.has(url)))throw Error('Devam adresleri bu kaynakta gerçekten gözlenen bağlantılar olmalı; URL tahmin etme');
 const evidenceUrl=webUrl(input.evidenceUrl),reason=boundedText(input.reason,'Kapsam açıklaması',2000);
 if(!(run.navigation??run.observations??[]).some(o=>o.url===evidenceUrl))throw Error('Kapsamın kanıt sayfasını bu turda gerçekten aç');
 if(input.complete&&pendingUrls.length)throw Error('Bekleyen sayfa veya ilan varken tarama tamamlandı denemez');
 if(!checkpoint&&!input.complete&&!pendingUrls.length)throw Error('Kısmi taramada kalan sayfa/ilan bağlantılarını kaydet; ilerleyemiyorsan engeli bildir');
 if(!checkpoint&&!input.complete&&JSON.stringify([...pendingUrls].sort())===JSON.stringify([...(run.scan?.pendingUrls??[])].sort()))throw Error('Devam noktası ilerlemedi. Kalan sayfaları işle veya gerçek engeli bildir; aynı işi tekrar kuyruğa koyma');
 return {complete:input.complete,pendingUrls,reason,evidenceUrl,...(input.completion?{completion:input.completion}:{})};
}
