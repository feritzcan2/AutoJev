import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BrowserTools} from '../app/browser.mjs';
import {automationBrowser} from '../app/automation-browser.mjs';

const directory=await mkdtemp(path.join(os.tmpdir(),'source-navigation-error-'));
const server=createServer((req,res)=>{
 if(req.url==='/broken'){req.socket.destroy();return;}
 res.setHeader('Content-Type','text/html');res.end('<h1>Results page</h1><a href="/broken">Next page</a>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/`,broken=url+'broken';
const browsers=new BrowserTools(directory,()=>({connection:'separate',headless:true}));
const adapter=automationBrowser(browsers,{mode:'jev',readTabKey:'source:'+url,sourceUrl:url});
try{
 const first=await adapter.call('workspace','browser_navigate',{url},'run');
 const client=(await browsers.connect('workspace')).client,context=await client.context(),count=context.pages().length;
 for(let i=0;i<3;i++)await assert.rejects(adapter.call('workspace','browser_navigate',{url:broken},'run'),/net::ERR_EMPTY_RESPONSE/);
 assert.equal(context.pages().length,count,'Transport retries reuse the owned source tab');
 // Let Chrome commit the failed navigation, as it does between agent turns.
 await new Promise(r=>setTimeout(r,250));
 let restored;
 for(let attempt=0;attempt<3&&!restored;attempt++){
  try{restored=await adapter.call('workspace','browser_navigate',{url},'run');}
  catch(error){assert.match(error.message,/interrupted by another navigation|Execution context was destroyed/);await new Promise(r=>setTimeout(r,250));}
 }
 assert.ok(restored,'The healthy source can be read again');
 assert.equal(restored.pageContext.tabId,first.pageContext.tabId);assert.equal(restored.pageContext.url,url);
 console.log('SOURCE_NAVIGATION_ERROR_PRESERVED_AND_TAB_REUSED_PASS');
}finally{await browsers.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
