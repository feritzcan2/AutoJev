import {createHash} from 'node:crypto';
import {rankWeights,normalizeRankWeights,weightedRankScore} from './rank-criteria.mjs';
export {rankWeights} from './rank-criteria.mjs';

export const RANK_VERSION=1;
export function rankProfileKey(profile){
 return createHash('sha256').update(JSON.stringify([profile.facts,profile.preferences,profile.cvPath,profile.cvRevision??null])).digest('hex');
}
export function rankThreshold(value=50){
 if(!Number.isInteger(value)||value<0||value>100)throw Error('Puan eşiği 0–100 arasında tam sayı olmalı');
 return value;
}
const text=value=>{if(typeof value!=='string'||!value.trim()||value.length>3000)throw Error('Puanlama gerekçesi ve kanıtları gerekli');return value.trim();};
const list=value=>{if(!Array.isArray(value)||value.length>10)throw Error('Puanlama listesi en fazla 10 madde içerebilir');return value.map(text);};
export function normalizeRank(input,profile){
 if(!input||!['scored','unavailable'].includes(input.status))throw Error('Geçersiz puanlama sonucu');
 const base={version:RANK_VERSION,profileKey:rankProfileKey(profile),rankedAt:new Date().toISOString(),status:input.status,summary:text(input.summary)};
 if(input.status==='unavailable'){
  const check=input.browserCheck;
  if(!check||!['jev','existing','playwright'].includes(check.backend))throw Error('WebFetch/HTTP hatası yeterli değil. Aynı ilanı adayın tarayıcısında kontrol et ve browserCheck ile gerçek sonucu kaydet. Tarayıcı bağlı değilse bağlantıyı kurtar; ilanı erişilemez sayma.');
  const url=new URL(check.url);if(!['http:','https:'].includes(url.protocol))throw Error('Tarayıcı kontrolü için ilan URL gerekli');
  return {...base,score:null,browserCheck:{backend:check.backend,url:url.href,evidence:text(check.evidence),...(check.observationId?{observationId:text(check.observationId)}:{})}};
 }
 if(!['open','closed'].includes(input.availability))throw Error('İlanın açık veya kapalı olduğu doğrulanmalı; erişilemiyorsa unavailable kullan');
 const dimensions={};
 for(const key of Object.keys(rankWeights)){
  const d=input.dimensions?.[key];if(!d||!Number.isInteger(d.score)||d.score<0||d.score>100)throw Error('Her kriter için 0–100 puan gerekli');
  dimensions[key]={score:d.score,reason:text(d.reason)};
 }
 if(!Array.isArray(input.blockers)||input.blockers.length>10)throw Error('Kesin engeller bir liste olmalı');
 const blockers=input.blockers.map(b=>({requirement:text(b.requirement),listingEvidence:text(b.listingEvidence),candidateEvidence:text(b.candidateEvidence)}));
 const weights=normalizeRankWeights(profile.rankWeights);
 return {...base,weights,score:weightedRankScore(dimensions,weights),availability:input.availability,evidence:text(input.evidence),dimensions,strengths:list(input.strengths),gaps:list(input.gaps),uncertainties:list(input.uncertainties),blockers};
}
export function rankDecision(profile,job){
 const rank=job.rank,threshold=rankThreshold(profile.rankThreshold);
 if(job.canonicalJobId&&job.canonicalJobId!==job.id)return{state:'duplicate',eligible:false,threshold,label:'Aynı ilanın bağlı kaydı',canonicalJobId:job.canonicalJobId};
 if(job.duplicateApplication)return{state:'duplicate',eligible:false,threshold,label:'Önceki başvuruyla olası tekrar',duplicateApplication:job.duplicateApplication};
 if(!rank||job.rankRetry||rank.status==='unavailable'&&!rank.browserCheck)return{state:'pending',eligible:false,threshold,label:'Puanlanacak'};
 if(rank.status==='unavailable')return{state:'unavailable',eligible:false,threshold,label:'İlan sayfasına erişilemedi'};
 const override=job.rankOverride?.profileKey===rank.profileKey&&job.rankOverride?.rankedAt===rank.rankedAt;
 if(rank.availability==='closed')return{state:'blocked',eligible:false,threshold,label:'İlan kapalı'};
 return rank.score>threshold||override?{state:'eligible',eligible:true,threshold,label:override?'Kullanıcı sıraya aldı':'Başvuru sırasında'}:{state:'below_threshold',eligible:false,threshold,label:'Puan eşiğinin altında'};
}

export function applicationReadiness(profile,job,source){
 if(job.preparation?.hold)return {state:'preparation',eligible:false,label:({queued:'Hazırlık sırasında',inspecting:'Form inceleniyor',drafting:'Belgeler hazırlanıyor',waiting:'Hazırlık bilgi bekliyor',partial:'Hazırlık kısmen tamamlandı',ready:'Hazırlık tamamlandı'})[job.preparation.status]??'Hazırlık'};
 if(job.manualApplication&&!job.manualApplication.verificationOnly)return{state:'manual',eligible:true,label:'Öncelikli başvuru'};
 if(profile.authorization==='research')return{state:'research',label:'Yalnızca araştırma yetkisi'};
 if(source?.applyMode==='find_only')return{state:'find_only',label:'Kaynak: sadece bul'};
 return rankDecision(profile,job);
}
