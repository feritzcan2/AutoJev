import {validateTaskCompletion} from './task-completion.mjs';
import {randomUUID} from 'node:crypto';

// Builds the bounded task prompt. Exported so the app can show exactly what the agent receives.
export function campaignPrompt({task,source,profile:p}){
 const skill=task.kind==='search'?'find-jobs':'apply-to-jobs';
 const completion=task.kind==='search'?'Report this task with report_campaign_work before ending.':'record_submission also reports this task done when completion.taskReported=true; then end the turn without more status/report calls. Otherwise use report_campaign_work.';
 const action=task.kind==='search'?`Search only source ${task.sourceId??'any'}${source?.name?` (${source.name})`:''}; no applications this turn.`:task.kind==='verify'?`Verify job ${task.jobId} WITHOUT resubmitting.`:`Process job ${task.jobId}; ${task.applyMode==='auto'&&p.authorization==='submit'?'automatic submission already authorized':task.applyMode==='find_only'||p.authorization==='research'?'do not apply':'prepare the form but do not submit'}.`;
 return `JobLoop task ${task.id} (${task.kind}). Read get_task_context and verify this task is current. Follow AGENTS.md and .agents/skills/${skill}/SKILL.md; read the skill only if not already in context. ${action}${task.recoveryQuestionId?` Recover technical question ${task.recoveryQuestionId}; no new candidate answer is implied.`:''}${task.retryRequestId?' User explicitly requeued this blocked application. Recheck its saved form and existing questions; this is not an answer or new consent. Resolve technical blockers when possible; reuse unanswered questions instead of duplicating them.':''} Use the current MCP profile, source settings, answers and checkpoint. ${completion} Resolve unmet requirements on this same task.`;
}

export function recoveryPrompt(options,reason){
 return `Continue the SAME interrupted task; follow the recovery rules in run-job-search. Reason: ${reason}.\n`+campaignPrompt(options);
}

// Only provider lifecycle signals release a task. Silence never means completion.
export class Campaigns {
  constructor(store,{launch,send,stop,active,changed,now=()=>Date.now()}){
    Object.assign(this,{store,launch,send,stop,active,changed,now});this.busy=false;this.closed=false;this.launching=new Set();
  }
  save(id,c){this.store.saveCampaign(id,c);this.changed(id);return c;}
  nextSourceAt(id){const enabled=this.store.sources(id).filter(source=>source.enabled);return enabled.length?Math.min(...enabled.map(source=>source.nextRunAt??0)):0;}
  async start(id,{target=100,intervalMinutes=30}={}){
    if(this.store.setup(id)&&this.store.setup(id).status!=='complete')throw Error('Önce aday setup tamamlanmalı');
    if(!Number.isInteger(target)||target<1||target>10000||!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)throw Error('Hedef 1–10000, tarama aralığı 1–1440 dakika olmalı');
    const previous=this.store.campaign(id);
    if(previous?.status==='running')return previous;
    if(this.launching.has(id))throw Error('Önce devam eden başlatma işleminin bitmesini bekle');
    if(this.active(id)?.candidateId===id)await this.stop(id);
    this.store.resetSourceSchedule(id);
    this.save(id,{...previous,status:'running',target,intervalMinutes,task:previous?.task?{...previous.task,report:null,seenWorking:false,recoveryAttempts:0,recovery:{readyAt:this.now(),reason:'User resumed the unfinished task'}}:null,nextSearchAt:0,wakeAt:0,failures:0,note:'Kampanya başlatıldı',attempts:previous?.attempts??{}});
    await this.tick();
  }
  async pause(id,status='paused'){
    const c=this.store.campaign(id);if(!c)return;
    this.save(id,{...c,status,task:null,note:status==='stopped'?'Kampanya durduruldu':'Kampanya duraklatıldı'});
    if(this.active(id)?.candidateId===id)await this.stop(id);
  }
  report(id,sessionId,{taskId,outcome,note,blocker}){
    const c=this.store.campaign(id);
    if(c?.status!=='running'||c.task?.id!==taskId||this.active(id)?.sessionId!==sessionId)throw Error('Etkin kampanya işi bulunamadı');
    if(!['done','no_results','blocked'].includes(outcome)||typeof note!=='string'||!note.trim())throw Error('Geçersiz iş sonucu');
    const report={outcome,note:note.slice(0,3000),...(blocker?{blocker}:{})};
    try{validateTaskCompletion(this.store,id,c,report);}catch(error){c.task.completionError=error.message;this.save(id,c);throw error;}
    if(c.task.report){
      if(c.task.report.outcome===outcome)return c;
      if(c.task.report.outcome!=='blocked'||outcome!=='done')throw Error('Bu işin sonucu zaten kaydedildi; farklı bir sonuçla değiştirilemez.');
    }
    delete c.task.completionError;c.task.report=report;return this.save(id,c);
  }
  recordSubmission(id,sessionId,input){
    const c=this.store.campaign(id);
    const matches=c?.status==='running'&&['application','verify'].includes(c.task?.kind)&&c.task.jobId===input.jobId&&this.active(id)?.sessionId===sessionId;
    let job;
    // Persist proof and its matching task report together. The next task still
    // waits for provider Idle; saving proof must never launch overlapping work.
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      job=this.store.recordSubmission(id,input.jobId,input,sessionId);
      if(matches){
        const report={outcome:'done',note:`${job.company} · ${job.role}: gönderim onayı kaydedildi.`};
        validateTaskCompletion(this.store,id,c,report);
        c.task.report=report;c.task.seenWorking=true;
        delete c.task.completionError;delete c.task.recovery;
        if(c.pendingResumes)delete c.pendingResumes[job.id];
        if(c.pendingRecoveries)delete c.pendingRecoveries[job.id];
        if(c.pendingRetries)delete c.pendingRetries[job.id];
        this.store.saveCampaign(id,c);
      }
      this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    if(matches)this.changed(id);
    return {...job,completion:{taskId:matches?c.task.id:null,taskReported:Boolean(matches),nextAction:matches?'end_turn':'return_to_current_task',message:matches?'Submission and task completion saved. End this turn; do not call update_application or report_campaign_work again.':'Submission saved. Do not change this completed application; no matching active campaign task was completed.'}};
  }
  delivery(id,state){
    const c=this.store.campaign(id);if(this.closed||c?.status!=='running'||!c.task||c.task.seenWorking)return;
    c.task.delivery=state;
    if(['Failed','Stalled','Blocked','RequiresUserResubmit'].includes(state)){
      c.status='paused';c.note='Görev agent’a teslim edilemedi ('+state+'). Terminali kontrol edip Başlat ile devam edebilirsin.';
    }
    this.save(id,c);
  }
  input(id){
    const c=this.store.campaign(id);if(c?.status==='running'&&c.task?.recovery){c.task.recovery.readyAt=this.now()+5000;this.save(id,c);}
  }
  recoverTurn(id,c,reason){
    const attempts=(c.task.recoveryAttempts??0)+1;c.task.recoveryAttempts=attempts;
    if(attempts>3){this.save(id,{...c,status:'paused',note:'Aynı görev üç kez tamamlanamadı: '+reason});return;}
    c.task.recovery={readyAt:this.now()+5000,reason};c.task.seenWorking=false;
    c.note='Tur kesildi veya sonuç bildirilmedi; agent hazır olduğunda aynı görev sürdürülecek.';this.save(id,c);
  }
  async resumeTurn(id,c){
    const task=c.task,session=this.active(id);
    if(!task?.recovery||this.now()<task.recovery.readyAt||(session&&!['Idle','Interrupted'].includes(session.state)))return;
    const source=task.sourceId?this.store.source(id,task.sourceId):null;
    const job=task.jobId?this.store.job(id,task.jobId):null;
    const reason=task.recovery.reason;
    delete task.recovery;task.createdAt=this.now();task.seenWorking=false;
    if(job&&['submitting','uncertain'].includes(job.status))task.kind='verify';
    this.save(id,{...c,task,note:'Kesilen görev kaldığı yerden sürdürülüyor'});
    this.launching.add(id);
    try{const prompt=recoveryPrompt({task,source,profile:this.store.profile(id)},reason);if(session)await this.send(prompt,id);else await this.launch(id,prompt,task.jobId);}
    catch(error){const current=this.store.campaign(id);if(current?.status==='running'&&current.task?.id===task.id)this.save(id,{...current,status:'paused',note:'Devam mesajının teslimi doğrulanamadı: '+error.message});}
    finally{this.launching.delete(id);}
  }
  signal(id,state){
    if(this.closed)return;
    const c=this.store.campaign(id);if(c?.status!=='running'||!c.task)return;
    if(state==='Working'||state==='Compacting'){c.task.seenWorking=true;c.note=c.task.kind==='search'?`${this.store.source(id,c.task.sourceId)?.name??'Kaynak'} taranıyor`:'Agent başvuruyu işliyor';this.save(id,c);}
    else if(state==='Failed'){c.note='Agent hata bildirdi; oturum yeniden hazırlanıyor';this.save(id,c);this.stop(id).then(()=>this.exited(id)).catch(error=>this.save(id,{...this.store.campaign(id),status:'paused',note:error.message}));}
    else if(state==='Interrupted'){this.recoverTurn(id,c,'Terminal turn interrupted');}
    else if(state==='Idle'&&c.task.seenWorking){
      const task=c.task;
      if(!task.report){this.recoverTurn(id,c,task.completionError??'Turn ended without report_campaign_work');return;}
      try{validateTaskCompletion(this.store,id,c,task.report);}catch(error){task.report=null;this.recoverTurn(id,c,error.message);return;}
      if(task.jobId){
        if(task.retryRequestId&&c.pendingRetries?.[task.jobId]?.requestId===task.retryRequestId)delete c.pendingRetries[task.jobId];
        if(task.report&&task.recoveryQuestionId&&c.pendingRecoveries?.[task.jobId]===task.recoveryQuestionId)delete c.pendingRecoveries[task.jobId];
        if(task.report&&task.resumeQuestionId&&c.pendingResumes?.[task.jobId]===task.resumeQuestionId)delete c.pendingResumes[task.jobId];
        if(c.pendingResumes?.[task.jobId])delete c.attempts[task.jobId];else c.attempts[task.jobId]=this.now();
      }
      if(task.kind==='search'&&task.sourceId){const source=this.store.source(id,task.sourceId),found=Math.max(0,this.store.jobs(id).length-(task.jobsBefore??0)),nextRunAt=this.now()+source.intervalMinutes*60000;this.store.markSourceRun(id,source.id,{at:this.now(),nextRunAt,result:task.report?.note??'İş sonucu bildirilmedi',found});c.nextSearchAt=this.nextSourceAt(id);}
      else if(task.kind==='search')c.nextSearchAt=this.now()+c.intervalMinutes*60000;
      const report=task.report;c.task=null;
      if(!report){c.failures++;c.wakeAt=this.now()+Math.min(300000,10000*2**Math.min(c.failures,5));c.note='Tur bitti fakat iş sonucu bildirilmedi; kontrollü yeniden deneme bekliyor';}
      else{c.failures=0;c.wakeAt=0;c.note=report.note;if(report.outcome==='blocked'&&!task.jobId&&!task.sourceId)c.wakeAt=this.now()+c.intervalMinutes*60000;}
      this.save(id,c);
    }
  }
  exited(id){const c=this.store.campaign(id);if(c?.status!=='running')return;if(c.task){this.recoverTurn(id,c,'Agent session closed before task completion; inspect saved outcome and resume the same task');return;}c.failures++;c.wakeAt=this.now()+Math.min(300000,10000*2**Math.min(c.failures,5));c.note='Agent kapandı; kayıtlı durumdan yeniden başlatılacak';if(c.failures>=5){c.status='paused';c.note='Agent beş kez açılamadı veya kapandı. Hatayı düzelttikten sonra Başlat ile devam edebilirsin.';}this.save(id,c);}
  answered(id,questionId){const c=this.store.campaign(id);if(!c)return;const q=this.store.questions(id).find(q=>q.id===questionId);if(!q||q.answer===null)return;c.wakeAt=0;if(q.jobId){c.pendingResumes??={};c.pendingResumes[q.jobId]=questionId;delete c.attempts[q.jobId];}this.save(id,c);}
  recheckLegacyFormQuestions(id){
    let c=this.store.campaign(id);if(!c||c.formVerificationMigration===1)return;
    for(const q of this.store.questions(id)){
      if(q.answer!==null||!q.jobId||q.applicationBlocker?.recovery?.kind!=='form_entry'||q.applicationBlocker.recovery.visualCheck)continue;
      if(['submitted','skipped'].includes(this.store.job(id,q.jobId).status))continue;
      this.recoverQuestion(id,q.id);
    }
    c=this.store.campaign(id);c.formVerificationMigration=1;this.save(id,c);
  }
  recoverQuestion(id,questionId){
    const c=this.store.campaign(id),q=this.store.questions(id).find(q=>q.id===questionId);
    if(!c||!q?.jobId||q.answer!==null)throw Error('Kurtarılacak açık başvuru sorusu bulunamadı');
    const job=this.store.job(id,q.jobId);if(['submitted','skipped'].includes(job.status))throw Error('Tamamlanmış başvuru yeniden başlatılamaz');
    c.pendingResumes??={};c.pendingResumes[q.jobId]=questionId;c.pendingRecoveries??={};c.pendingRecoveries[q.jobId]=questionId;
    delete c.attempts[q.jobId];c.wakeAt=0;this.save(id,c);
    return{queued:true,message:c.status==='running'?'Sekme ve form kontrolü sıraya alındı. Agent mevcut işini bitirince bu başvuruya dönecek.':'Sekme ve form kontrolü sıraya alındı. Agent’ı başlatınca devam edecek.'};
  }
  queueApplication(id,jobId){
    const job=this.store.job(id,jobId),profile=this.store.profile(id);
    if(job.status!=='blocked')throw Error('Yalnızca bilgi / işlem bekleyen başvurular sıraya alınabilir.');
    const source=job.sourceId?this.store.source(id,job.sourceId):null;
    if(profile.authorization==='research'||source?.applyMode==='find_only')throw Error('Bu ilan için başvuru hazırlama izni gerekli; profil veya kaynak yalnızca araştırmaya izin veriyor.');
    const c=this.store.campaign(id)??{status:'paused',target:100,intervalMinutes:30,task:null,attempts:{},failures:0};
    if(c.status==='running'&&c.task?.jobId===jobId)return {queued:false,active:true,message:'Agent bu ilanı zaten işliyor.'};
    c.pendingRetries??={};
    const existing=c.pendingRetries[jobId];
    c.pendingRetries[jobId]??={requestId:randomUUID(),queuedAt:this.now()};
    c.attempts??={};delete c.attempts[jobId];c.wakeAt=0;
    this.save(id,c);
    return {queued:true,alreadyQueued:Boolean(existing),requestId:c.pendingRetries[jobId].requestId,message:c.status==='running'?'İlan sıraya alındı. Agent mevcut işinden sonra yeniden kontrol edecek.':'İlan sıraya alındı. Agent’ı başlatınca yeniden kontrol edecek.'};
  }
  choose(id,c){
    const p=this.store.profile(id),jobs=this.store.jobs(id),questions=this.store.questions(id);
    if(p.authorization!=='research'){
      for(const j of jobs.slice().reverse().sort((a,b)=>Number(Boolean(c.pendingRetries?.[b.id]||c.pendingResumes?.[b.id]))-Number(Boolean(c.pendingRetries?.[a.id]||c.pendingResumes?.[a.id])))){
        const source=j.sourceId?this.store.source(id,j.sourceId):null;if(source?.applyMode==='find_only')continue;
        const unanswered=questions.some(q=>q.jobId===j.id&&q.answer===null);if(unanswered&&!c.pendingRecoveries?.[j.id]&&!c.pendingRetries?.[j.id])continue;
        const answered=questions.some(q=>q.jobId===j.id&&q.answer!==null);
        const maySubmit=p.authorization==='submit'&&(!source||source.applyMode==='auto');
        const eligible=['found','working','uncertain'].includes(j.status)||(j.status==='prepared'&&maySubmit)||(j.status==='blocked'&&(c.pendingRetries?.[j.id]||answered||c.pendingRecoveries?.[j.id]||j.note.startsWith('Oturum kapandı.')));
        if(eligible&&(c.pendingRetries?.[j.id]||c.pendingResumes?.[j.id]||(j.status==='prepared'&&maySubmit)||!c.attempts[j.id]||Date.parse(j.updatedAt)>c.attempts[j.id]))return{retryRequestId:c.pendingRetries?.[j.id]?.requestId??null,recoveryQuestionId:c.pendingRecoveries?.[j.id]??null,resumeQuestionId:c.pendingResumes?.[j.id]??null,kind:j.status==='uncertain'?'verify':'application',jobId:j.id,sourceId:j.sourceId??null,applyMode:source?.applyMode??(maySubmit?'auto':'prepare')};
      }
    }
    const due=this.store.sources(id).filter(source=>source.enabled&&(source.nextRunAt??0)<=this.now()).sort((a,b)=>(a.nextRunAt??0)-(b.nextRunAt??0))[0];
    if(due)return{kind:'search',sourceId:due.id,jobsBefore:jobs.length};
    c.nextSearchAt=this.nextSourceAt(id);
    return null;
  }
  async tick(){
    if(this.busy||this.closed)return;this.busy=true;
    try{for(const p of this.store.candidates()){
      if(this.store.setup(p.id)&&this.store.setup(p.id).status!=='complete')continue;
      let c=this.store.campaign(p.id);if(c?.status!=='running')continue;
      if(c.task){
        if(c.task.recovery){await this.resumeTurn(p.id,c);continue;}
        if(!c.task.seenWorking&&!this.launching.has(p.id)&&this.now()-c.task.createdAt>90000){this.save(p.id,{...c,status:'paused',note:'Görev için 90 saniye içinde çalışma başlangıcı doğrulanamadı. Çift gönderimi önlemek için duraklatıldı; terminali kontrol edip Başlat ile devam edebilirsin.'});}
        continue;
      }
      if(this.now()<c.wakeAt)continue;
      const session=this.active(p.id);if(session?.state&&session.state!=='Idle')continue;
      if(this.store.jobs(p.id).filter(j=>j.status==='submitted').length>=c.target){this.save(p.id,{...c,status:'complete',note:'Başvuru hedefine ulaşıldı'});continue;}
      const chosen=this.choose(p.id,c);if(!chosen)continue;
      const task={...chosen,id:randomUUID(),seenWorking:false,report:null,createdAt:this.now()};c.task=task;this.save(p.id,c);
      const source=task.sourceId?this.store.source(p.id,task.sourceId):null;
      const prompt=campaignPrompt({task,source,profile:p});
      this.launching.add(p.id);
      try{
        if(!this.active(p.id))await this.launch(p.id,prompt,task.jobId);
        else{if(task.jobId){const j=this.store.job(p.id,task.jobId);if(['blocked','uncertain'].includes(j.status)&&j.sessionId!==this.active(p.id).sessionId)this.store.reclaim(p.id,j.id,this.active(p.id).sessionId);}await this.send(prompt,p.id);}
        // A stop/pause may arrive while launch was in flight.
        if(this.store.campaign(p.id)?.status!=='running'){if(this.active(p.id)?.candidateId===p.id)await this.stop(p.id);continue;}
        if(task.jobId){const job=this.store.job(p.id,task.jobId);if(['blocked','uncertain'].includes(job.status)&&job.sessionId!==this.active(p.id)?.sessionId)this.store.reclaim(p.id,job.id,this.active(p.id).sessionId);}
        const delivered=this.store.campaign(p.id);
        if(delivered?.status==='running'&&delivered.task?.id===task.id){
          const job=task.jobId?this.store.job(p.id,task.jobId):null;
          const note=delivered.task.seenWorking?(task.kind==='search'&&source?`${source.name} taranıyor`:job?`${job.company} · ${job.role} işleniyor`:'Agent görevi işliyor'):'Görev kuyrukta; agentın başlaması bekleniyor';
          this.save(p.id,{...delivered,note});
        }
      }catch(error){c=this.store.campaign(p.id);if(c?.status==='running'){c.task=null;c.failures++;if(this.active(p.id)){c.status='paused';c.note='Mesaj teslimi doğrulanamadı. Çift iş göndermemek için duraklatıldı: '+error.message;}else{c.wakeAt=this.now()+Math.min(300000,10000*2**Math.min(c.failures,5));c.note=error.message;if(c.failures>=5){c.status='paused';c.note='Tekrarlanan başlatma hatası: '+error.message;}}this.save(p.id,c);}}finally{this.launching.delete(p.id);}
      break;
    }}finally{this.busy=false;}
  }
}
