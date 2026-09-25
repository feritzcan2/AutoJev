import {createServer} from 'node:http';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {BrowserTools} from '../app/browser.mjs';
const fixture=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(req.url.startsWith('/done')?'<h1>Application received - local test only</h1>':'<h1>Local test vacancy</h1><form action="/done"><label>Name<input name="name" required></label><button>Apply</button></form>');});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const browser=new BrowserTools(await mkdtemp(path.join(os.tmpdir(),'jobloop-browser-test-')),()=> 'separate');
const content=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');};
try{
 const tools=await browser.tools('test');assert.ok(tools.some(t=>t.name==='browser_navigate'));
 const snapshot=content(await browser.call('test','browser_navigate',{url:`http://127.0.0.1:${fixture.address().port}`}));
 const input=/textbox "Name" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];assert.ok(input,snapshot);
 const button=/button "Apply" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];assert.ok(button,snapshot);
 content(await browser.call('test','browser_type',{target:input,text:'Synthetic test candidate'}));
 const confirmation=content(await browser.call('test','browser_click',{target:button}));
 assert.match(confirmation,/Application received - local test only/);console.log('BROWSER_FORM_PASS');
}finally{await browser.close();fixture.closeAllConnections();await new Promise(r=>fixture.close(r));}
