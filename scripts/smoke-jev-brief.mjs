// Synthetic listings only. Raw text and briefs are held in an in-memory store.
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {askJev,jevConfig} from '../app/jev-policy.mjs';
import {readJevBrief} from '../app/jev-brief.mjs';
import {FIT_INSTRUCTIONS,jevCriteria} from '../app/jev-triage.mjs';

if(!process.argv.includes('--live'))throw Error('Pass --live for synthetic Jev API checks.');
const config=await jevConfig();if(!config.apiKey)throw Error('Jev is not configured.');
const core=new WorkspaceDatabase(':memory:'),db=new AutomationStore(core),owner=db.create('job-search',{goal:'AI governance and compliance work',criteria:{preferences:'Only fully remote in Germany or on-site Berlin. No hybrid.',ranking:'Assess relevant experience, mandatory qualifications and location.'},facts:'Four years compliance, GDPR and audits. German B2; English C1.'});
const criteria=jevCriteria(owner,{text:'Compliance officer with GDPR and audit experience. No stated SAP experience.'});
const boilerplate=Array.from({length:10},(_,n)=>`Website navigation section ${n}: Cookie preferences, login, save search, accessibility and newsletter settings. Our platform helps millions of people explore their future. Manage analytics settings and promotional email preferences. Browse our general editorial articles and company directory.\n`).join('\n');
const cases=[
 {id:'sap',title:'Senior SAP HCM Consultant',facts:['SAP HCM expertise is mandatory.','Homeoffice möglich; office attendance arrangements are not specified.','Salary 90,000–120,000 EUR is a job-board estimate, not an employer offer.'],duties:'Implement and customize SAP HCM and ILM systems for enterprise clients. This is technical SAP consulting, with data protection responsibilities.'},
 {id:'remote-exception',title:'Compliance Analyst',facts:['Headquarters Munich; this role is fully remote anywhere in Germany with no office attendance.','German B2 and English C1 are accepted.','Three years compliance or legal experience required.'],duties:'Perform GDPR compliance reviews and AI governance policy work. Privacy certification is preferred, not mandatory.'},
 {id:'hybrid',title:'Privacy Compliance Specialist',facts:['Berlin hybrid; three mandatory office days per week.','German C1 is required; no lower language level is accepted.'],duties:'Manage GDPR processes and internal policy audits.'},
 {id:'unknowns',title:'AI Governance Associate',facts:['Location: Germany. Work mode and salary are not published.','German C1 is preferred; B2 is accepted with English C1.'],duties:'Support AI policy research, governance and compliance documentation.'}
];
try{
 for(const c of cases){
  const task=db.jevTasks.create(owner.id,c.id,{operation:'collect_details'}),text=c.title+'\n\n'+c.duties+'\n\n'+boilerplate+'\nCurrent listing requirements and conditions:\n'+c.facts.join('\n')+'\n\n'+boilerplate;
  const e=db.jevTasks.evidence(task,{url:'https://synthetic.example/'+c.id,title:c.title,text}),signal=AbortSignal.timeout(120000),evaluate=(state,questions,signal)=>askJev(state,questions,{...config,signal});
  const options={store:db.jevTasks,owner:owner.id,taskId:c.id,evidenceId:e.id,criteria,evaluate,signal};
  let result;do{result=await readJevBrief(options);}while(result.status==='running');
  assert.equal(result.status,'ready',c.id+' '+JSON.stringify(result));let selected=result.sections.map(s=>s.text).join('\n');
  while(result.nextOffset!==null){result=await readJevBrief({...options,offset:result.nextOffset});selected+='\n'+result.sections.map(s=>s.text).join('\n');}
  const missing=c.facts.filter(f=>!selected.includes(f));
  const questions={fit:{type:'choice',instructions:FIT_INSTRUCTIONS,criteria:{possible:'Potentially relevant listing.',mismatch:'Explicit hard conflict, known qualification conflict or clearly unrelated work.',uncertain:'Missing or conflicting information.',results:'Multiple separate listings.'}}};
  const full=await evaluate({criteria,listing:{title:c.title,text}},questions,signal),brief=await evaluate({criteria,listing:{title:c.title,text:selected}},questions,signal);
  console.log(JSON.stringify({case:c.id,sourceCharacters:text.length,briefCharacters:selected.length,reduction:Math.round((1-selected.length/text.length)*100),missing,fullDecision:full.answers.fit.choice,briefDecision:brief.answers.fit.choice}));
  assert.deepEqual(missing,[],c.id+' lost an essential fact');assert.ok(selected.length<text.length*.75,c.id+' did not reduce context');
  assert.equal(brief.answers.fit.choice,full.answers.fit.choice,c.id+' fit changed after selection');
 }
}finally{core.close();}
