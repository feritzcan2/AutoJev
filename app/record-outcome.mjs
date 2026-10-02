import {browserRenderedText} from './browser-rendered-text.mjs';
const normalize=value=>String(value??'').replace(/\s+/g,' ').trim().toLowerCase();

// Negative evidence must be an explicit site status for this exact record.
// An unfinished form or absence of a success message cannot release a hold.
export function validateNotSubmitted(item,proof,page){
 if(!page||page.readiness?.loading)throw Error('Gönderilmediğini doğrulamak için güncel, yüklenmiş sayfa gerekli');
 if(![item.url,item.actionUrl].filter(Boolean).some(url=>new URL(url).origin===new URL(page.url).origin))throw Error('Gönderilmeme kanıtı kayıt veya işlem sitesinden gelmeli');
 const identity=normalize(proof?.recordEvidence),text=normalize(browserRenderedText(page));
 if(identity.length<6||!text.includes(identity))throw Error('Atanmış kayıt güncel sayfada bulunmalı');
 if(![item.url,item.actionUrl,item.title,item.key].some(value=>normalize(value).includes(identity)))throw Error('Gönderilmeme kanıtı atanmış kayıtla eşleşmiyor');
 const pattern=proof?.kind==='draft'?/\b(draft|not submitted|unsubmitted|entwurf|nicht (?:abgesendet|eingereicht)|taslak|gönderilmedi)\b/:proof?.kind==='rejected'?/\b(submission failed|not sent|was not submitted|could not (?:send|submit)|gönderilemedi)\b/:null;
 const status=pattern?.exec(text)?.[0];
 if(!status)throw Error('Açık taslak/gönderilmedi durumu gerekli; eksik CV veya başarı mesajının yokluğu yeterli değil');
 return {kind:proof.kind,quote:typeof proof.quote==='string'?proof.quote.slice(0,1000):status,recordEvidence:proof.recordEvidence,url:page.url};
}
