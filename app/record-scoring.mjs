import {boundedText,webUrl} from './automation-templates.mjs';
import {listingIdentity} from './job-urls.mjs';

const text={type:'string',minLength:1,maxLength:3000};
const notes={type:'array',maxItems:10,items:text};
export const assessmentSchema={type:'object',additionalProperties:false,required:['status','score','summary','evidenceUrl','evidence','strengths','gaps','uncertainties'],properties:{status:{type:'string',enum:['scored','unavailable']},score:{type:['integer','null'],minimum:0,maximum:100},summary:text,evidenceUrl:text,evidence:text,strengths:notes,gaps:notes,uncertainties:notes}};
export const recordScoreTool={name:'record_automation_score',description:'Save the assigned record assessment after reading its detail and saved profile/documents. Follow criteria.ranking. Supply a 0–100 integer fit score and explanation, or unavailable with score=null and the observed barrier. Use the actual observed detail URL as evidenceUrl; known URL variants of the same listing are accepted and saved with the observed URL. Preserves status, proposal, approvals and submission evidence. Finish the scoring task after saving.',inputSchema:{...assessmentSchema,required:['itemId',...assessmentSchema.required],properties:{itemId:text,...assessmentSchema.properties}}};

export function recordAssessment(db,id,run,input){
 const a=db.get(id);
 if(run.revision!==a.revision)throw Error('Profil değişti; güncel bilgilerle yeniden puanla');
 if(db.template(a.templateId).fields.some(f=>f.id==='ranking')&&!a.criteria.ranking?.trim())throw Error('Önce profilde puanlama kriterlerini belirle');
 if(!input||!['scored','unavailable'].includes(input.status)||input.status==='scored'&&(!Number.isInteger(input.score)||input.score<0||input.score>100)||input.status==='unavailable'&&input.score!==null)throw Error('Puan 0–100 arasında tam sayı olmalı; değerlendirilemiyorsa boş bırakılmalı');
 const requestedUrl=webUrl(input.evidenceUrl),identity=listingIdentity(requestedUrl)?.key;
 const observation=run.observations.findLast(o=>o.evidence?.trim()&&(o.url===requestedUrl||identity&&listingIdentity(o.url)?.key===identity));
 if(!observation)throw Error('Puanlamadan önce ilan detayını bu görevde gözlemle; evidenceUrl için tarayıcı çıktısındaki gerçek ilan adresini kullan.');
 const evidenceUrl=observation.url;
 const lists=Object.fromEntries(['strengths','gaps','uncertainties'].map(key=>{
  if(!Array.isArray(input[key])||input[key].length>10)throw Error('Puanlama notları geçersiz');
  return [key,input[key].map(value=>boundedText(value,'Puanlama notu',3000))];
 }));
 return {status:input.status,score:input.score,summary:boundedText(input.summary,'Puan gerekçesi',3000),evidenceUrl,evidence:boundedText(input.evidence,'Puanlama kanıtı',3000),...lists,rubric:a.criteria.ranking??'',revision:run.revision,runId:run.id,scoredAt:db.now()};
}

export function assessmentCells(table,cells,assessment){
 return {...cells,...(table.columns.some(c=>c.key==='score'&&c.type==='number')?{score:assessment.score===null?'':String(assessment.score)}:{})};
}

export function saveRecordScore(db,id,runId,input){
 const run=db.activeRun(id,runId),item=db.result(id,input.itemId);
 if(run.recordOperation!=='score'||run.recordId!==item.id)throw Error('Puan yalnızca atanmış puanlama görevinde kaydedilebilir');
 if(item.trial||!['found','prepared'].includes(item.status))throw Error('Bu kayıt puanlanamaz');
 const assessment=recordAssessment(db,id,run,input),cells=assessmentCells(db.get(id).table,item.cells,assessment);
 return db.putResult({...item,assessment,cells,updatedAt:assessment.scoredAt});
}
