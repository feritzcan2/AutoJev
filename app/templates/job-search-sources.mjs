import bundledSources from '../../source-library/sources.json' with {type:'json'};
const sources=[
 ['LinkedIn','https://www.linkedin.com/jobs/',15],
 ['StepStone','https://www.stepstone.de/',30],
 ['Indeed','https://www.indeed.com/',30],
 ['JOIN','https://join.com/',30],
 ['Personio','https://www.personio.com/',45],
 ['Greenhouse','https://www.greenhouse.com/',45],
 ['Lever','https://www.lever.co/',45],
 ['Ashby','https://www.ashbyhq.com/',45],
 ['Şirket kariyer sayfaları','https://www.google.com/search',60],
 ['FreeHire','https://freehire.me/',30],
 ['Jobindex','https://www.jobindex.dk/',30,false],
 ['Jobnet','https://jobnet.dk/',30,false],
 ['Jobdanmark','https://jobdanmark.dk/',30,false],
 ['Akademikernes Jobbank','https://jobbank.dk/',30,false]
].map(([name,url,intervalMinutes,enabled=true])=>({...bundledSources.find(source=>source.url===url),name,url,intervalMinutes,enabled,query:'Kayıtlı hedef rollere, ülke ve çalışma tercihlerine uygun güncel ilanlar'}));
export const jobSearchSources=sources;
