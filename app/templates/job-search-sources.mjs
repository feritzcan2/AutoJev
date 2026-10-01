import {sourceIntegrations} from '../source-catalog.mjs';

const sources=[
 ['LinkedIn','https://www.linkedin.com/jobs/',15],
 ['StepStone','https://www.stepstone.de/',30],
 ['Indeed','https://www.indeed.com/',30],
 ['JOIN','https://join.com/',30],
 ['Personio','https://www.personio.com/',45],
 ['Greenhouse','https://www.greenhouse.com/',45],
 ['Lever','https://www.lever.co/',45],
 ['Ashby','https://www.ashbyhq.com/',45],
 ['Şirket kariyer sayfaları','https://www.google.com/search',60]
].map(([name,url,intervalMinutes])=>({name,url,intervalMinutes,enabled:true,query:'Kayıtlı hedef rollere, ülke ve çalışma tercihlerine uygun güncel ilanlar'}));
for(const tool of sourceIntegrations){
 const existing=sources.find(source=>source.url===tool.url);
 const settings={integrationId:tool.id,searchMethod:'tool',fallback:'web'};
 if(existing)Object.assign(existing,settings);
 else sources.push({name:tool.name,url:tool.url,intervalMinutes:30,enabled:tool.market==='global',query:'Kayıtlı hedef rollere, ülke ve çalışma tercihlerine uygun güncel ilanlar',...settings});
}
export const jobSearchSources=sources;
