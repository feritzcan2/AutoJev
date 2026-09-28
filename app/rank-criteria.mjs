// Shared by the scorer and both desktop/mobile settings views.
export const rankCriteria={
 technical:{label:'Teknik uyum',description:'İşin gerektirdiği beceri ve teknolojiler',weight:40},
 experience:{label:'Deneyim',description:'Sorumluluklar, deneyim ve kıdem düzeyi',weight:30},
 role:{label:'Hedef rol',description:'İstediğin pozisyon ve iş alanı',weight:20},
 preferences:{label:'Çalışma tercihleri',description:'Konum, uzaktan çalışma ve maaş beklentisi',weight:10}
};
export const rankWeights=Object.freeze(Object.fromEntries(Object.entries(rankCriteria).map(([key,value])=>[key,value.weight])));

export function normalizeRankWeights(value=rankWeights){
 const keys=Object.keys(rankWeights);
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)||!Number.isInteger(value[key])||value[key]<0||value[key]>100))throw Error('Her kriterin oranı 0–100 arasında tam sayı olmalı');
 if(keys.reduce((sum,key)=>sum+value[key],0)!==100)throw Error('Seçili puanlama kriterlerinin toplamı %100 olmalı');
 return Object.fromEntries(keys.map(key=>[key,value[key]]));
}

export function weightedRankScore(dimensions,weights){
 return Math.round(Object.entries(weights).reduce((sum,[key,weight])=>sum+dimensions[key].score*weight,0)/100);
}
