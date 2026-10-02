import {createHash} from 'node:crypto';

import {SCORING_VERSION} from '../src/scoring-state.js';
export {SCORING_VERSION};
export const SCORE_DIMENSIONS=['technical','experience','role','preferences'];
export const SCORE_LEVELS={direct:100,partial:70,transferable:30,unknown:0,mismatch:0};
export const SCORING_INSTRUCTIONS='Assign an integer score from 0 to 100 using the saved criteria.ranking, weights and candidate profile. Only score is required when saving; the application accepts your score directly. Reasons, strengths, gaps, uncertainties and quote fields are optional. No quote matching, page proof or scorecard is required. Read the profile and listing for fit, reuse information already read, and do not reread just to match wording. As scoring guidance, direct experience is stronger than partial or transferable skills; employer branding or industry does not by itself make a role match the target field. Score each dimension from the actual evidence and combine the saved weights. Do not cap or force scores below a threshold because of eligibility; eligibility is saved separately. Required experience, seniority, language and location affect their relevant fit dimension. Separately save eligibility=verified when mandatory conditions are established, mismatch for a confirmed unmet mandatory condition, or unverified when information is missing or ambiguous. Use eligibilityReason for a short explanation. A title alone does not prove a seniority mismatch. Missing qualifications remain uncertain. A high fit score never establishes eligibility or authorizes an application; unresolved or unmet mandatory conditions prevent automatic applications. For inaccessible details use status=unavailable and score=null. Do not save a new production listing without its score or unavailable status.';
const aliases={technical:'(?:teknik(?:/mesleki)?(?: eşleşme)?|mesleki(?: eşleşme)?|yetkinlik|technical(?: skills)?|skills?)',experience:'(?:deneyim|experience)',role:'(?:rol|role)',preferences:'(?:çalışma tercihleri|tercihler|tercih|preferences?)'};
export function scoringPolicy(automation){
 const rubric=automation.criteria?.ranking??'',weights={};
 for(const [key,label] of Object.entries(aliases)){
  const pattern=new RegExp(`(?<![\\p{L}])${label}\\s*(?::|=)?\\s*(?:%\\s*(\\d{1,3})|(\\d{1,3})\\s*%)`,'giu');
  const found=[...rubric.matchAll(pattern)].map(m=>Number(m[1]??m[2]));
  if(new Set(found).size>1)throw Error('Puanlama ağırlıkları çelişkili; etkin kriterleri düzelt.');
  if(found.length)weights[key]=found[0];
 }
 const explicit=Object.keys(weights).length>0;
 if(explicit){for(const key of SCORE_DIMENSIONS)weights[key]??=0;if(Object.values(weights).reduce((a,b)=>a+b,0)!==100)throw Error('Etkin kriterlerdeki puanlama ağırlıkları toplamı %100 olmalı.');}
 else Object.assign(weights,{technical:70,experience:10,role:10,preferences:10});
 const threshold=Number(rubric.match(/(?:eşik|alt sınır|threshold|minimum)\s*:?\s*(\d{1,3})/iu)?.[1]??rubric.match(/\b(\d{1,3})\s*\/\s*100\b/u)?.[1]??60);
 if(threshold<1||threshold>100)throw Error('Puanlama eşiği 1–100 arasında olmalı.');
 const policy={version:SCORING_VERSION,weights,weightSource:explicit?'criteria.ranking':'default',threshold,levels:SCORE_LEVELS};
 return {...policy,digest:createHash('sha256').update(JSON.stringify([policy,automation.revision,rubric])).digest('hex'),instructions:SCORING_INSTRUCTIONS};
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
