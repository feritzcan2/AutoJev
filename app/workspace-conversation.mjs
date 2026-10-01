export const CONVERSATION_WORKER='conversation';
export const isConversation=run=>run?.workerId===CONVERSATION_WORKER;
export const conversationWaiting=run=>isConversation(run)&&run.interactive===true&&run.awaitingMessage===true;
export const hasBlockingRun=snapshot=>(snapshot?.activeRuns??(snapshot?.activeRun?[snapshot.activeRun]:[])).some(run=>!conversationWaiting(run));
export const interviewBusy=snapshot=>{const run=interviewRun(snapshot);return Boolean(run&&!conversationWaiting(run));};
export const interviewRun=snapshot=>(snapshot?.activeRuns??(snapshot?.activeRun?[snapshot.activeRun]:[])).find(run=>run.kind==='interview')??null;

// Pin each turn to its own input. Later worker reports and unrelated user
// messages must not change the request while a provider is starting/resuming.
export function conversationRequest(db,id,run){
 if(run.messageId){
  const row=db.db.prepare("SELECT data FROM automation_messages WHERE automation_id=? AND id=? AND json_extract(data,'$.role')='user'").get(id,run.messageId);
  if(!row)throw Error('Sohbet mesajı bu çalışma alanında bulunamadı.');
  const {text,at}=JSON.parse(row.data);return {message:text,at};
 }
 const ids=run.inputQuestionIds??run.continuation?.questionIds??[];
 const answers=(db.get(id).questions??[]).filter(q=>q.conversation&&ids.includes(q.id)&&q.answer!=null).map(q=>({question:q.text,fields:q.fields,answer:q.answer,answerValues:q.answerValues}));
 return answers.length?{answers}:null;
}

export function workspaceHistory(db,id,{kind,query='',itemId,recordId,before,limit=5}={}){
 const table=kind==='messages'?'automation_messages':kind==='runs'?'automation_runs':null;
 if(!table)throw Error('Geçmiş türü messages veya runs olmalı.');
 if(!Number.isSafeInteger(limit)||limit<1||limit>10||before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw Error('Geçersiz geçmiş aralığı.');
 if(typeof query!=='string'||query.length>200)throw Error('Geçersiz geçmiş araması.');
 if(recordId&&kind!=='runs')throw Error('Kayıt geçmişi için runs kullan.');
 db.get(id);
 const conditions=['automation_id=?'],args=[id];
 if(itemId){conditions.push('id=?');args.push(itemId);}
 if(recordId){conditions.push("json_extract(data,'$.recordId')=?");args.push(recordId);}
 if(before!==undefined){conditions.push('rowid<?');args.push(before);}
 if(query){conditions.push("instr(lower(coalesce(json_extract(data,'$.text'),json_extract(data,'$.summary'),'')),lower(?))>0");args.push(query);}
 const rows=db.db.prepare(`SELECT rowid,data FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY rowid DESC LIMIT ?`).all(...args,limit+1);
 const page=rows.slice(0,limit),keys=kind==='messages'?['id','role','text','at','runId','conversation']:['id','workerId','kind','operation','recordOperation','recordId','sourceUrl','status','startedAt','finishedAt','summary'];
 return {kind,order:'newest_first',entries:page.map(row=>{const value=JSON.parse(row.data);return Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));}),nextBefore:rows.length>limit?page.at(-1).rowid:null};
}
