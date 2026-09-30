import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspace-database.mjs';
import {AutomationStore} from '../app/automation-store.mjs';
import {WorkspaceSupport,rebindWorkspaceOwners} from '../app/workspace-support.mjs';
import {TelegramStore} from '../app/telegram-store.mjs';
import {BackgroundStore} from '../app/background-store.mjs';
import {skillWorkflow} from '../app/background-worker.mjs';

for(const template of ['job-search','housing'])test(`${template}: background and Telegram use shared workspace data`,async t=>{
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create(template),store=new WorkspaceSupport(db,{slots:()=>[]}),background=new BackgroundStore(store),telegram=new TelegramStore(store,()=>1000,'123');
 assert.equal(background.task(a.id).candidateId,a.id);store.event(a.id,'background_started',{workerId:'background'});
 telegram.saveConfig(a.id,{enabled:true,bot:{id:123},secret:'fixture'});const pair=telegram.pair(a.id);assert.ok(telegram.bind(pair.token,1,1,'Test'));
 const question=db.askQuestion(a.id,{text:'Tercihin?',fields:[{id:'choice',label:'Tercih',type:'select',options:['A','B']}]});telegram.collect();assert.ok(core.db.prepare('SELECT 1 FROM telegram_outbox WHERE event_key=?').get('question:'+question.id));assert.equal(telegram.question(a.id,question.id).fields[0].type,'select');
 const run={id:'run',candidateId:a.id,skillPath:'custom.md'},flow=skillWorkflow(background,run,()=>{},new AbortController().signal);assert.equal((await flow.call(a.id,run.id,'get_background_context',{})).profile.title,a.title);
 db.remove(a.id);for(const table of ['telegram_links','telegram_configs','telegram_outbox','workspace_events'])assert.equal(core.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0);
});

test('transport owner migration retains deliveries and switches the foreign key',t=>{
 const core=new WorkspaceDatabase(':memory:');t.after(()=>core.close());const db=new AutomationStore(core),a=db.create('housing');core.db.exec('CREATE TABLE candidates(id TEXT PRIMARY KEY); CREATE TABLE telegram_links(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),cursor INTEGER);');core.db.prepare('INSERT INTO candidates VALUES(?)').run(a.id);core.db.prepare('INSERT INTO telegram_links VALUES(?,77)').run(a.id);rebindWorkspaceOwners(core.db);assert.equal(core.db.prepare('PRAGMA foreign_key_list(telegram_links)').get().table,'workspaces');assert.equal(core.db.prepare('SELECT cursor FROM telegram_links').get().cursor,77);assert.deepEqual(core.db.prepare('PRAGMA foreign_key_check').all(),[]);
});
