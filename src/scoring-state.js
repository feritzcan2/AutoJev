// Shared by persistence and the UI; older scores need a fresh assessment.
export const SCORING_VERSION=4;
export const eligibilityLabels={verified:'Zorunlu şartlar karşılanıyor',unverified:'Zorunlu şartlar doğrulanmalı',mismatch:'Zorunlu şart karşılanmıyor'};
export const assessmentEligibility=assessment=>assessment?.eligibility??assessment?.calculation?.eligibility??'unverified';
export const oldScoringMethod=assessment=>(assessment?.scoringVersion??assessment?.calculation?.version??0)<SCORING_VERSION;
export function automaticAssessmentError(assessment,revision){
 if(!assessment)return null;
 if(oldScoringMethod(assessment)||assessment.revision!==revision)return 'Otomatik işlem için güncel yöntem ve kriterlerle yeniden puanla';
 if(assessment.score===null)return 'Otomatik işlem için kayıt değerlendirilmelidir';
 return assessmentEligibility(assessment)==='verified'?null:eligibilityLabels[assessmentEligibility(assessment)];
}
