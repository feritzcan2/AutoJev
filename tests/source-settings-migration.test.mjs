import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {automationTools} from '../app/automation-worker.mjs';
import {sourceScanScope} from '../app/source-scan.mjs';

test('opening old data removes source extensions and resumes the saved browser queue',t=>{
 const directory=mkdtempSync(path.join(tmpdir(),'source-settings-upgrade-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const file=path.join(directory,'state.sqlite'),url='https://homes.test/list',detail=url+'/remaining';
 let core=new WorkspaceDatabase(file),db=new AutomationStore(core);
 t.after(()=>core.close());
 const a=db.create('housing',{goal:'Find homes',criteria:{location:'Berlin',budget:'2000',requirements:'Two rooms'},sources:[url]});
 const settings={name:'Homes',query:'Two rooms in Berlin',enabled:true,intervalMinutes:45,mode:'observe'};
 db.saveSource(a.id,url,settings);db.review(a.id);db.skipTrial(a.id);db.enable(a.id);
 const task=core.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:url,sources:[url],lockKey:'source:'+url});
 const run=db.begin(a.id,{kind:'run',taskId:task.id});
 db.observe(a.id,run.id,url,'Results page',[detail]);
 db.saveScanProgress(a.id,run.id,{pendingUrls:[detail],reason:'Read the remaining home',cursor:'page=2'},{url,text:'Results page'});
 db.finish(a.id,run.id,'interrupted','App closed');
 const saved=db.get(a.id),scope=sourceScanScope(saved,url),plan=db.run(run.id).scanPlan;
 const obsolete={searchMethod:'tool',integrationId:'linkedin',fallback:'none',customTool:{command:'/removed/tool',args:[]},skillText:'Old source instruction',guideOverrides:{pagination:'Old method'},guideBaseVersion:1};
 // Reproduce the pre-removal scope fingerprint without changing the search criteria.
 const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
 const oldScope=createHash('sha256').update(JSON.stringify(stable({sourceInstructions:obsolete.skillText,guideOverrides:obsolete.guideOverrides,url,query:settings.query,goal:saved.goal,criteria:saved.criteria,instructions:saved.instructions,facts:saved.facts,workflow:saved.workflow,templateId:saved.templateId,templateVersion:saved.templateVersion}))).digest('hex');
 for(const table of ['automations','automation_runs'])for(const row of core.db.prepare(`SELECT id,data FROM ${table}`).all()){
  const value=JSON.parse(row.data.replaceAll(scope,oldScope));
  if(table==='automations')value.sourceSettings[url]={...settings,...obsolete};
  else Object.assign(value,{sourceSkillVersion:1,sourceSkillEvidence:[{quote:'Old observation'}],sourceToolCheck:{status:'failed'},sourceToolAttempts:1});
  core.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value),row.id);
 }
 const template=db.saveTemplate({...db.template('housing'),defaultSources:[{url,...settings}]});
 core.db.prepare('UPDATE automation_templates SET data=? WHERE id=?').run(JSON.stringify({...template,defaultSources:[{url,...settings,...obsolete}]}),template.id);
 core.db.exec('CREATE TABLE workspace_source_skills(workspace_id TEXT,source_url TEXT,version INTEGER,data TEXT); PRAGMA user_version=23');
 core.db.prepare('INSERT INTO workspace_source_skills VALUES(?,?,?,?)').run(a.id,url,1,'{}');
 core.close();core=new WorkspaceDatabase(file);db=new AutomationStore(core);
 assert.equal(core.db.prepare("SELECT name FROM sqlite_master WHERE name='workspace_source_skills'").get(),undefined);
 assert.deepEqual(db.get(a.id).sourceSettings[url],settings);
 const persistedTemplate=JSON.parse(core.db.prepare('SELECT data FROM automation_templates WHERE id=?').get(template.id).data);
 for(const key of Object.keys(obsolete))assert.equal(persistedTemplate.defaultSources[0][key],undefined);
 for(const key of ['sourceSkillVersion','sourceSkillEvidence','sourceToolCheck','sourceToolAttempts'])assert.equal(db.run(run.id)[key],undefined);
 assert.deepEqual(db.run(run.id).scanPlan,plan);
 const nextTask=core.workspaces.tasks.enqueue(a.id,{operation:'scan',sourceUrl:url,sources:[url],lockKey:'source:'+url});
 const next=db.begin(a.id,{kind:'run',taskId:nextTask.id});
 assert.equal(next.scanPlan.id,plan.id);assert.equal(next.scanPlan.startedAt,plan.startedAt);
 assert.deepEqual(db.scanQueue(a.id,next.id,{}).pendingUrls,[detail]);
 assert.equal(next.scanPlan.checkpoint.cursor,'page=2');
 db.finish(a.id,next.id,'interrupted','Restart');
 core.close();core=new WorkspaceDatabase(file);db=new AutomationStore(core);
 assert.deepEqual(db.get(a.id).sourceSettings[url],settings);
});

test('source extension tools are no longer advertised to agents',()=>{
 for(const name of ['get_workspace_source_instructions','run_workspace_source_tool','record_source_skill_evidence','save_workspace_source_skill'])assert.equal(automationTools.some(tool=>tool.name===name),false);
 assert.ok(automationTools.some(tool=>tool.name==='browser_open'));
 assert.ok(automationTools.some(tool=>tool.name==='browser_jev_run'));
});
