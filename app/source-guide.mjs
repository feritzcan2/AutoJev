export const SOURCE_GUIDE_SECTIONS={search:'Arama ve filtreler',pagination:'Sayfalama',details:'Detay okuma',access:'Erişim ve engeller'};
export const SOURCE_GUIDE_STATES={verified:'Doğrulandı',unverified:'Henüz doğrulanmadı',blocked:'Engel gözlendi'};

export function validateGuideOverrides(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Geçersiz kaynak rehberi');
 const result={};
 for(const [key,text] of Object.entries(value)){
  if(!Object.hasOwn(SOURCE_GUIDE_SECTIONS,key)||typeof text!=='string'||text.length>6000||!text.trim())throw Error('Kaynak rehberi bölümü boş olamaz ve 6000 karakteri aşamaz');
  result[key]=text;
 }
 return result;
}

export function guideSections(skill,overrides={}){
 return Object.entries(SOURCE_GUIDE_SECTIONS).filter(([key])=>overrides[key]!==undefined||skill?.sections.some(s=>s.key===key)).map(([key,title])=>{
  const section=skill?.sections.find(s=>s.key===key),userEdited=Object.hasOwn(overrides,key);
  return {...section,key,title,instructions:userEdited?overrides[key]:section.instructions,status:userEdited||skill?.needsReview?'unverified':section.status,evidence:userEdited?[]:section.evidence,userEdited};
 });
}
