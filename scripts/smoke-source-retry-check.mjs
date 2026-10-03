import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {BrowserTools} from '../app/browser.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'source-check-'));
let broken=true,requests=0;
const server=createServer((req,res)=>{
 requests++;
 if(req.url==='/retry'&&broken){req.socket.destroy();return;}
 res.setHeader('Content-Type','text/html');res.end('<title>Results</title><h1>Results</h1><p>Current listings</p>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/`;
const browsers=new BrowserTools(directory,()=>({connection:'separate',headless:true}));
try{
 browsers.prepare('workspace');await browsers.connections.pending.get('workspace');assert.equal(browsers.status('workspace').ready,true);
 const page=JSON.parse((await browsers.call('workspace','browser_jev_open',{url},'active-record',{automationWorkspaceId:'workspace',automationTabKey:'record:item'})).content[0].text);
 const connection=await browsers.connect('workspace'),client=connection.client,before=[...client.tabs.keys()];
 const task={id:'retry-task',sourceUrl:url,technicalRecovery:{urls:[url+'retry'],attempt:1}};
 const failed=await browsers.probeAutomationSource('workspace',task);assert.equal(failed.ready,false,JSON.stringify(failed));assert.ok(requests>1);
 assert.deepEqual([...client.tabs.keys()],before,'Disposable failed tab must close without closing the active form');
 assert.equal(client.automationRuns.get(page.tabId),'active-record');
 broken=false;const healthy=await browsers.probeAutomationSource('workspace',task);assert.equal(healthy.ready,true,JSON.stringify(healthy));
 assert.deepEqual([...client.tabs.keys()],before);assert.equal(client.tab(page.tabId).page.url(),url);
 console.log('SOURCE_CHECK_NETWORK_FAILURE_RECOVERY_AND_ACTIVE_TAB_PRESERVED_PASS');
}finally{await browsers.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
