import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';
import {documentToolContent} from '../app/automation-tool-output.mjs';

const directory=await mkdtemp(path.join(tmpdir(),'loop-document-context-'));
let submissions=0;
const server=createServer((req,res)=>{
 if(req.url==='/sent')submissions++;
 res.setHeader('Content-Type','text/html; charset=utf-8');
 if(req.url==='/late'){
  res.end('<!doctype html><title>Late description</title><main aria-busy="true">Header only</main><script>setTimeout(()=>{const main=document.querySelector("main");main.innerHTML="<h1>Loaded role</h1><p>LATE_REQUIRED_QUALIFICATION: Four years of compliance experience.</p>";main.setAttribute("aria-busy","false");},900)</script>');return;
 }
 res.end('<!doctype html><title>Exact document context</title><h1>Senior Engineer</h1><p>Salary €100,000</p><p>Consent: No</p><button>Inspect role</button><div style="height:1600px">Full role description remains available.</div><p>BELOW_FOLD_REQUIREMENT: German B2</p><a href="/detail">Exact detail link</a><div hidden>HIDDEN_MUST_NOT_APPEAR</div>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`;
const browser=new BrowserTools(directory,()=> 'jev',()=>({connection:'separate',headless:true,choose:()=>{throw Error('This test must not call a model');}}));
const adapter=automationBrowser(browser,{mode:'jev'});
try{
 const response=await adapter.call('context-smoke','browser_navigate',{url},'context-smoke');
 const page=JSON.parse(response.content[0].text.replace(/^Page URL: [^\n]+\n/,''));
 assert.equal(page.observationMode,'document');assert.equal(page.reading.truncated,false);
 assert.match(page.text,/Salary €100,000/);assert.match(page.text,/Consent: No/);assert.match(page.text,/BELOW_FOLD_REQUIREMENT: German B2/);
 assert.ok(!page.text.includes('HIDDEN_MUST_NOT_APPEAR'));assert.ok(page.links.some(link=>link.url===url+'detail'));
 assert.equal(page.viewportText,'');assert.equal(page.elements,undefined);assert.equal(page.controlMaps,'replace');
 assert.ok(page.clickTargets.some(target=>target.label==='Inspect role'&&target.targetId));
 const projected=JSON.parse(documentToolContent(response.content)[0].text.replace(/^Page URL: [^\n]+\n/,''));
 assert.equal(projected.links,undefined);assert.equal(projected.linksInText,true);
 assert.equal(projected.text,page.text);assert.match(projected.text,new RegExp(url+'detail'));
 assert.deepEqual(projected.clickTargets,page.clickTargets);assert.deepEqual(projected.fillFields,page.fillFields);
 const fresh=await adapter.call('context-smoke','browser_snapshot',{},'context-smoke');
 const next=JSON.parse(fresh.content[0].text.replace(/^Page URL: [^\n]+\n/,''));
 assert.equal(next.text,page.text);assert.notEqual(next.observationId,page.observationId);assert.ok(next.clickTargets.length);assert.equal(submissions,0);
 const late=await adapter.call('context-smoke','browser_navigate',{url:url+'late'},'context-smoke');
 assert.equal(late.jevPage.reading.readiness.loading,false);assert.match(late.jevPage.text,/LATE_REQUIRED_QUALIFICATION/);
 console.log('DOCUMENT_CONTEXT_PASS',JSON.stringify({exactDocument:true,currentTargets:true,duplicateViewportRemoved:true,duplicateLinkIndexRemoved:true,submissions}));
}finally{
 await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
