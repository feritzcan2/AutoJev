import test from 'node:test';
import assert from 'node:assert/strict';
import {NotificationFixture} from './helpers/notifications.mjs';
import {TelegramStore} from '../app/telegram-store.mjs';

test('pin collection reads the queue once and follows live task changes across many cards',t=>{
 const store=new NotificationFixture(':memory:'),db=new TelegramStore(store,Date.now,1);
 t.after(()=>store.close());
 const candidate=store.createWorkspace({name:'Candidate',preferences:'Remote'}).id;
 db.saveConfig(candidate,{enabled:true,bot:{id:1}});
 db.bind(db.pair(candidate).token,1,1,'Candidate');
 const tasks=store.workspaces.tasks,states=['pending','running','reported','paused','completed','failed','cancelled'],cards=[];
 for(let i=0;i<120;i++){
  const job=store.addRecord(candidate,{url:`https://example.com/jobs/${i}`,role:'Engineer'}).job;
  const card=db.enqueue(candidate,`new-job:${job.id}`,{kind:'new_job',jobId:job.id});db.sent(card.id,i+1,1,{text:'Job'});
  const state=states[i%states.length],task=tasks.enqueue(candidate,{recordId:job.id,operation:'prepare',recordOperation:'prepare'});
  tasks.put({...task,state});cards.push({id:card.id,task,state});
 }
 // A stale card must not be pinned even if a task still refers to its missing record.
 const stale=db.enqueue(candidate,'missing',{kind:'new_job',jobId:'missing'});db.sent(stale.id,999,1,{text:'Missing'});
 tasks.enqueue(candidate,{recordId:'missing',operation:'prepare'});
 const readTasks=store.workerState.tasks;let reads=0;
 store.workerState.tasks=id=>{reads++;return readTasks(id);};
 store.queueState=()=>{throw Error('Do not reload every record for pin collection');};
 const check=()=>{
  const pins=new Map(store.db.prepare('SELECT delivery_id,wanted FROM telegram_pins').all().map(row=>[row.delivery_id,row.wanted]));
  for(const card of cards)assert.equal(pins.get(card.id),Number(['pending','running','reported','paused'].includes(card.state)));
  assert.equal(pins.get(stale.id),0);
 };
 db.collectPins();assert.equal(reads,1);check();
 for(const card of cards){card.state=card.state==='completed'?'pending':'completed';tasks.put({...card.task,state:card.state});}
 db.collectPins();assert.equal(reads,2);check();
});
