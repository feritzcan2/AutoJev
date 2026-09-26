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
  const {Store}=await import('../app/store.mjs');const store=new Store(path.join(data,'jobloop.sqlite'));
  try{
    const profile=store.saveProfile({name:linkedin?'LinkedIn · Jev':'Jev demo',preferences:linkedin?JEV_LINKEDIN_GOAL:`Only test the synthetic local job board at ${url}. ${JEV_DEMO_GOAL} Do not browse external job sites or submit applications.`,facts:linkedin?'Communication language: Turkish. The user authorized a real LinkedIn search for Senior Python remote roles. No personal candidate facts or qualifications were supplied. Search only; do not apply or contact employers.':'Synthetic demo candidate. Communication language: Turkish. This is a browser integration demonstration, not a real job search.',authorization:'research',browserMode:'jev',chromeProfile,agentSettings});
    const workspace=path.join(data,'candidates',profile.id);await mkdir(workspace,{recursive:true});
    const cv=path.join(workspace,'CV.txt');await writeFile(cv,linkedin?'Search-only context, not a candidate CV. Requested search: Senior Python, remote. Do not infer candidate qualifications or use this file for applications.':'Synthetic demo candidate. Senior Python engineer; remote work only. No real applications authorized.');store.setCv(profile.id,cv);
    for(const source of store.sources(profile.id))store.saveSource(profile.id,{...source,enabled:false});
    const skillText=linkedin?`The user requests a REAL LinkedIn search, not the local demo. Start at ${url} and use only browser_jev_* tools. Goal: ${JEV_LINKEDIN_GOAL} Let Jev propose actions with browser_jev_next and review/execute them with browser_jev_act. You supply text yourself. Save the source checkpoint. Read visible results and actual link URLs from browser_jev_observe. Only add_job for listings whose title, company and URL you actually observed; do not invent links or claim candidate qualifications. Report each result in Turkish. If LinkedIn requires login, CAPTCHA or blocks access, preserve the tab and report the exact observed blocker through report_activity and report_campaign_work; do not bypass it, switch tools or claim success. Stop after one bounded search and leave the tab open.`:`This is a user-authorized local integration test. Use only browser_jev_* tools on ${url}. Goal: ${JEV_DEMO_GOAL} Call browser_jev_next to let Jev select each action, then review and execute with browser_jev_act. Supply all TYPE_TEXT values yourself. No OpenRouter key or separate text model is needed. Save the actual source checkpoint. Once done, use browser_jev_observe to confirm Python, Remote, Senior and exactly Atlas Labs and Northstar. Report these names and observed results via report_activity and report_campaign_work. These listings are synthetic: do not add them as real job records and do not apply. Leave the tab open.`;
    const source=store.saveSource(profile.id,{name:linkedin?'LinkedIn · Jev araması':'Jev · yerel demo',kind:'custom',url,query:linkedin?JEV_LINKEDIN_GOAL:JEV_DEMO_GOAL,enabled:true,intervalMinutes:1440,applyMode:'find_only',searchMethod:'browser',fallback:'none',skillText});
    return {candidateId:profile.id,sourceId:source.id};
  }finally{store.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const linkedin=process.argv.includes('--linkedin'),fixture=linkedin?{url:'https://www.linkedin.com/jobs/',close:async()=>{}}:await startJevFixture();const data=await mkdtemp(path.join(os.tmpdir(),'jobloop-jev-demo-'));await seedJevDemo(data,fixture.url,{linkedin});
  const require=createRequire(import.meta.url),child=spawn(require('electron'),[root],{cwd:root,env:{...process.env,JOBLOOP_DATA_DIR:data},stdio:'inherit'});
  console.log(`Jobloop Jev demo açılıyor. Agent’ı başlat düğmesine bas.\nÖrnek sayfa: ${fixture.url}\nDemo verileri: ${data}`);
  child.once('error',async error=>{console.error(error.message);await fixture.close();process.exitCode=1;});
  child.once('exit',async code=>{await fixture.close();process.exitCode=code??0;});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill('SIGTERM'));
}
