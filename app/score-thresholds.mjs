// Shared by browser-rendered templates and the server-side scoring policy.
export function scoreThresholdValue(criteria,key,label){
 const raw=criteria[key];if(raw==null||String(raw).trim()==='')return null;
 const value=Number(raw);if(!Number.isInteger(value)||value<0||value>100)throw Error(label+': 0–100 arası tam sayı gerekli.');
 return value;
}
export const saveScoreThreshold=criteria=>scoreThresholdValue(criteria,'save_score_threshold','Minimum kayıt puanı');
