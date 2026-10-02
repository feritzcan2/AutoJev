// Opt-in model check using synthetic profiles and listings. No browser, real
// candidate data, application submission or persistent page cache is involved.
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {runJevTask} from '../app/jev-tasks.mjs';
import {jevCriteria} from '../app/jev-triage.mjs';
import {askJev,jevConfig} from '../app/jev-policy.mjs';

if(!process.argv.includes('--live'))throw Error('Use --live to run the synthetic cases against the configured Jev model.');
const config=await jevConfig();
if(!config.apiKey)throw Error('Jev is not configured.');
const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core);
const profile={templateId:'job-search',goal:'Compliance, privacy and AI governance jobs',criteria:{preferences:'Almanya genelinde yalnız tam uzaktan veya Berlin ofis. Hibrit kesinlikle olmaz. AI rolleri öncelikli; CV uyumlu diğer roller değerlendirilebilir.',constraints:'Maaş hedefi 65-90k EUR; maaş belirtilmemesi eleme nedeni değil.'},instructions:'Yalnız tam uzaktan Almanya veya Berlin ofis; hibrit ve diğer meslek alanlarını ele.',facts:'German B2; English C1; four years of healthcare compliance and legal operations.'};
const criteria=jevCriteria(profile,{text:'LL.B. Four years of compliance, GDPR, audit support and regulatory legal operations. MBA focusing on AI governance. German B2, English C1.'});
const cases=[
 {id:'hybrid',text:'Privacy Compliance Specialist. Berlin. Location Type: Hybrid, mandatory two days per week in the Berlin office. GDPR and compliance operations. English C1.',expected:'mismatch',reason:'hard_constraint'},
 {id:'language',text:'Privacy Specialist. Fully remote anywhere in Germany. Mandatory German C1 or C2; no lower level accepted. GDPR and privacy operations. English C1.',expected:'mismatch',reason:'qualification'},
 {id:'sales',text:'Account Executive at an AI Compliance SaaS company. Fully remote Germany. Own enterprise sales pipeline, cold outreach, product demos and close sales. B2B SaaS quota-carrying sales role; no legal or compliance advisory duties.',expected:'mismatch',reason:'unrelated_role'},
 {id:'engineering',text:'AI Security Engineer. Berlin office. Build Python security tooling, cloud infrastructure and penetration testing systems. Five years software security engineering required. This is not a compliance or governance job.',expected:'mismatch',reason:'unrelated_role'},
 {id:'fit',text:'Compliance Specialist, AI Governance. Fully remote anywhere in Germany. Three years compliance or legal operations, GDPR and audit support. German B2 and English C1 accepted. No salary published.',expected:'possible'},
 {id:'remote-exception',text:'Regulatory Compliance Analyst. Headquarters Munich; this role is fully remote throughout Germany with no office attendance. Three years of legal/regulatory work; German B2 and English C1 accepted. AI experience preferred, not mandatory.',expected:'possible'},
 {id:'missing-qualification',text:'Privacy Specialist. Berlin on-site office. Three years compliance or legal experience. Privacy certification is preferred, not mandatory. English C1 required; no German requirement. Salary not published.',expected:'possible'},
 {id:'profile',text:'My account profile. Edit your contact details and resume. Saved jobs. Notification preferences. This page contains no job opportunity.',expected:'mismatch',reason:'not_listing'},
 {id:'uncertain',text:'Compliance Officer. Germany. Compliance and GDPR responsibilities. Work mode and required language levels have not been published.',expected:'uncertain'},
 {id:'multiple-conflicts',text:'Senior SaaS Account Executive. Munich, hybrid with three mandatory days per week in the office; no full remote option. Mandatory German C2. Own sales quota, cold outreach and customer demos. No compliance advisory duties.',expected:'mismatch'},
 {id:'visible-frame-conflict',text:'Privacy Compliance Specialist. Berlin. Mandatory hybrid, three days per week in the office. Remote employment is not available. German C1 required; no lower level accepted.',unreadFrames:1,expected:'mismatch'},
 {id:'allowed-alternative',text:'Compliance Analyst. Munich office or fully remote anywhere in Germany, employee choice. German C1 preferred, but German B2 is accepted with fluent English. Three years compliance or legal operations required.',expected:'possible'}
];
const failures=[];let calls=0,inputTokens=0;
try{
 for(const item of cases){
  const a=db.create('job-search',{goal:profile.goal,criteria:profile.criteria,sources:['https://synthetic.example/']});
  const result=await runJevTask({store:db.jevTasks,owner:a.id,taskId:item.id,input:{operation:'collect_details'},criteria,signal:AbortSignal.timeout(45000),ports:{
   searchId:'default',authorize:async()=>{},assertActive:()=>{},resolveDetails:()=>[{url:'https://synthetic.example/'+item.id}],
   browser:async()=>({url:'https://synthetic.example/'+item.id,title:item.id,text:item.text,reading:{unreadFrames:item.unreadFrames??0}}),
   evaluate:(state,questions,signal)=>askJev(state,questions,{...config,signal})
  }});
  const assessment=result.items[0]?.assessment;
  const pass=assessment?.decision===item.expected&&(!item.reason||assessment.reason===item.reason);
  if(!pass)failures.push(item.id);
  calls+=result.usage.calls;inputTokens+=result.usage.input_tokens;
  console.log(JSON.stringify({case:item.id,pass,assessment,issue:result.issue}));
 }
 console.log(JSON.stringify({cases:cases.length,calls,inputTokens,failures}));
 const cards=[
  {id:'surgeon',text:'Surgeon - AI Trainer - freelance - requires clinical surgery experience',keep:false},
  {id:'sales-card',text:'Account Executive - enterprise SaaS sales, cold outreach and closing deals',keep:false},
  {id:'hybrid-card',text:'Privacy Officer - Berlin hybrid, mandatory office attendance twice weekly',keep:false},
  {id:'legal-card',text:'Legal Operations Specialist - Berlin office, GDPR and regulatory support',keep:true},
  {id:'adjacent-card',text:'AI Policy Associate - research and regulatory policy support',keep:true},
  {id:'unknown-card',text:'Compliance Officer - details available on listing page',keep:true}
 ];
 const board='https://synthetic.example/board',a=db.create('job-search',{goal:profile.goal,criteria:profile.criteria,sources:[board]});
 let checkpoint;
 const discovery=await runJevTask({store:db.jevTasks,owner:a.id,taskId:'discovery',input:{operation:'scan_results',url:board},criteria,signal:AbortSignal.timeout(60000),ports:{
  searchId:'default',authorize:async()=>{},assertActive:()=>{},
  browser:async()=>({url:board,title:'Open roles — page 1 of 1',text:'End of results. All 6 roles shown.',links:cards.map(c=>({url:'https://synthetic.example/'+c.id,text:c.text})),pagination:[{text:'1 of 1',current:true}]}),
  checkpoint:async(_page,urls,info)=>{checkpoint={urls,...info};return {saved:true};},
  evaluate:(state,questions,signal)=>askJev(state,questions,{...config,signal})
 }});
 for(const card of cards){
  const kept=discovery.items.some(i=>i.url==='https://synthetic.example/'+card.id),pass=kept===card.keep;
  if(!pass)failures.push(card.id);console.log(JSON.stringify({case:card.id,pass,kept}));
 }
 console.log(JSON.stringify({discoveryCalls:discovery.usage.calls,rejected:checkpoint?.rejectedUrls?.length,issue:discovery.issue,failures}));
 assert.deepEqual(failures,[],'Unexpected Jev decisions');
}finally{core.close();}
