import {mailReviewOutcomes} from './mail-contract.mjs';
const str={type:'string',minLength:1,maxLength:2000};
const schema=(properties={},required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const mailTools=[
 {name:'get_mail_task',description:'Read candidate, expected Gmail account, known applications and prior outcomes. Read actual emails through your existing Gmail connector, not JobLoop.',inputSchema:schema()},
 {name:'report_mail_connection',description:'Report the Gmail connector/account actually available in this agent session. Verify account from connector metadata before searching emails. Missing connector or wrong/unverifiable account blocks and closes this run.',inputSchema:schema({status:{...str,enum:['ready','missing','account_mismatch','identity_missing']},account:str,connector:str,message:str},['status','message'])},
 {name:'is_mail_processed',description:'Check durable account+message deduplication before fetching an email body.',inputSchema:schema({messageId:str})},
 {name:'record_mail_outcome',description:'Record evidence actually read from the Gmail connector. Supply original message/thread IDs, subject, ISO date, source Gmail URL and a short supporting excerpt; never invent mail evidence. Choose the most plausible job from timing, saved application evidence and mail context without asking the user. Explain inferred matches in summary. Omit jobId only when no reasonable match exists. Pending unmatched messages may be recorded again to resolve them.',inputSchema:schema({messageId:str,threadId:str,subject:str,date:str,url:str,evidence:str,jobId:str,outcome:{...str,enum:['confirmation','interview','assessment','offer','rejection','unmatched','ignored']},summary:str},['messageId','threadId','subject','date','url','evidence','outcome','summary'])},
 {name:'finish_background_job',description:'Report the assigned skill result. The temporary agent then closes.',inputSchema:schema({summary:str,status:{...str,enum:['completed','blocked','failed']}},['summary'])}
];
export function mailWorkflow(db,run,complete,signal){
 const id=run.candidateId,expected=db.task(id).mailbox,contract=db.mailContract(id),generic=Boolean(db.store.mailRecords),tools=structuredClone(mailTools);let verified=null;
 const recordTool=tools.find(t=>t.name==='record_mail_outcome');recordTool.inputSchema.properties.outcome.enum=[...contract.outcomes,...mailReviewOutcomes].map(o=>o.id);
 if(generic){
  tools.find(t=>t.name==='get_mail_task').description='Read this workspace, tracked records, template mail instructions, allowed outcomes and the expected Gmail account. Read messages through the agent’s existing Gmail connector.';
  recordTool.description='Record sourced mail evidence and its outcome for a tracked workspace record. Use original message/thread IDs, date, Gmail URL and a supporting excerpt. Supply recordId only for an evidence-backed match; explain inferred matches. Pending unmatched messages can be reconsidered.';
  recordTool.inputSchema.properties.recordId=recordTool.inputSchema.properties.jobId;delete recordTool.inputSchema.properties.jobId;
 }
 const connection=(value)=>{const task=db.task(id);db.putTask(id,{...task,connection:{...value,checkedAt:Date.now(),runId:run.id}});};
 return{tools,async call(candidate,session,name,a){
  if(candidate!==id||session!==run.id||signal.aborted)throw Error('Görev oturumu geçersiz');
  if(db.task(id).mailbox!==expected)throw Error('Görev hesabı değişti; görevi yeniden çalıştır');
  if(name==='get_mail_task')return{...(generic?{workspace:db.store.profile(id),records:db.store.mailRecords(id)}:{candidate:{name:db.store.profile(id).name},applications:db.store.jobs(id).map(({id,company,role,status,url,createdAt,updatedAt,proof,manualOutcome,manualUpdatedAt,resumeContext,note})=>({id,company,role,status,url,createdAt,updatedAt,proof,manualOutcome,manualUpdatedAt,resumeContext,note}))}),expectedAccount:expected||null,access:'Use your existing Gmail connector/MCP. AutoJev does not connect to Gmail.',window:'Last 90 days; workspace-related messages only',instructions:contract.instructions,outcomes:contract.outcomes,pendingSignals:db.pendingSignals(id,expected),previousSignals:db.signals(id).filter(s=>s.account===expected).map(({messageId,threadId,jobId,outcome,review,date,summary})=>({messageId,threadId,...(generic?{recordId:jobId}:{jobId}),outcome,review,date,summary}))};
  if(name==='report_mail_connection'){
   const account=a.account?.trim().toLowerCase();let status=a.status,message=a.message;
   if(status==='ready'&&(!expected||!account||!a.connector)){status='identity_missing';message='Çalışma alanı profilindeki e-posta adresini tamamla ve connector hesabını doğrula.';}
   else if(status==='ready'&&account!==expected){status='account_mismatch';message='Agent’ın Gmail hesabı çalışma alanındaki Gmail adresiyle eşleşmiyor. Doğru connector hesabını seç.';}
   connection({status,message,account:account??null,connector:a.connector??null});
   if(status!=='ready'){verified=null;return complete(id,run.id,message,'blocked');}
   verified={account,connector:a.connector};return{verified:true,account};
  }
  if(!verified)throw Error('Önce mevcut Gmail connector hesabını doğrula');
  if(name==='is_mail_processed')return{processed:db.processed(id,verified.account,a.messageId)};
  if(name==='record_mail_outcome'){
   const url=new URL(a.url);if(url.protocol!=='https:'||url.hostname!=='mail.google.com'||url.username||url.password)throw Error('Kaynak bağlantısı Gmail olmalı');
   if(!Number.isFinite(Date.parse(a.date)))throw Error('Geçerli mail tarihi gerekli');
   return db.record(id,verified.account,{id:a.messageId,threadId:a.threadId,subject:a.subject,date:new Date(a.date).toISOString(),url:url.toString(),evidence:a.evidence,connector:verified.connector},generic?{...a,jobId:a.recordId}:a);
  }
  if(name==='finish_background_job')return complete(id,run.id,a.summary,a.status??'completed');
  throw Error('Unknown tool');
 }};
}
