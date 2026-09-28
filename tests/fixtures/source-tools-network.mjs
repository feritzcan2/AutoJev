import assert from 'node:assert/strict';

// Loaded only by scripts/smoke-source-tools.mjs, before the actual CLI bundle.
// Every request is intercepted; an unexpected URL fails the child process.
globalThis.fetch=async(input)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 try{
  assert.equal(url.origin,'https://www.jobindex.dk');
  if(process.env.JOBLOOP_SOURCE_FIXTURE==='jobindex-search'){
   assert.equal(url.pathname,'/jobsoegning');
   assert.deepEqual(Object.fromEntries(url.searchParams),{q:'C# developer',page:'2',jobage:'7',sort:'date'});
   const job={tid:'h12345',headline:'C# developer',company:{name:'Fixture Co'},area:'Aarhus',firstdate:'2026-09-28',apply_deadline:'2026-10-13'};
   const stash={jobsearch:{result_app:{storeData:{searchResponse:{hitcount:2,results:[job,{...job,tid:'h67890'}]}}}}};
   return new Response(`<html><script>var Stash = ${JSON.stringify(stash)};</script></html>`,{headers:{'Content-Type':'text/html'}});
  }
  assert.equal(process.env.JOBLOOP_SOURCE_FIXTURE,'jobindex-detail');
  assert.equal(url.href,'https://www.jobindex.dk/jobannonce/h12345');
  return new Response(`<!doctype html><html><head>
   <title>Fixture Co - C# developer</title><meta property="og:title" content="C# developer">
   </head><body><div class="jd-description"><p>Build accessible tools.</p></div>
   <div class="jd-location"><p>Aarhus</p></div><div class="jd-deadline"><p>13. oktober 2026</p></div>
   </body></html>`,{headers:{'Content-Type':'text/html'}});
 }catch(error){
  console.error(`Source-tool fixture rejected a request: ${error.message}`);
  process.exit(1);
 }
};
