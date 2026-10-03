// Real isolated Chrome and synthetic TypeSafe responses. No external model
// calls or real submissions; exercise all five delegated operations end to end.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationWorkflow} from '../app/automation-worker.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {BrowserTools} from '../app/browser.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'jev-tasks-')),core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);
let submitted=0,modelCalls=0,requests=0,incompleteReads=0;
let delayedResponse,releaseDetail=false;
const delayedText='Berlin apartment: 2 rooms, rent 1500, available immediately.';
const server=createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');requests++;res.setHeader('Content-Type','text/html');
 const shell=body=>`<!doctype html><title>Homes</title><style>body{font:16px sans-serif}label,input,select{display:block;margin:8px}</style>${body}`;
 if(u.pathname==='/delayed-detail'){delayedResponse=res;if(releaseDetail)res.end(delayedText);return;}
 if(u.pathname==='/sent'){submitted++;res.end(shell('Submitted'));return;}
 if(u.pathname==='/marketing'){res.end(shell('<h1>ATS product</h1><a href="/privacy">Privacy Policy</a><a href="/security">Security</a>'));return;}
 if(u.pathname==='/redirect'){res.end(shell('<p>Loading listing</p><script>setTimeout(()=>location.replace("/home/redirected"),10)</script>'));return;}
 if(u.pathname==='/offer-with-delayed-content'){
  res.end(shell('<h1>Offer title only</h1><a href="/home/1">Navigation</a><div id="content"></div><footer>Footer</footer><script>fetch("/delayed-detail").then(r=>r.text()).then(text=>document.querySelector("#content").textContent=text)</script>'));return;
 }
 if(u.pathname==='/form'){res.end(shell(`<form action="/sent"><label>Name<input name="name"></label><label>Message<textarea name="message"></textarea></label><label>Visit<select name="visit"><option value="">Choose</option><option value="morning">Morning</option></select></label><label>City<input id="city" name="city" role="combobox" aria-controls="cities" aria-autocomplete="list"></label><div id="cities" role="listbox" style="display:none"><div role="option" onclick="document.querySelector('#city').value='Berlin';this.parentNode.style.display='none'">Berlin</div></div><button>Send application</button></form><script>document.querySelector('#city').oninput=()=>document.querySelector('#cities').style.display='block';</script>`));return;}
 if(u.pathname.startsWith('/home/')){res.end(shell(`<h1>Berlin home ${u.pathname.slice(-1)}</h1><p>${'Berlin, 2 rooms, rent 1500. '.repeat(300)}</p><a href="/redirect">Another individual home</a>`));return;}
 if(u.pathname==='/results'){
  const p=u.searchParams.get('p')??'1';res.end(shell(`<h1>Berlin homes — page ${p}</h1><a href="/home/${p}">Home ${p}</a><nav aria-label="pagination"><table><tr><td>${p}</td><td><a href="/results?p=3">3</a></td></tr></table>${p==='1'?'<a rel="next" href="/results?q=Berlin&type=flat&p=2">Next</a>':'<button disabled>Next</button><p>End of results</p>'}</nav>`));return;
 }
 if(u.pathname==='/button-results'){
  res.end(shell(`<div style="height:260px;overflow-y:auto"><article style="height:1250px"><a id="role" href="/home/button-1">Home 1</a></article><nav aria-label="pagination"><span id="counter" aria-current="page">1 of 2</span><button onclick="document.querySelector('#counter').textContent='2 of 2';document.querySelector('#role').href='/home/button-2';document.querySelector('#role').textContent='Home 2';this.disabled=true">Next</button></nav></div>`));return;
 }
 if(u.pathname==='/filtered'){
  res.end(shell('<a href="/de">site-logo</a><a href="/filtered?action=facet_selected%3Bage%3Bage_7">Last seven days</a><article><a href="/home/filtered">Compliance home</a><p>Berlin, full remote, 2 days ago</p><p hidden>SECRET HIDDEN CARD TEXT</p><input value="PRIVATE FORM VALUE"></article><nav aria-label="pagination"><button disabled>Previous</button><a href="/filtered">1 of 1</a><button disabled>Next</button></nav>'));return;
 }
 res.end(shell('<form action="/results"><label>Location<input name="q"></label><label>Property type<select name="type"><option value="">Choose</option><option value="flat">Apartment</option></select></label><button>Search</button></form>'));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const a=db.create('housing',{goal:'Berlin homes',criteria:{location:'Berlin',budget:'2000',requirements:'2 rooms'},sources:[base+'/']});db.review(a.id);
const fetchImpl=async(_,args)=>{
 modelCalls++;const {state,questions}=JSON.parse(args.body),answers={};
 for(const [key,q] of Object.entries(questions)){
  let selected;
  if(key.startsWith('answer'))selected=Object.keys(q.criteria).find(k=>q.criteria[k].label===q.instructions.answer.label)??'missing';
  else if(key==='option')selected=Object.keys(q.criteria).find(k=>q.criteria[k].label===state.answer.value)??'missing';
  else if(key==='target')selected=Object.keys(q.criteria).find(k=>q.criteria[k].label==='Search')??'missing';
  else if(key==='ready')selected=state.page.url.includes('/results?q=Berlin&type=flat')?'ready':'uncertain';
  else if(key.startsWith('link'))selected=state.links[key].url.includes('/home/')?'listing':'other';
  else if(key==='next')selected=Object.keys(q.criteria).find(k=>q.criteria[k].rel==='next')??'end';
  else if(key==='fit'){
   selected=state.listing.text.includes('Offer title only')&&!state.listing.text.includes('Berlin apartment:')?'incomplete':new URL(state.listing.url).pathname==='/results'?'results':'possible';
   if(selected==='incomplete'){incompleteReads++;releaseDetail=true;delayedResponse?.end(delayedText);}
  }
  else throw Error('Unexpected question '+key);
  answers[key]={choice:selected,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===selected?1:0]))};
 }
 return {ok:true,json:async()=>({answers,usage:{input_tokens:100,output_tokens:20}})};
};
const browsers=new BrowserTools(directory,()=>({connection:'separate',headless:true,config:async()=>({apiKey:'synthetic',fetchImpl})}));
const run=db.begin(a.id,'trial'),adapter=automationBrowser(browsers),controller=new AbortController();
let flow=automationWorkflow({db,run,signal:controller.signal,browser:adapter,report:()=>{}}),toolCalls=0;
const call=async(name,args={})=>{toolCalls++;return flow.call(a.id,run.id,name,args);};
const complete=async input=>{let result=await call('browser_jev_run',input);for(let i=0;i<10&&result.status==='continue';i++)result=await call('browser_jev_run',{taskId:result.taskId});assert.equal(result.status,'completed',JSON.stringify(result));return result;};
try{
 const search=await complete({operation:'prepare_search',url:base+'/',goal:'Search for Berlin apartments',answers:[{key:'location',label:'Location',value:'Berlin'},{key:'type',label:'Property type',value:'Apartment'}]});assert.match(search.currentUrl,/q=Berlin&type=flat/);
 const scan=await complete({operation:'scan_results',goal:'Find individual apartment listings'});assert.equal(scan.total,2);
 assert.equal(scan.lastPage.position.currentPage,2);assert.equal(scan.pageCount,2);assert.equal(scan.confirmedListings,2);
 const detail=await complete({operation:'collect_details',fromTaskId:scan.taskId});assert.equal(detail.usage.calls,2);assert.equal(detail.items.length,2);
 const triage=await complete({operation:'classify_results',fromTaskId:detail.taskId});assert.ok(triage.items.every(i=>i.assessment.decision==='possible'));
 const buttons=await complete({operation:'scan_results',url:base+'/button-results'});assert.equal(buttons.total,2);assert.equal(buttons.pageCount,2);assert.equal(buttons.lastPage.position.currentPage,2);
 const evidence=await call('read_jev_evidence',{evidenceId:detail.items[0].evidenceId});assert.equal(evidence.nextOffset,6000);assert.match(evidence.text,/rent 1500/);
 const direct=await complete({operation:'collect_details',urls:[base+'/home/1',base+'/home/2']});assert.equal(direct.total,2);
 const inferred=await complete({operation:'classify_results'});assert.equal(inferred.items[0].evidenceId,direct.items[0].evidenceId);
 assert.equal(inferred.usage.calls,0,'already assessed evidence is reused');
 await call('browser_open',{url:base+'/offer-with-delayed-content'});
 const delayed=await complete({operation:'collect_details',url:base+'/offer-with-delayed-content'});
 assert.equal(delayed.classified,1);assert.equal(incompleteReads,1,'an unchanged shell is not sent back to the model');
 assert.match((await call('read_jev_evidence',{evidenceId:delayed.items[0].evidenceId})).text,/Berlin apartment: 2 rooms/);
 const board=await call('browser_jev_run',{operation:'collect_details',url:scan.currentUrl});assert.equal(board.status,'needs_agent');assert.equal(board.resultsPages,1);assert.equal(board.classified,0);assert.equal(board.issue.reason,'discovery_required');
 const redirected=await complete({operation:'collect_details',url:base+'/redirect'});assert.equal(redirected.classified,1);
 assert.match((await call('read_jev_evidence',{evidenceId:redirected.items[0].evidenceId})).url,/\/home\/redirected/);
 const filtered=await complete({operation:'scan_results',url:base+'/filtered'});assert.equal(filtered.total,1);assert.equal(filtered.items,undefined);assert.equal((await call('read_jev_task',{taskId:filtered.taskId})).items[0].url,base+'/home/filtered');
 assert.deepEqual(filtered.lastPage.position,{currentPage:1,totalPages:1,evidence:'1 of 1'});
 const original=db.jevTasks.fullEvidence(a.id,run.taskId??run.id,filtered.lastPage.evidenceId),link=original.links.find(l=>l.url===base+'/home/filtered');
 assert.ok(link.contextRange);const card=original.text.slice(link.contextRange.offset,link.contextRange.offset+link.contextRange.length);
 assert.match(card,/Berlin, full remote, 2 days ago/);assert.doesNotMatch(card,/SECRET HIDDEN|PRIVATE FORM|Last seven days|1 of 1/);
 const beforeRead=requests;await call('read_jev_task',{taskId:filtered.taskId,pageOffset:0});assert.equal(requests,beforeRead);
 const marketing=await call('browser_jev_run',{operation:'scan_results',url:base+'/marketing'});assert.equal(marketing.status,'needs_agent');assert.equal(marketing.issue.reason,'no_listing_links');assert.equal(marketing.total,0);
 const wrongOperation=await call('browser_jev_run',{operation:'prepare_search',url:base+'/home/1',goal:'Read this listing'});assert.equal(wrongOperation.status,'needs_agent');assert.match(wrongOperation.next,/collect_details/);
 const form=await complete({operation:'fill_form',url:base+'/form',answers:[{key:'name',label:'Name',value:'Ada'},{key:'message',label:'Message',value:'Synthetic draft'},{key:'visit',label:'Visit',value:'Morning'},{key:'city',label:'City',value:'Berlin'}]});assert.equal(Object.keys(form.answers).length,4);assert.equal(submitted,0);
 // Reconstruct the workflow as on a worker restart: evidence and task IDs
 // remain readable without reopening pages or repeating model calls.
 flow=automationWorkflow({db,run,signal:controller.signal,browser:automationBrowser(browsers),report:()=>{}});
 const before=modelCalls,restored=await call('read_jev_task',{taskId:scan.taskId});assert.equal(restored.total,2);assert.equal(modelCalls,before);
 console.log('JEV_TASKS_PASS',JSON.stringify({operations:5,toolCalls,modelCalls,requests,submissions:submitted}));
}finally{await browsers.close();core.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
