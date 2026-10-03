import {createHash} from 'node:crypto';

import {SCORING_VERSION} from '../src/scoring-state.js';
export {SCORING_VERSION};
export const SCORE_DIMENSIONS=['technical','experience','role','preferences'];
export const SCORE_LEVELS={direct:100,partial:70,transferable:30,unknown:0,mismatch:0};
export const SCORING_INSTRUCTIONS='Assign an integer score from 0 to 100. Use scoringPolicy.weights (technical, experience, role, preferences) and the saved criteria.ranking text as the rubric; the candidate profile comes from read_scoring_profile. Only score is required when saving; reasons, strengths, gaps and uncertainties are optional and no quote matching or page proof is needed. Direct experience is stronger than partial or transferable skills; employer branding or industry does not by itself make a role match the target field. Required experience, seniority, language and location affect their relevant dimension. Do not cap the score because of eligibility; save eligibility separately: verified when mandatory conditions are established, mismatch for a confirmed unmet mandatory condition, unverified when information is missing or ambiguous, with a short eligibilityReason. A title alone does not prove a seniority mismatch. A high score never authorizes an application. For inaccessible details use status=unavailable and score=null. Do not save a new production listing without its score or unavailable status.';
export const SCORE_WEIGHT_FIELDS={technical:'weight_technical',experience:'weight_experience',role:'weight_role',preferences:'weight_preferences'};
export const SCORE_THRESHOLD_FIELD='score_threshold';
const DEFAULT_WEIGHTS={technical:70,experience:10,role:10,preferences:10};
const integerField=(criteria,key,label)=>{
 const raw=criteria[key];if(raw==null||String(raw).trim()==='')return null;
 const value=Number(raw);if(!Number.isInteger(value)||value<0||value>100)throw Error(label+': 0–100 arası tam sayı gerekli.');
 return value;
};
// Weights and the threshold are plain number fields of the setup form. Without
// explicit weights the defaults apply; a partial set must still add up to 100.
export function scoringPolicy(automation){
 const criteria=automation.criteria??{},weights={};
 for(const [dimension,key] of Object.entries(SCORE_WEIGHT_FIELDS)){const value=integerField(criteria,key,'Puanlama ağırlığı '+dimension);if(value!==null)weights[dimension]=value;}
 const explicit=Object.keys(weights).length>0;
 if(explicit){for(const key of SCORE_DIMENSIONS)weights[key]??=0;if(Object.values(weights).reduce((a,b)=>a+b,0)!==100)throw Error('Puanlama ağırlıkları toplamı %100 olmalı.');}
 else Object.assign(weights,DEFAULT_WEIGHTS);
 const threshold=integerField(criteria,SCORE_THRESHOLD_FIELD,'Puanlama eşiği')??60;
 if(threshold<1)throw Error('Puanlama eşiği 1–100 arasında olmalı.');
 const policy={version:SCORING_VERSION,weights,weightSource:explicit?'criteria':'default',threshold,levels:SCORE_LEVELS};
 return {...policy,digest:createHash('sha256').update(JSON.stringify([policy,automation.revision,criteria.ranking??''])).digest('hex'),instructions:SCORING_INSTRUCTIONS};
}
export const normalizedQuote=value=>String(value??'').normalize('NFKC').replace(/\s+/gu,' ').trim();
const sourcesFor=(dimension,kind)=>dimension==='technical'||dimension==='experience'||kind==='qualification'?['cv','facts']:['cv','facts','preferences'];
export function calculateScorecard(card,policy,{sources}){
 if(!card||!Array.isArray(card.dimensions)||card.dimensions.length!==4||!Array.isArray(card.requirements)||card.requirements.length>30)throw Error('İsteğe bağlı puan dökümü geçersiz: scorecard.dimensions dört kalemi ve scorecard.requirements bir dizi içermeli.');
 const issues=[],check=(entry,{dimension,kind,label})=>{
  const issue=message=>issues.push(label+': '+message);
  if(!entry||typeof entry.reason!=='string'||!entry.reason.trim()||entry.reason.length>1500)issue('Her puan kalemi için somut gerekçe gerekli.');
  if(!sourcesFor(dimension,kind).includes(entry.candidateSource))issue('Mesleki deneyim için tercih metni kanıt sayılamaz; cv veya facts kullan.');
 };
 const seen=new Set(),dimensions=card.dimensions.map(entry=>{
  if(!SCORE_DIMENSIONS.includes(entry.key)||seen.has(entry.key)||!Object.hasOwn(SCORE_LEVELS,entry.level))throw Error('Puan kalemleri technical, experience, role, preferences olmalı ve tekrarlanmamalı.');seen.add(entry.key);
  check(entry,{dimension:entry.key,label:'dimensions.'+entry.key});
  return {...entry,listingQuote:entry.listingQuote??'',candidateQuote:entry.candidateQuote??'',points:SCORE_LEVELS[entry.level],weight:policy.weights[entry.key],contribution:SCORE_LEVELS[entry.level]*policy.weights[entry.key]/100};
 });
 const required=new Set(),requirements=card.requirements.map((entry,index)=>{
  if(!['qualification','preference'].includes(entry.kind)||!['met','partial','unknown','unmet'].includes(entry.match))throw Error('Zorunlu şartın türü ve eşleşmesi gerekli.');
  check(entry,{kind:entry.kind,label:'requirements['+index+']'});
  const key=normalizedQuote(entry.listingQuote)||normalizedQuote(entry.reason);if(required.has(key))throw Error('Aynı zorunlu şart tekrarlanamaz.');required.add(key);
  return {...entry,listingQuote:entry.listingQuote??'',candidateQuote:entry.candidateQuote??''};
 });
 if(issues.length)throw Error(issues.join('\n')+'\nTüm işaretli alanları tek seferde düzelt.');
 const core=dimensions.filter(d=>d.weight>0&&['technical','experience','role'].includes(d.key));
 const unmet=requirements.some(r=>r.match==='unmet')||core.some(d=>d.level==='mismatch'),unverified=requirements.some(r=>['unknown','partial'].includes(r.match))||core.some(d=>d.level==='unknown'),eligibility=unmet?'mismatch':unverified?'unverified':'verified';
 const rawScore=Math.round(dimensions.reduce((sum,d)=>sum+d.contribution,0)),score=rawScore,cap=null;
 return {version:SCORING_VERSION,score,rawScore,eligibility,cap,dimensions,requirements,policy:{digest:policy.digest,weights:policy.weights,weightSource:policy.weightSource,threshold:policy.threshold},sources:Object.fromEntries([...new Set([...dimensions,...requirements].map(x=>x.candidateSource))].map(key=>[key,{digest:sources[key]?.digest??null,path:sources[key]?.path??null}]))};
}
