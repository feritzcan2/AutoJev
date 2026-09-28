// Isolated Chrome, no live candidate tabs or model calls.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev-browser.mjs';
import {readRankText} from '../app/jev-rank-observation.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-rank-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true,config:async()=>({}),choose:async()=>{throw Error('Unexpected model call');}});
try{
 const context=await client.context(),page=await context.newPage(),slot=await client.track(context,page),tabId=slot.id;
 await page.setContent(`<h1>Backend engineer</h1><p>Berlin hybrid</p><div style="height:1800px"></div><h2>Requirements</h2><p>Five years C# and SQL</p><p hidden>HIDDEN_NOT_EVIDENCE</p><iframe srcdoc="<p>Embedded salary EUR 80000</p>"></iframe><iframe hidden srcdoc="<p>HIDDEN_FRAME</p>"></iframe><form>${Array.from({length:50},(_,i)=>`<label>Answer ${i}<input value="private-${i}"></label>`).join('')}<button>Submit application</button></form>`);
 const call=async(kind='rank',args={tabId})=>JSON.parse((await client.callTool({name:'browser_jev_observe',arguments:args},'test',{taskKind:kind})).content[0].text);
 const rank=await call();
 assert.equal(rank.observationMode,'rank');assert.match(rank.text,/Five years C# and SQL/);assert.match(rank.text,/Embedded salary EUR 80000/);
 assert.doesNotMatch(rank.text,/HIDDEN_NOT_EVIDENCE|HIDDEN_FRAME|private-0/);
 assert.deepEqual(rank.fillFields,[]);assert.equal(rank.elements,undefined);assert.ok(!rank.clickTargets.some(t=>t.label==='Submit application'));
 assert.equal(await page.evaluate(()=>scrollY),0);
 const repeat=await call();assert.equal(repeat.text,undefined);assert.equal(repeat.textUnchanged,true);
 const restored=await call('rank',{tabId,full:true,fullReason:'context_loss'});assert.match(restored.text,/Five years/);
 await page.locator('h2').evaluate(e=>e.insertAdjacentHTML('afterend','<p>New requirement Rust</p>'));
 const changed=await call();assert.match(changed.text,/New requirement Rust/);
 const limited=await readRankText(page,40);assert.equal(limited.truncated,true);
 await page.locator('form').scrollIntoViewIfNeeded();
 const app=await call('application',{tabId,full:true,fullReason:'context_loss'});assert.ok(app.fillFields.length>0);assert.ok(app.clickTargets.some(t=>t.label==='Submit application'));
 const rankBytes=Buffer.byteLength(JSON.stringify(rank)),applicationBytes=Buffer.byteLength(JSON.stringify(app));
 assert.ok(rankBytes<applicationBytes*.6,`${rankBytes}/${applicationBytes}`);
 console.log(JSON.stringify({result:'RANK_DOCUMENT_PASS',rankBytes,applicationBytes,repeatBytes:Buffer.byteLength(JSON.stringify(repeat))}));
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
