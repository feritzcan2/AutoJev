// A source scan may use a browser, web search or a local integration. Keep the
// continuation independent of the transport so every source can resume.
export function sourceCoverage(input,{outcome='partial'}={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.complete!=='boolean'||!Array.isArray(input.pendingUrls)||input.pendingUrls.length>100||typeof input.evidence!=='string'||!input.evidence.trim()||input.evidence.length>2000)throw Error('Tarama kapsamı gerekli: complete, pendingUrls ve gözlenen kanıt.');
 const pendingUrls=[...new Set(input.pendingUrls.map(value=>{
  if(typeof value!=='string'||value.length>3000)throw Error('Geçersiz devam adresi.');
  const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Geçersiz devam adresi.');
  return url.toString();
 }))];
 const nextStep=input.nextStep===undefined?null:input.nextStep;
 if(nextStep!==null&&(typeof nextStep!=='string'||!nextStep.trim()||nextStep.length>2000))throw Error('Geçersiz devam adımı.');
 const coverage={complete:input.complete,pendingUrls,...(nextStep?{nextStep:nextStep.trim()}:{}),evidence:input.evidence.trim()};
 if(outcome==='partial'&&(coverage.complete||!pendingUrls.length&&!nextStep))throw Error('Kısmi taramada kalan ilanları veya sonraki arama adımını kaydet.');
 if(outcome==='blocked'&&coverage.complete)throw Error('Engellenen tarama tamamlandı olarak bildirilemez.');
 if(['done','no_results'].includes(outcome)&&(!coverage.complete||pendingUrls.length||nextStep))throw Error('Bekleyen ilan veya sayfa varken tarama tamamlandı denemez.');
 if(coverage.complete&&(pendingUrls.length||nextStep))throw Error('Tamamlanan taramada devam noktası olamaz.');
 return coverage;
}
