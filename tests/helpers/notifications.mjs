import {randomUUID} from 'node:crypto';
import {WorkspaceDatabase} from '../../app/workspace-database.mjs';
import {AutomationStore} from '../../app/automation-store.mjs';
import {WorkspaceSupport} from '../../app/workspace-support.mjs';

// Transport fixtures write through the same automation store and projection as
// the desktop. They only seed data; execution and delivery use production code.
export class NotificationFixture extends WorkspaceSupport {
 constructor(file){const core=new WorkspaceDatabase(file);super(new AutomationStore(core),{slots:()=>[]});this.core=core;}
 close(){this.core.close();}
 createWorkspace({name,preferences}){return this.automation.create('job-search',{title:name,goal:preferences,sources:[]});}
 addRecord(id,{url,company,role,location,fit}){
  const existing=this.automation.results(id,{all:true}).find(item=>item.url===url);if(existing)return {job:this.project(existing),duplicate:true};
  const item=this.automation.putResult({id:randomUUID(),automationId:id,key:url,url,title:role,summary:fit,status:'found',trial:false,cells:{company,location},createdAt:Date.now()});
  return {job:this.project(item)};
 }
 saveRecord(input,event){
  const id=input.automationId,item=this.automation.result(id,input.id),status={submitted:'completed',already_submitted:'completed',submitting:'executing',skipped:'dismissed'}[input.status]??input.status;
  const saved=this.automation.putResult({...item,...input,title:input.role??item.title,summary:item.summary,status});
  if(event)this.event(id,event,{id:saved.id});return this.project(saved);
 }
 setRecordState(id,itemId,state){
  if(state==='dismissed')return this.project(this.automation.dismiss(id,itemId));
  return this.project(this.automation.putResult({...this.automation.result(id,itemId),status:state}));
 }
 scoreRecord(id,itemId,score){
  const item=this.automation.result(id,itemId);return this.project(this.automation.putResult({...item,cells:{...item.cells,score},assessment:{status:'scored',score,summary:'Synthetic fit assessment'}}));
 }
 askQuestion(id,{question,jobId,...input}){return this.automation.askQuestion(id,{...input,text:question,recordId:jobId});}
 answerQuestion(...args){return this.automation.answerQuestion(...args);}
 changeQuestion(id,questionId,text){const a=this.automation.get(id);this.automation.put({...a,questions:a.questions.map(q=>q.id===questionId?{...q,text}:q)});}
 removeWorkspace(id){return this.automation.remove(id);}
}
