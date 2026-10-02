import {createServer} from 'node:http';
import {readFile,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root=fileURLToPath(new URL('../',import.meta.url));
export const JEV_DEMO_GOAL='Search for Python jobs. Set Location to Remote and Seniority to Senior, then click Search jobs. Stop when matching results are visible.';
export const JEV_LINKEDIN_GOAL='Search LinkedIn for Senior Python jobs and apply the Remote work filter. Keep the search broad geographically where the interface permits. Inspect up to three actual current listings and report their titles, companies, locations and observed LinkedIn URLs. Do not apply or message anyone.';

export async function startJevFixture({port=0}={}){
  const files={'/jobs':['jobs.html','text/html; charset=utf-8'],'/jobs.js':['jobs.js','text/javascript; charset=utf-8']};
  const server=createServer(async(req,res)=>{
    if(req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(403);res.end();return;}
    const file=files[req.url];if(req.method!=='GET'||!file){res.writeHead(404);res.end();return;}
    try{const body=await readFile(path.join(root,'demos/jev',file[0]));res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store'});res.end(body);}catch{res.writeHead(500);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}/jobs`,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

export async function seedJevDemo(data,url,{linkedin=false,chromeProfile,agentSettings}={}){
  const {WorkspaceDatabase}=await import('../app/workspace-database.mjs'),{AutomationStore}=await import('../app/automation-store.mjs');
  const core=new WorkspaceDatabase(path.join(data,'jobloop.sqlite'));
  try{
    const db=new AutomationStore(core),goal=linkedin?JEV_LINKEDIN_GOAL:JEV_DEMO_GOAL;
    const a=db.create('custom',{title:linkedin?'LinkedIn · Jev':'Jev demo',goal,criteria:{outcome:goal,rules:'Search only. Do not apply or contact employers.',completion:'Stop after the matching results are visible.'},sources:[url],browserMode:'jev',chromeProfile,agentSettings,
      facts:linkedin?'No candidate qualifications supplied.':'Synthetic local browser integration demo.',
      instructions:'Use the managed Jev browser. Inspect actual results and observed links, preserve access blockers and report the observed outcome through finish_automation_run.'});
    db.save(a.id,{browserMode:'jev',chromeProfile});
    db.saveSource(a.id,url,{name:linkedin?'LinkedIn · Jev araması':'Jev · yerel demo',enabled:true,intervalMinutes:1440,mode:'observe',query:goal});db.review(a.id);
    return {candidateId:a.id,sourceId:url};
  }finally{core.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const linkedin=process.argv.includes('--linkedin'),fixture=linkedin?{url:'https://www.linkedin.com/jobs/',close:async()=>{}}:await startJevFixture();const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-jev-demo-'));await seedJevDemo(data,fixture.url,{linkedin});
  const require=createRequire(import.meta.url),child=spawn(require('electron'),[root],{cwd:root,env:{...process.env,JOBLOOP_DATA_DIR:data},stdio:'inherit'});
  console.log(`Jobloop Jev demo açılıyor. Agent’ı başlat düğmesine bas.\nÖrnek sayfa: ${fixture.url}\nDemo verileri: ${data}`);
  child.once('error',async error=>{console.error(error.message);await fixture.close();process.exitCode=1;});
  child.once('exit',async code=>{await fixture.close();process.exitCode=code??0;});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill('SIGTERM'));
}
