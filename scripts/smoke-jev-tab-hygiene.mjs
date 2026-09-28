import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {JevBrowser} from '../app/jev-browser.mjs';
const dir=await mkdtemp(path.join(os.tmpdir(),'jev-hygiene-'));
const client=new JevBrowser(dir,{connection:'separate',headless:true});
try{
 const context=await client.context();
 const make=async html=>{const page=await context.newPage();await page.setContent(html);const slot=await client.track(context,page);slot.owner="test";await client.observe(slot);return slot;};
 const listing=await make('<h1>Listing</h1>'),form=await make('<input value="Saved draft">'),personal=await make('<p>User tab</p>'),other=await make('<input value="Other draft">');
 form.openerId=listing.id;client.tabJobs.set(listing.id,'job');client.tabJobs.set(form.id,'job');client.tabJobs.set(other.id,'other');
 const job={id:'job',status:'blocked',resumeContext:{browser:'Jev Chrome',tabId:form.id,url:form.page.url()}};
 const cleaned=await client.cleanupCompleted({jobs:[job]});assert.ok(cleaned.closed.includes(listing.id));assert.equal(form.page.isClosed(),false);assert.equal(personal.page.isClosed(),false);assert.equal(other.page.isClosed(),false);
 const draft=await make('<input value="Unsent text">');form.openerId=draft.id;client.tabJobs.set(draft.id,'job');
 await client.cleanupCompleted({jobs:[job]});assert.equal(draft.page.isClosed(),false);
 const shared=await make('<p>Shared source</p>');form.openerId=shared.id;client.tabJobs.set(shared.id,'job');
 await client.cleanupCompleted({jobs:[job],sourceTabIds:[shared.id]});assert.equal(shared.page.isClosed(),false);
 const uncertain=await make('<p>Uncertain opener</p>');form.openerId=uncertain.id;client.tabJobs.set(uncertain.id,'job');job.status='uncertain';
 await client.cleanupCompleted({jobs:[job]});assert.equal(uncertain.page.isClosed(),false);
 const rank=await make('<h1>Ranked listing</h1>');client.tabSearches.set(rank.id,'rank-task');
 const rankClean=await client.cleanupSearch('rank-task',{jobs:[job]});assert.ok(rankClean.closed.includes(rank.id));assert.equal(form.page.isClosed(),false);
 await form.page.close();assert.equal(client.tabs.has(form.id),false);assert.equal(client.tabJobs.has(form.id),false);
 console.log('TAB_HYGIENE_LISTING_RANK_DRAFT_USER_UNCERTAIN_MANUAL_CLOSE_PASS');
}finally{await client.close();await rm(dir,{recursive:true,force:true});}
