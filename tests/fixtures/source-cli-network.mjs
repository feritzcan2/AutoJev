import assert from 'node:assert/strict';
const job={public_slug:'developer-fixture',title:'Developer',company:'Fixture Co',url:'https://employer.test/jobs/123',description:'Build accessible tools.',skills:['JavaScript'],regions:['eu'],countries:['DE'],cities:['Berlin'],location:'Berlin',posted_at:'2026-10-01',enrichment:{}};
// Exercise real compiled CLI handlers without network access. Every unexpected
// URL or request shape exits the child, including before its retry handlers.
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input)),fixture=process.env.AUTOJEV_CLI_FIXTURE;
 try{
  if(fixture==='forbidden')return new Response('Access denied',{status:403});
  if(fixture==='freehire-search'){
   assert.equal(url.origin,'https://freehire.me');assert.equal(url.pathname,'/api/v1/agent/jobs/search');assert.equal(url.searchParams.get('countries'),'DE');assert.equal(url.searchParams.get('offset'),'2');assert.equal(url.searchParams.get('include_description'),'true');
   return Response.json({data:[job],meta:{total:3,limit:2,offset:2}});
  }
  if(fixture==='freehire-detail'){assert.equal(url.pathname,'/api/v1/jobs/developer-fixture');return Response.json({data:job});}
  if(fixture==='jobnet-search'){
   assert.equal(url.origin,'https://jobnet.dk');assert.equal(url.pathname,'/bff/FindJob/Search');assert.equal(new Headers(init.headers).get('x-csrf'),'1');assert.equal(url.searchParams.get('searchString'),'Developer');assert.equal(url.searchParams.get('pageNumber'),'2');assert.equal(url.searchParams.get('resultsPerPage'),'20');
   return Response.json({jobAds:[{jobAdId:'01234567-89ab-cdef-0123-456789abcdef',title:'Developer',hiringOrgName:'Fixture Co',country:'DK',publicationDate:'2026-10-01',postalDistrictName:'Aarhus'}],searchFacets:{},totalJobAdCount:21});
  }
  if(fixture==='jobnet-suggestions'){assert.equal(url.pathname,'/bff/FindJob/GetTypeaheadSuggestions');assert.equal(url.searchParams.get('query'),'dev');return Response.json(['Developer','DevOps']);}
  if(fixture==='jobdanmark-search'){
   assert.equal(url.origin,'https://jobdanmark.dk');assert.equal(url.pathname,'/api/jobsearch/search/2');assert.equal(init.method,'POST');const body=JSON.parse(init.body);assert.ok(body.filters.some(f=>f.type==='freetext'&&f.value==='Developer'));assert.ok(body.filters.some(f=>f.type==='municipality'&&f.value==='Aarhus'));assert.deepEqual(body.jobTypes,['fuldtid']);
   return Response.json({items:[{title:'Developer',companyName:'Fixture Co',companyAddress:'8000 Aarhus',url:'/job/developer-fixture',publishedDate:'01-10-2026',applicationDeadline:null,jobTypes:['fuldtid']}],currentPage:2,totalItems:31,itemsPrPage:30,totalPages:2});
  }
  if(fixture==='jobbank-search'){
   assert.equal(url.origin,'https://jobbank.dk');assert.equal(url.searchParams.get('key'),'Developer');assert.deepEqual(url.searchParams.getAll('cvtype'),['3','6']);
   if(url.pathname==='/job/')return new Response('<title>101 relevante job og karriereopslag i Akademikernes Jobbank</title>');
   assert.equal(url.pathname,'/job/rss');return new Response('<rss><channel><item><title>Developer</title><description><![CDATA[Fuldtidsjob hos Fixture Co, Aarhus (Ansøgningsfrist: 31.10.2026)]]></description><link>https://jobbank.dk/job/12345/fixture/developer</link><pubDate>Thu, 01 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>');
  }
  if(fixture==='linkedin-search'){
   assert.equal(url.origin,'https://www.linkedin.com');assert.equal(url.pathname,'/jobs-guest/jobs/api/seeMoreJobPostings/search');assert.equal(url.searchParams.get('keywords'),'Developer');assert.equal(url.searchParams.get('location'),'Berlin, Germany');assert.equal(url.searchParams.get('start'),'10');
   return new Response('<li><div data-entity-urn="urn:li:jobPosting:123456"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/123456"></a><h3 class="base-search-card__title">Developer</h3></div></li>');
  }
  assert.equal(url.origin,'https://www.jobindex.dk');
  if(fixture==='jobindex-search'){
   assert.equal(url.pathname,'/jobsoegning');assert.deepEqual(Object.fromEntries(url.searchParams),{q:'C# developer',page:'2',jobage:'7',sort:'date'});
   const card={tid:'h12345',headline:'Developer',company:{name:'Fixture Co'},area:'Aarhus',firstdate:'2026-10-01'};
   return new Response(`<script>var Stash = ${JSON.stringify({jobsearch:{result_app:{storeData:{searchResponse:{hitcount:21,results:[card,{...card,tid:'h67890'}]}}}}})};</script>`);
  }
  assert.equal(fixture,'jobindex-detail');assert.equal(url.href,'https://www.jobindex.dk/jobannonce/h12345');
  return new Response('<html><head><title>Fixture Co - Developer</title><meta property="og:title" content="Developer"></head><body><div class="jd-description"><p>Build accessible tools.</p></div><div class="jd-location"><p>Aarhus</p></div></body></html>');
 }catch(error){console.error('Unexpected CLI request: '+error.message);process.exit(1);}
};
