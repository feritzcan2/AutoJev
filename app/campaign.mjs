import {canonicalJob,uniqueJobCount} from './job-identity.mjs';
import {hasManualApplicationWork,manualApplicationAuthorized,uncertainRetryPeerAllowed} from './application-queue.mjs';
import {candidateReplyActions} from './application-replies.mjs';
import {rankDecision} from './ranking.mjs';
import {validateTaskCompletion} from './task-completion.mjs';
import {randomUUID} from 'node:crypto';
import {preparationHeld,hasPreparationWork} from './preparation.mjs';
import {sourceCoverage} from './source-coverage.mjs';

// Builds the bounded task prompt. Exported so the app can show exactly what the agent receives.
export function campaignPrompt({task,source,profile:p,definition}){
 const skill=task.kind==='search'?'find-jobs':task.kind==='rank'?'rank-jobs':task.kind==='preparation'?'prepare-application':'apply-to-jobs';
 const completion=['search','rank'].includes(task.kind)?'Report this task with report_campaign_work before ending.':'record_submission, ask_candidate and stop_application_followup also report this task when completion.taskReported=true; then end the turn without more status/report calls. Otherwise use report_campaign_work.';
 const action=task.kind==='preparation'?`Prepare the application package for job ${task.jobId}. Inspect the actual form and accessible steps; identify required documents, language, formats, size limits and questions. Save files and answer drafts using save_preparation. Do not submit, even if profile/source allow auto. Preserve user-edited artifacts. Complete useful work before asking about missing facts. Mark partial coverage honestly. Finish at the preparation package; the user must separately choose Başvur.`:task.kind==='rank'?`Score saved job ${task.jobId} using rank-jobs and record_job_rank when rankDecision.state=pending, including a saved failed retrieval requiring browser recheck. If already scored, reuse it and report this task without scoring again; do not fill or submit an application during this task.`:task.kind==='search'?`Search only source ${task.sourceId??'any'}${source?.name?` (${source.name})`:''}; no applications. Resume source.scanProgress. Save pending links/next page with save_source_progress. Report coverage: done/no_results only if complete; otherwise partial.`:task.kind==='verify'?`Verify job ${task.jobId} WITHOUT resubmitting. Explicit field validation that prevented submission can be recorded with record_validation_failure; follow its recovery result. For an explicit pending verification step after a candidate reply, use continue_verification and follow its single-step result. Never ask the candidate to create an application task.`:`Process job ${task.jobId}; ${task.manualRequestId?'user explicitly authorized submission for this job; applicationAuthorization in get_task_context overrides profile/source modes, scoring requirements and campaign limits for this job only':task.applyMode==='auto'&&p.authorization==='submit'?'automatic submission already authorized':task.applyMode==='find_only'||p.authorization==='research'?'do not apply':'prepare the form but do not submit'}.${task.repeatUncertain?' The previous attempt was uncertain and is archived in priorSubmissionAttempts. The user explicitly accepts a possible duplicate for this job and authorized one fresh submission attempt. Inspect the live form, fill from verified facts, and submit at most once; record only fresh confirmation as proof.':''}`;
 const custom=definition?.personal?definition.workflow.find(step=>step.id===task.kind):null;
 return `${custom?`Template operation: ${custom.instructions}. Template guidance: ${definition.guidance??''}. Additional user criteria: ${JSON.stringify(p.criteria??{})}. `:''}JobLoop task ${task.id} (${task.kind}). Call get_task_context once at task start to verify the task. Reuse it throughout this task. Follow AGENTS.md and .agents/skills/${skill}/SKILL.md; read the skill only if not already in context. ${action}${task.recoveryQuestionId?` Recheck unanswered question ${task.recoveryQuestionId} against the saved form and current candidate facts; no new candidate answer or consent is implied. Reuse the existing question if information is still missing. Resume the saved tab; if it is confirmed closed and no submission is pending or uncertain, reopen the exact saved listing in the same candidate browser/profile and prepare the form again using verified facts.${task.repeatUncertain?' The archived uncertain attempt has explicit one-time retry authorization.':' Never resubmit an uncertain application.'}`:''}${task.verificationOnly?' User requested priority verification of the existing attempt only. Inspect the saved tab and confirmation evidence. Do not open or submit a new application. If a previously answered access question and fresh site evidence show one unfinished verification step, continue_verification may reserve that exact step once; follow its guarded result. Recording fresh field validation evidence also ends this verification task.':''}${task.retryRequestId?` User explicitly queued this application. Recheck its saved form and existing questions; ${task.repeatUncertain?'the scoped duplicate-risk authorization is recorded':'this is not an answer or new consent'}. Resolve technical blockers when possible; reuse unanswered questions instead of duplicating them.`:''} Use the current MCP profile, source settings, reusableAnswers, answers and checkpoint. Kullanıcıya kısa ve sade Türkçe yaz; görev kimliği, araç adı ve iç kontrol adımlarını anlatma. ${completion} Resolve unmet requirements on this same task. On browser_wait, end without reporting; the app resumes this task.`;
}

export function recoveryPrompt(options,reason){
 const search=options.task.kind==='search'?' Resume the saved source search tabs. With Jev, call browser_jev_tabs once and observe tabs for this searchTaskId or source.resumeContext; exclude jobId tabs. Keep the current search page/filters and open a replacement only if the relevant tab is confirmed missing. With other browser tools use the saved source browser/tab identity.':'';
 return `Continue the SAME interrupted task; follow the recovery rules in run-job-search. Reason: ${reason}.${search}\n`+campaignPrompt(options);
}

// Only provider lifecycle signals release a task. Silence never means completion.
export class Campaigns {
  constructor(store,{launch,send,stop,active,changed,browserReady=()=>({ready:true}),readContext=async()=>null,contextBusy=()=>false,rotateContext=async()=>{},now=()=>Date.now()}){
    Object.assign(this,{store,launch,send,stop,active,changed,browserReady,readContext,contextBusy,rotateContext,now});this.busy=false;this.closed=false;this.launching=new Set();this.pendingStarts=new Map();
  }
  save(id,c){this.store.saveCampaign(id,c);this.changed(id);return c;}
  nextSourceAt(id){const enabled=this.store.sources(id).filter(source=>source.enabled);return enabled.length?Math.min(...enabled.map(source=>source.nextRunAt??0)):0;}
  async ensureRunning(id){
    // Queueing and enabling sources can overlap while a paused session closes.
    // Share the start so each candidate gets only one replacement session.
    let start=this.pendingStarts.get(id);
    if(!start){
      const c=this.store.campaign(id);
      start=Promise.resolve().then(()=>this.start(id,{target:c?.target??100,intervalMinutes:c?.intervalMinutes??30}));
      this.pendingStarts.set(id,start);
    }
    try{await start;}finally{if(this.pendingStarts.get(id)===start)this.pendingStarts.delete(id);}
  }
  async saveSource(id,source){
    const previous=source.id?this.store.source(id,source.id):null;
    const result=this.store.saveSource(id,source);this.changed(id);
    if(result.enabled&&!previous?.enabled)await this.ensureRunning(id);
    else await this.tick();
    return result;
  }
  startSettings(id,options={}){
    if(this.store.setup(id)&&this.store.setup(id).status!=='complete')throw Error('Önce aday setup tamamlanmalı');
    const previous=this.store.campaign(id),target=options.target??previous?.target??100,intervalMinutes=options.intervalMinutes??previous?.intervalMinutes??30;
    if(!Number.isInteger(target)||target<1||target>10000||!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)throw Error('Hedef 1–10000, tarama aralığı 1–1440 dakika olmalı');
    const submitted=uniqueJobCount(this.store.jobs(id),['submitted','already_submitted']);
    // An unfinished task must still be recoverable, especially after a send.
    if(submitted>=target&&(!previous?.task||previous.task.report)&&!hasManualApplicationWork(this.store,id,previous)&&!hasPreparationWork(this.store,id,previous))throw Error(`Başvuru hedefine ulaşıldı: ${submitted} başvuru gönderildi, hedef ${target}. Devam etmek için Başvurular → Başvuru hedefi değerini ${submitted} üzerinde bir sayıya yükselt.`);
    return {target,intervalMinutes};
  }
  async start(id,options={}){
    const {target,intervalMinutes}=this.startSettings(id,options);
    const previous=this.store.campaign(id);
    if(previous?.status==='running'){await this.tick();return this.store.campaign(id);}
    if(this.launching.has(id))throw Error('Önce devam eden başlatma işleminin bitmesini bekle');
    if(this.active(id)?.candidateId===id)await this.stop(id);
    this.store.restoreSourceSchedule(id);
    this.save(id,{...previous,status:'running',target,intervalMinutes,task:previous?.task?{...previous.task,report:null,seenWorking:false,recoveryAttempts:0,recovery:{readyAt:this.now(),reason:'User resumed the unfinished task'}}:null,nextSearchAt:this.nextSourceAt(id),wakeAt:0,failures:0,note:'Kampanya başlatıldı',attempts:previous?.attempts??{}});
    await this.tick();
    return this.store.campaign(id);
  }
  async pause(id,status='paused'){
    const c=this.store.campaign(id);if(!c)return;
    this.save(id,{...c,status,contextRestartRetry:null,note:status==='stopped'?'Kampanya durduruldu':'Kampanya duraklatıldı'});
    if(this.active(id)?.candidateId===id)await this.stop(id);
    if(!this.launching.has(id))this.save(id,{...this.store.campaign(id),task:null});
  }
  report(id,sessionId,{taskId,outcome,note,blocker,coverage}){
    const c=this.store.campaign(id);
    if(c?.status!=='running'||c.task?.id!==taskId||this.active(id)?.sessionId!==sessionId)throw Error('Etkin kampanya işi bulunamadı');
    if(!['done','no_results','blocked',...(c.task.kind==='search'?['partial']:[])].includes(outcome)||typeof note!=='string'||!note.trim())throw Error('Geçersiz iş sonucu');
    if(outcome==='partial'&&!coverage)throw Error('Kısmi tarama için devam noktası gerekli.');
    const checkedCoverage=c.task.kind==='search'&&coverage?sourceCoverage(coverage,{outcome}):null;
    if(c.task.kind==='search'&&checkedCoverage){const saved=this.store.source(id,c.task.sourceId).scanProgress;if(saved?.taskId!==taskId||JSON.stringify(sourceCoverage(saved,{outcome:saved.complete?'done':'partial'}))!==JSON.stringify(checkedCoverage))throw Error('Tarama kapsamı önce save_source_progress ile bu görevde kaydedilmeli.');}
    const report={outcome,note:note.slice(0,3000),...(blocker?{blocker}:{}),...(checkedCoverage?{coverage:checkedCoverage}:{})};
    try{validateTaskCompletion(this.store,id,c,report);}catch(error){c.task.completionError=error.message;this.save(id,c);throw error;}
    if(c.task.report){
      if(c.task.report.outcome===outcome)return c;
      if(c.task.report.outcome!=='blocked'||outcome!=='done')throw Error('Bu işin sonucu zaten kaydedildi; farklı bir sonuçla değiştirilemez.');
    }
    delete c.task.completionError;c.task.report=report;return this.save(id,c);
  }
  askCaptcha(id,sessionId,input){return this.askApplicationQuestion(id,sessionId,input);}
  askApplicationQuestion(id,sessionId,input){
    const c=this.store.campaign(id),job=this.store.job(id,input.jobId);
    if(c?.status!=='running'||!['application','preparation','verify'].includes(c.task?.kind)||c.task.jobId!==job.id||this.active(id)?.sessionId!==sessionId)throw Error('Soru etkin başvuruya ait olmalı.');
    if(job.followupStopped)throw Error('Başvuru takibi bırakıldı; yeni soru açma.');
    const replyAction=candidateReplyActions(job,this.store.questions(id)).find(a=>a.tool!=='defer_missing_documents');
    if(replyAction)throw Error(`Kullanıcının açık yanıtı zaten kayıtlı. Yeni teyit sorusu açma; ${replyAction.tool}(jobId,questionId) kullan. Yanıt kimliği: ${replyAction.questionId}`);
    if(job.sessionId&&job.sessionId!==sessionId)throw Error('İlan başka bir oturuma ait');
    let question;this.store.db.exec('BEGIN IMMEDIATE');
    try{
      if(job.status==='found')this.store.updateJob(id,job.id,'working','Başvurunun zorunlu alanları kontrol ediliyor',sessionId);
      question=this.store.ask(id,input,sessionId);
      const status=['submitting','uncertain'].includes(job.status)?'uncertain':'blocked';
      const note=('Engel: '+(input.applicationBlocker?.evidence?.trim()||input.question)).slice(0,3000);
      this.store.updateJob(id,job.id,status,note,sessionId);
      c.task.report={outcome:'blocked',note};c.task.seenWorking=true;
      validateTaskCompletion(this.store,id,c,c.task.report);
      delete c.task.recovery;delete c.task.completionError;
      this.store.saveCampaign(id,c);this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    this.changed(id);return {...question,completion:{taskReported:true,nextAction:'end_turn',message:'Soru, devam noktası, başvuru durumu ve görev sonucu birlikte kaydedildi. Ek checkpoint, durum veya rapor çağrısı yapma; turu bitir.'}};
  }
  stopApplicationFollowup(id,sessionId,{jobId,questionId}){
    const c=this.store.campaign(id);
    if(c?.status!=='running'||!['application','preparation','verify'].includes(c.task?.kind)||c.task.jobId!==jobId||this.active(id)?.sessionId!==sessionId)throw Error('Yalnızca etkin başvurunun takibi bırakılabilir.');
    let job;this.store.db.exec('BEGIN IMMEDIATE');
    try{
      job=this.store.stopApplicationFollowup(id,jobId,questionId,sessionId);
      c.task.report={outcome:'done',note:job.note};c.task.seenWorking=true;delete c.task.recovery;delete c.task.completionError;delete c.browserWait;
      for(const key of ['pendingRetries','pendingResumes','pendingRecoveries'])if(c[key])delete c[key][jobId];
      this.store.saveCampaign(id,c);this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    this.changed(id);return {...job,completion:{taskReported:true,nextAction:'end_turn',message:'Takip bırakıldı ve görev tamamlandı. Önceki gönderim kanıtı/belirsizliği korundu. Ek durum veya rapor çağrısı yapma.'}};
  }
  recordSubmission(id,sessionId,input){
    const c=this.store.campaign(id);
    const matches=c?.status==='running'&&['application','preparation','verify'].includes(c.task?.kind)&&c.task.jobId===input.jobId&&this.active(id)?.sessionId===sessionId;
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
  recordCandidateReply(id,sessionId,{jobId,questionId},tool){
    const c=this.store.campaign(id);
    if(c?.status!=='running'||!['application','preparation','verify'].includes(c.task?.kind)||c.task.jobId!==jobId||this.active(id)?.sessionId!==sessionId)throw Error('Kayıtlı yanıt yalnızca etkin başvuru görevinde işlenebilir.');
    let job;this.store.db.exec('BEGIN IMMEDIATE');
    try{
      job=this.store.recordCandidateReply(id,jobId,questionId,sessionId,tool);
      const report={outcome:tool==='record_candidate_submission'?'done':'blocked',note:job.note};
      validateTaskCompletion(this.store,id,c,report);
      c.task.report=report;c.task.seenWorking=true;delete c.task.recovery;delete c.task.completionError;delete c.browserWait;
      for(const key of ['pendingRetries','pendingResumes','pendingRecoveries'])if(c[key])delete c[key][jobId];
      this.store.saveCampaign(id,c);this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    this.changed(id);return {...job,completion:{taskId:c.task.id,taskReported:true,nextAction:'end_turn',message:'Kayıtlı aday yanıtı ve görev sonucu birlikte kaydedildi. Yeniden gönderme, yeni soru veya ek durum/rapor çağrısı yapma; turu bitir.'}};
  }
  recordValidationFailure(id,sessionId,input){
    const c=this.store.campaign(id);
    if(c?.status!=='running'||!['application','preparation','verify'].includes(c.task?.kind)||c.task.jobId!==input.jobId||this.active(id)?.sessionId!==sessionId)throw Error('Doğrulama hatası etkin başvuru görevine ait olmalı');
    const profile=this.store.profile(id),before=this.store.job(id,input.jobId),source=before.sourceId?this.store.source(id,before.sourceId):null;
    const mayPrepare=!c.task.verificationOnly&&(manualApplicationAuthorized(before,c.task)||profile.authorization!=='research'&&source?.applyMode!=='find_only');
    this.store.db.exec('BEGIN IMMEDIATE');
    let job;
    try{
      job=this.store.recordValidationFailure(id,input.jobId,input,sessionId);
      delete c.task.completionError;
      if(mayPrepare){c.task.kind='application';c.task.report=null;}
      else{c.task.kind='verify';c.task.report={outcome:'done',note:c.task.verificationOnly?'Gönderimin alan doğrulamasında engellendiği doğrulandı; yeniden gönderilmedi.':'Gönderim alan doğrulamasında engellendi; mevcut yetki yeni başvuruya izin vermiyor.'};}
      this.store.saveCampaign(id,c);this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    this.changed(id);
    return {...job,recovery:{taskKind:c.task.kind,nextAction:mayPrepare?'correct_fields_or_ask':'end_turn',message:mayPrepare?'Submission was prevented by field validation. Continue this same task: reuse known answers, ask all remaining required questions together, then follow working → prepared → submitting only within current permissions.':'Verification is complete. Current permissions do not allow form work; end this turn.'}};
  }
  delivery(id,state){
    const c=this.store.campaign(id);if(this.closed||c?.status!=='running'||!c.task||c.task.seenWorking)return;
    if(state==='Stalled'&&c.task.recovery?.deliveryRetry&&this.now()<c.task.recovery.readyAt)return;
    c.task.delivery=state;
    if(state==='Stalled'){
      const attempts=(c.task.deliveryRetryAttempts??0)+1;
      c.task.deliveryRetryAttempts=attempts;
      if(attempts<=6){
        c.task.recovery={readyAt:this.now()+20*60000,reason:'Agent sağlayıcısının geçici teslim sınırı sona erdi. Aynı işi kayıtlı durumdan sürdür; belirsiz gönderimi tekrarlama.',deliveryRetry:true};
        c.note='Agent sağlayıcısı geçici olarak görev alamıyor; aynı iş 20 dakika sonra otomatik yeniden denenecek.';
      }else{c.status='paused';c.note='Agent sağlayıcısına teslim 6 yeniden denemede başarısız oldu; terminali kontrol et.';}
    }else if(['Failed','Blocked','RequiresUserResubmit'].includes(state)){
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
  waitForBrowser(id,{requested=false}={}){
    const c=this.store.campaign(id);if(c?.status!=='running'||c.task?.report||c.task?.kind==='rank'&&!requested&&!c.task.requiresBrowser)return;
    if(c.task&&requested)c.task.requiresBrowser=true;
    if(c.browserWait)return;
    c.browserWait=true;c.note=this.active(id)?'Chrome bağlantısı bekleniyor; hazır olduğunda aynı iş sürdürülecek.':'Chrome izni ve bağlantısı bekleniyor. Agent henüz başlatılmadı.';
    if(c.task)c.task.recovery={readyAt:this.now(),reason:['application','preparation','verify'].includes(c.task.kind)?'Chrome reconnected. Resume the same task with resume_application; revalidate saved progress. Never repeat an uncertain submission.':'Chrome reconnected. Resume the same research task; do not fill or submit an application.',browser:true};
    this.save(id,c);
  }
  browserGate(id,c,task){
    // Even browserless tasks need approval before opening a new agent session.
    if(!this.active(id)){
      if(!this.browserReady(id).ready){this.waitForBrowser(id,{requested:true});return false;}
      return true;
    }
    if(task?.kind==='rank'&&!task.requiresBrowser)return true;
    if(['application','preparation','verify'].includes(task?.kind)&&candidateReplyActions(this.store.job(id,task.jobId),this.store.questions(id)).some(a=>a.tool!=='defer_missing_documents'||!task.retryRequestId))return true;
    if(task?.jobId&&this.store.job(id,task.jobId).followupStopped)return true;
    if(!this.browserReady(id).ready){this.waitForBrowser(id);return false;}
    return true;
  }
  async resumeTurn(id,c){
    let task=c.task,session=this.active(id);
    if(!task?.recovery||this.now()<task.recovery.readyAt)return;
    if(task.recovery.deliveryRetry&&session&&!['Idle','Interrupted'].includes(session.state)){
      await this.stop(id);
      const current=this.store.campaign(id);if(current?.status!=='running'||current.task?.id!==task.id)return;
      c=current;task=current.task;session=null;
      if(!task.recovery||this.now()<task.recovery.readyAt)return;
    }
    if(session&&!['Idle','Interrupted'].includes(session.state))return;
    if(!this.browserGate(id,c,task))return;
    delete c.browserWait;
    const source=task.sourceId?this.store.source(id,task.sourceId):null;
    const job=task.jobId?this.store.job(id,task.jobId):null;
    const reason=task.recovery.reason;
    delete task.recovery;task.createdAt=this.now();task.seenWorking=false;
    if(job&&['submitting','uncertain'].includes(job.status))task.kind='verify';
    this.save(id,{...c,task,note:'Kesilen görev kaldığı yerden sürdürülüyor'});
    this.launching.add(id);
    try{const prompt=recoveryPrompt({task,source,profile:this.store.profile(id),definition:this.store.workspaces.definition(id)},reason);if(session)await this.send(prompt,id);else await this.launch(id,prompt,task.kind==='rank'?null:task.jobId);}
    catch(error){const current=this.store.campaign(id);if(current?.status==='running'&&current.task?.id===task.id){if(error.code==='BROWSER_WAIT')this.waitForBrowser(id,{requested:true});else this.save(id,{...current,status:'paused',note:'Devam mesajının teslimi doğrulanamadı: '+error.message});}}
    finally{this.launching.delete(id);}
  }
  afterCompaction(id){
    const c=this.store.campaign(id);
    if(this.closed||c?.status!=='running'||!c.task||c.task.recovery||this.active(id)?.state!=='Idle')return;
    // The native command's Idle is separate from a provider work turn. Reconcile
    // the saved task once: validate its report, or resume an unfinished turn.
    // A recovery queued by the original Idle must not count as a second failure.
    if(c.task.seenWorking)this.signal(id,'Idle');
  }
  signal(id,state){
    if(this.closed)return;
    const c=this.store.campaign(id);if(c?.status!=='running'||!c.task)return;
    if(c.browserWait&&!c.task.report&&['Idle','Interrupted'].includes(state))return;
    if(state==='Working'||state==='Compacting'){c.task.seenWorking=true;c.note=c.task.kind==='search'?`${this.store.source(id,c.task.sourceId)?.name??'Kaynak'} taranıyor`:c.task.kind==='rank'?'Agent ilanı puanlıyor':c.task.kind==='preparation'?'Agent başvuru paketini hazırlıyor':'Agent başvuruyu işliyor';this.save(id,c);}
    else if(state==='Failed'){c.note='Agent hata bildirdi; oturum yeniden hazırlanıyor';this.save(id,c);this.stop(id).then(()=>this.exited(id)).catch(error=>this.save(id,{...this.store.campaign(id),status:'paused',note:error.message}));}
    else if(state==='Interrupted'){this.recoverTurn(id,c,'Terminal turn interrupted');}
    else if(state==='Idle'&&c.task.seenWorking){
      const task=c.task;
      if(!task.report){this.recoverTurn(id,c,task.completionError??'Turn ended without report_campaign_work');return;}
      try{validateTaskCompletion(this.store,id,c,task.report);}catch(error){task.report=null;this.recoverTurn(id,c,error.message);return;}
      if(task.jobId&&task.kind!=='rank'){
        if(task.retryRequestId&&c.pendingRetries?.[task.jobId]?.requestId===task.retryRequestId)delete c.pendingRetries[task.jobId];
        if(task.report&&task.recoveryQuestionId&&c.pendingRecoveries?.[task.jobId]===task.recoveryQuestionId)delete c.pendingRecoveries[task.jobId];
        if(task.report&&task.resumeQuestionId&&c.pendingResumes?.[task.jobId]===task.resumeQuestionId)delete c.pendingResumes[task.jobId];
        if(c.pendingResumes?.[task.jobId])delete c.attempts[task.jobId];else c.attempts[task.jobId]=this.now();
      }
      if(task.kind==='search'&&task.sourceId){const source=this.store.source(id,task.sourceId),found=Math.max(0,this.store.jobs(id).filter(j=>j.sourceId===task.sourceId).length-(task.jobsBefore??0)),nextRunAt=this.now()+(task.report?.outcome==='partial'?60000:source.intervalMinutes*60000);this.store.markSourceRun(id,source.id,{at:this.now(),nextRunAt,result:task.report?.note??'İş sonucu bildirilmedi',found,status:task.report?.outcome??'blocked',coverage:task.report?.coverage});c.nextSearchAt=this.nextSourceAt(id);}
      else if(task.kind==='search')c.nextSearchAt=this.now()+c.intervalMinutes*60000;
      const report=task.report;c.task=null;delete c.browserWait;
      c.contextBoundarySessionId=this.active(id)?.sessionId;
      if(!report){c.failures++;c.wakeAt=this.now()+Math.min(300000,10000*2**Math.min(c.failures,5));c.note='Tur bitti fakat iş sonucu bildirilmedi; kontrollü yeniden deneme bekliyor';}
      else{c.failures=0;c.wakeAt=0;c.note=report.note;if(report.outcome==='blocked'&&!task.jobId&&!task.sourceId)c.wakeAt=this.now()+c.intervalMinutes*60000;}
      this.save(id,c);
    }
  }
  exited(id){const c=this.store.campaign(id);if(c?.status!=='running')return;if(c.browserWait&&c.task||c.task?.recovery?.deliveryRetry)return;if(c.task){this.recoverTurn(id,c,'Agent session closed before task completion; inspect saved outcome and resume the same task');return;}c.failures++;c.wakeAt=this.now()+Math.min(300000,10000*2**Math.min(c.failures,5));c.note='Agent kapandı; kayıtlı durumdan yeniden başlatılacak';if(c.failures>=5){c.status='paused';c.note='Agent beş kez açılamadı veya kapandı. Hatayı düzelttikten sonra Başlat ile devam edebilirsin.';}this.save(id,c);}
  answered(id,questionId){const c=this.store.campaign(id);if(!c)return;const q=this.store.questions(id).find(q=>q.id===questionId);if(!q||q.answer===null)return;c.wakeAt=0;if(q.jobId){c.pendingResumes??={};c.pendingResumes[q.jobId]=questionId;delete c.attempts[q.jobId];}this.save(id,c);}
  async continueAfterAnswer(id,questionId){
    this.answered(id,questionId);
    const q=this.store.questions(id).find(q=>q.id===questionId),c=this.store.campaign(id);
    if(!q||q.answer===null||!c||this.store.setup(id)?.status&&this.store.setup(id).status!=='complete')return {delivery:'saved',message:'Yanıt kaydedildi.'};
    try{await this.ensureRunning(id);}
    catch(error){return {delivery:'saved',message:'Yanıt kaydedildi, ancak agent devam edemedi: '+error.message};}
    const current=this.store.campaign(id);
    if(current.status!=='running'||current.browserWait||current.failures||current.waitingReason)return {delivery:'saved',message:'Yanıt kaydedildi. '+current.note};
    return {delivery:'queued',message:'Yanıt kaydedildi. Agent mevcut işinden sonra yanıtlanan başvuruyu işleyecek.'};
  }
  recheckLegacyFormQuestions(id){
    let c=this.store.campaign(id);if(!c||c.formVerificationMigration===1)return;
    for(const q of this.store.questions(id)){
      if(q.answer!==null||!q.jobId||q.applicationBlocker?.recovery?.kind!=='form_entry'||q.applicationBlocker.recovery.visualCheck)continue;
      if(['submitted','already_submitted','skipped'].includes(this.store.job(id,q.jobId).status))continue;
      this.recoverQuestion(id,q.id);
    }
    c=this.store.campaign(id);c.formVerificationMigration=1;this.save(id,c);
  }
  recheckPendingVerifications(id){
    let c=this.store.campaign(id);if(!c||c.verificationRecoveryMigration===1)return;
    const questions=this.store.questions(id),queued=new Set();
    // Older verify turns could ask the user to create an internal task after
    // their verification reply. Reinspect once; never invent a new answer.
    for(const q of questions){
      if(q.answer!==null||!q.jobId||queued.has(q.jobId)||q.applicationBlocker?.kind!=='access'||q.applicationBlocker.recovery?.kind!=='user_only')continue;
      if(this.store.job(id,q.jobId).status!=='uncertain'||!questions.some(a=>a.jobId===q.jobId&&a.answer!==null&&a.applicationBlocker?.kind==='access'))continue;
      this.recoverQuestion(id,q.id);queued.add(q.jobId);
    }
    c=this.store.campaign(id);c.verificationRecoveryMigration=1;this.save(id,c);
  }
  recoverQuestion(id,questionId){
    const q=this.store.questions(id).find(q=>q.id===questionId);
    if(!q?.jobId||q.answer!==null)throw Error('Kurtarılacak açık başvuru sorusu bulunamadı');
    const job=this.store.job(id,q.jobId);if(['submitted','already_submitted','skipped'].includes(job.status))throw Error('Tamamlanmış başvuru yeniden başlatılamaz');
    if(job.followupStopped)throw Error('Kullanıcı bu başvurunun takibini bıraktı.');
    const c=this.store.campaign(id)??{status:'paused',target:100,intervalMinutes:30,task:null,attempts:{},failures:0};
    c.pendingResumes??={};c.pendingResumes[q.jobId]=questionId;c.pendingRecoveries??={};c.pendingRecoveries[q.jobId]=questionId;
    if(c.task?.jobId===q.jobId&&!c.task.report){c.task.recoveryQuestionId=questionId;c.task.resumeQuestionId=questionId;}
    c.attempts??={};delete c.attempts[q.jobId];c.wakeAt=0;this.save(id,c);
    return{queued:true,message:c.status==='running'?'Sekme ve form kontrolü sıraya alındı. Agent mevcut işini bitirince bu başvuruya dönecek.':'Sekme ve form kontrolü sıraya alındı. Agent’ı başlatınca devam edecek.'};
  }
  async retryQuestion(id,questionId){
    const q=this.store.questions(id).find(q=>q.id===questionId);
    if(!q?.jobId||q.answer!==null)throw Error('Yeniden denenecek açık başvuru sorusu bulunamadı');
    const job=this.store.job(id,q.jobId);
    if(job.duplicateApplication)throw Error(job.duplicateApplication.reason);
    if(!preparationHeld(job))this.queueApplication(id,job.id,{verification:true});
    const current=this.store.campaign(id);
    if(current?.status==='running'&&current.task?.jobId===job.id&&!current.task.report){this.recoverQuestion(id,questionId);return{queued:false,active:true,message:'Agent bu başvuruyu zaten kontrol ediyor.'};}
    const result=this.recoverQuestion(id,questionId);
    try{await this.ensureRunning(id);}
    catch(error){return{...result,message:'Başvuru sıraya alındı, ancak agent başlatılamadı: '+error.message};}
    const c=this.store.campaign(id);
    const message=c.status!=='running'||c.browserWait||c.failures||c.waitingReason?c.note:c.task?.jobId===job.id?'Agent başvuruyu yeniden kontrol ediyor.':'Agent mevcut işinden sonra bu başvuruyu tekrar deneyecek.';
    return{...result,message};
  }
  recheckBrowserQuestions(id){
    if(!this.store.campaign(id))return;
    const queued=new Set();
    for(const q of this.store.questions(id)){
      const blocker=q.applicationBlocker,evidence=blocker?.evidence??'';
      if(q.answer!==null||!q.jobId||queued.has(q.jobId)||blocker?.kind!=='access'||blocker.recovery?.kind!=='user_only')continue;
      if(!/Chrome bağlantı/i.test(evidence)||!/zaman aşım|bağlantı izni/i.test(evidence))continue;
      if(['submitted','already_submitted','skipped'].includes(this.store.job(id,q.jobId).status))continue;
      // Queue a fresh check, never manufacture an answer or dismiss site MFA.
      this.recoverQuestion(id,q.id);queued.add(q.jobId);
    }
  }
  queueApplication(id,jobId,{verification=false,repeatUncertain=false}={}){
    let job=this.store.job(id,jobId);
    if(job.duplicateApplication&&!(repeatUncertain&&job.duplicateApplication.status==='uncertain'&&job.retryAuthorization?.kind==='uncertain_submission'))throw Error(job.duplicateApplication.reason);
    if(job.followupStopped)throw Error('Kullanıcı bu başvurunun takibini bıraktı.');
    const c=this.store.campaign(id)??{status:'paused',target:100,intervalMinutes:30,task:null,attempts:{},failures:0};
    if(this.store.workerTasks(id).some(w=>w.task.jobId===jobId&&!w.task.report&&w.task.kind!=='rank'))return {queued:false,active:true,message:'Agent bu ilanı zaten işliyor.'};
    if(c.status==='running'&&c.task?.jobId===jobId&&!c.task.report&&c.task.kind!=='rank')return {queued:false,active:true,message:'Agent bu başvuruyu zaten işliyor.'};
    if(repeatUncertain){
      if(job.status==='uncertain'){
        const authorizedAt=new Date().toISOString();
        job=this.store.saveJob({...job,status:'blocked',sessionId:null,
          priorSubmissionAttempts:[...(job.priorSubmissionAttempts??[]),{at:authorizedAt,note:job.note,resumeContext:job.resumeContext??null,proof:job.proof??null}],
          retryAuthorization:{kind:'uncertain_submission',authorizedAt,reason:'Kullanıcı olası çift başvuru riskini kabul etti.'},
          note:'Önceki gönderim sonucu belirsiz; kullanıcı olası çift başvuru riskini kabul ederek yeniden deneme izni verdi.',
          resumeContext:null,browserProgress:null,verificationContinuation:null},'uncertain_submission_retry_authorized');
      }else if(job.status!=='blocked'||job.retryAuthorization?.kind!=='uncertain_submission'||!job.priorSubmissionAttempts?.length)throw Error('Yalnızca sonucu belirsiz başvuru açık tekrar izniyle yeniden gönderilebilir.');
    }
    if(!['found','blocked','prepared','uncertain',...(verification?['submitting']:[])].includes(job.status))throw Error('Yalnızca yeni veya bilgi / işlem bekleyen başvurular sıraya alınabilir.');
    c.pendingRetries??={};
    const verificationOnly=['uncertain','submitting'].includes(job.status),previous=c.pendingRetries[jobId];
    const existing=previous&&Boolean(previous.verificationOnly)===verificationOnly?previous:null;
    const request=c.pendingRetries[jobId]=existing??{requestId:randomUUID(),queuedAt:Math.max(this.now(),...Object.values(c.pendingRetries).map(r=>(r.queuedAt??0)+1)),...(verificationOnly?{verificationOnly:true}:{}),...(repeatUncertain?{repeatUncertain:true}:{})};
    this.store.saveJob({...job,manualApplication:{...request},...(job.preparation?{preparation:{...job.preparation,hold:false,releasedAt:new Date().toISOString()}}:{})},'manual_application_requested');
    if(c.status!=='running'&&c.task?.jobId===jobId&&!c.task.report&&c.task.kind!=='rank')Object.assign(c.task,{retryRequestId:request.requestId,manualRequestId:request.requestId,verificationOnly,applyMode:verificationOnly?'prepare':'auto',...(verificationOnly?{kind:'verify'}:{})});
    c.attempts??={};delete c.attempts[jobId];c.wakeAt=0;
    this.save(id,c);
    return {queued:true,alreadyQueued:Boolean(existing),requestId:request.requestId,verificationOnly,message:verificationOnly?'Başvuru öncelikli doğrulama sırasına alındı. Mevcut sonuç kontrol edilecek; yeniden gönderilmeyecek.':'İlan öncelikli başvuru sırasına alındı. Kaynak modu, puan ve başvuru hedefi bu ilanı durdurmayacak.'};
  }
  async queueAndStartApplication(id,jobId){
    const result=this.queueApplication(id,jobId);
    if(result.active)return result;
    try{await this.ensureRunning(id);}
    catch(error){return {...result,message:'İlan sıraya alındı, ancak agent başlatılamadı: '+error.message};}
    const c=this.store.campaign(id);
    const message=c.status!=='running'||c.browserWait||c.failures||c.waitingReason?c.note:c.task?.jobId===jobId?(c.task.seenWorking?'Agent ilanı yeniden kontrol ediyor.':'Agent’ın başlaması bekleniyor.'):'Agent mevcut işinden sonra yeniden kontrol edecek.';
    return {...result,message:(result.verificationOnly?'Başvuru öncelikli doğrulama sırasına alındı. ':'İlan sıraya alındı. ')+message};
  }
  queuePreparation(id,jobId){
    const job=this.store.job(id,jobId);
    if(job.duplicateApplication||job.followupStopped||!['found','blocked','prepared'].includes(job.status))throw Error('Yalnızca tamamlanmamış ve gönderimi başlamamış ilanlar hazırlanabilir.');
    if(this.store.workerState.tasks(id).some(w=>w.task.jobId===jobId&&!w.task.report&&w.task.kind!=='rank'))return {active:true,message:'Agent bu ilanı zaten işliyor.'};
    if(preparationHeld(job)&&job.preparation.status==='queued')return {queued:true,message:'İlan zaten hazırlık sırasında.'};
    const c=this.store.campaign(id)??{status:'paused',target:100,intervalMinutes:30,task:null,attempts:{},failures:0};
    const preparation={...job.preparation,requestId:randomUUID(),queuedAt:this.now(),hold:true,status:'queued',revision:(job.preparation?.revision??0)+1,requirements:job.preparation?.requirements??[]};
    // A finished provider turn may not have emitted Idle yet. Its old done
    // report must not validate the newly queued revision as its own package.
    if(c.task?.jobId===jobId&&c.task.report)c.task=null;
    this.store.saveJob({...job,manualApplication:null,preparation,...(job.status==='prepared'?{status:'found',sessionId:null}:{}),note:'Başvuru paketi hazırlık sırasında.'},'preparation_requested');
    for(const key of ['pendingRetries','pendingResumes','pendingRecoveries','attempts'])if(c[key])delete c[key][jobId];
    c.wakeAt=0;this.save(id,c);
    return {queued:true,message:'İlan hazırlık sırasına alındı. Belgeler ve cevaplar hazırlanacak.'};
  }
  async queueAndStartPreparation(id,jobId){
    const result=this.queuePreparation(id,jobId);if(result.active)return result;
    try{await this.ensureRunning(id);}catch(error){return {...result,message:'Hazırlık sıraya alındı, ancak agent başlatılamadı: '+error.message};}
    return result;
  }
  choose(id,c){
    const p=this.store.profile(id),allJobs=this.store.jobs(id),questions=this.store.questions(id);
    const reservations=this.store.workerTasks?.(id)??[],reservedJobs=new Set(reservations.map(w=>w.task.jobId?this.store.canonicalJobId(id,w.task.jobId):null).filter(Boolean)),searchTasks=new Set(reservations.filter(w=>w.task.kind==='search').map(w=>w.task.id));
    // Drafts saved before worker support used the main Chrome profile.
    const browserOwner=j=>j.browserWorkerId??(p.browserMode==='separate'&&(j.resumeContext||['working','prepared','blocked','submitting','uncertain'].includes(j.status))?'main':null);
    const jobs=allJobs.filter(j=>!reservedJobs.has(j.canonicalJobId??j.id)&&!searchTasks.has(j.discoveryTaskId)&&(!browserOwner(j)||browserOwner(j)===(this.store.workerId??'main')));
    const reservedSends=new Set([...allJobs.filter(j=>['submitting','uncertain'].includes(j.status)).map(j=>j.canonicalJobId??j.id),...reservations.filter(w=>w.task.kind==='application'&&w.task.applyMode==='auto'&&!['submitted','already_submitted','skipped'].includes(allJobs.find(j=>j.id===w.task.jobId)?.status)).map(w=>this.store.canonicalJobId(id,w.task.jobId))]);
    const atCapacity=p.authorization==='submit'&&new Set([...allJobs.filter(j=>['submitted','already_submitted'].includes(j.status)).map(j=>j.canonicalJobId??j.id),...reservedSends]).size>=c.target;
    const targetReached=uniqueJobCount(allJobs,['submitted','already_submitted'])>=c.target;
    const ordered=jobs.slice().reverse().sort((a,b)=>{
      const pa=preparationHeld(a)&&a.preparation.status==='queued',pb=preparationHeld(b)&&b.preparation.status==='queued';
      if(pa||pb)return pa&&pb?a.preparation.queuedAt-b.preparation.queuedAt:pa?-1:1;
      if(a.manualApplication||b.manualApplication){if(!a.manualApplication)return 1;if(!b.manualApplication)return -1;return a.manualApplication.queuedAt-b.manualApplication.queuedAt;}
      const priority=j=>j.status==='uncertain'?3:(c.pendingRetries?.[j.id]||c.pendingResumes?.[j.id])?2:['working','prepared'].includes(j.status)?1:0;
      return priority(b)-priority(a)||(b.rank?.score??-1)-(a.rank?.score??-1);
    });
    for(const j of ordered){
      if(j.followupStopped||j.duplicateApplication&&!uncertainRetryPeerAllowed(j,{...j.manualApplication,jobId:j.id,kind:'application',manualRequestId:j.manualApplication?.requestId,repeatUncertain:c.pendingRetries?.[j.id]?.repeatUncertain}))continue;
      if(preparationHeld(j)){
        if(['submitted','already_submitted','skipped','submitting','uncertain'].includes(j.status))continue;
        const pending=c.pendingResumes?.[j.id]||c.pendingRecoveries?.[j.id],queued=j.preparation.status==='queued';
        if(questions.some(q=>q.jobId===j.id&&q.answer===null)&&!queued&&!c.pendingRecoveries?.[j.id])continue;
        if(queued||pending||['inspecting','drafting'].includes(j.preparation.status)&&(!c.attempts[j.id]||Date.parse(j.updatedAt)>c.attempts[j.id]))return {kind:'preparation',jobId:j.id,sourceId:j.sourceId??null,applyMode:'prepare',preparationRequestId:j.preparation.requestId,resumeQuestionId:c.pendingResumes?.[j.id]??null,recoveryQuestionId:c.pendingRecoveries?.[j.id]??null};
        continue;
      }
      const manual=j.manualApplication?.verificationOnly&&j.status!=='uncertain'?null:j.manualApplication;
      if(targetReached&&!manual)continue;
      if(j.missingDocuments&&!c.pendingRetries?.[j.id]&&!c.pendingResumes?.[j.id])continue;
      const source=j.sourceId?this.store.source(id,j.sourceId):null;
      const replyAction=candidateReplyActions(j,questions)[0];
      // Accounting for a saved answer needs neither a new form nor current
      // submission permission, and must not be blocked by a duplicate question.
      if(replyAction&&(replyAction.tool!=='defer_missing_documents'||!c.pendingRetries?.[j.id]))return{kind:replyAction.tool==='record_candidate_submission'?'verify':'application',jobId:j.id,sourceId:j.sourceId??null,applyMode:'prepare',verificationOnly:Boolean(manual?.verificationOnly),manualRequestId:manual?.requestId,retryRequestId:c.pendingRetries?.[j.id]?.requestId,resumeQuestionId:replyAction.questionId};
      // Permission changes stop new applications, not verification of an earlier submission.
      if(!manual&&j.status!=='uncertain'&&(p.authorization==='research'||source?.applyMode==='find_only'))continue;
      const unanswered=questions.some(q=>q.jobId===j.id&&q.answer===null);if(unanswered&&!c.pendingRecoveries?.[j.id]&&!c.pendingRetries?.[j.id])continue;
      const answered=questions.some(q=>q.jobId===j.id&&q.answer!==null);
      const maySubmit=Boolean(manual)||p.authorization==='submit'&&(!source||source.applyMode==='auto');
      if(!manual&&atCapacity&&maySubmit&&!['submitting','uncertain'].includes(j.status))continue;
      const eligible=['found','working','uncertain'].includes(j.status)||(j.status==='prepared'&&maySubmit)||(j.status==='blocked'&&(c.pendingRetries?.[j.id]||answered||c.pendingRecoveries?.[j.id]||j.note.startsWith('Oturum kapandı.')));
      const ranking=rankDecision(p,j);
      if(!manual&&eligible&&j.status!=='uncertain'&&ranking.state==='pending'&&(c.pendingRetries?.[j.id]||c.pendingResumes?.[j.id]||['working','prepared'].includes(j.status)))return{kind:'rank',jobId:j.id,sourceId:j.sourceId??null};
      if(!manual&&j.status!=='uncertain'&&!ranking.eligible)continue;
      if(eligible&&(c.pendingRetries?.[j.id]||c.pendingResumes?.[j.id]||(j.status==='prepared'&&maySubmit)||!c.attempts[j.id]||Date.parse(j.updatedAt)>c.attempts[j.id])){
        if(!manual&&!maySubmit&&j.status!=='uncertain'){
          const preparation={requestId:randomUUID(),queuedAt:this.now(),hold:true,status:'queued',revision:1,requirements:[]};
          this.store.saveJob({...j,preparation},'preparation_requested');
          return {kind:'preparation',jobId:j.id,sourceId:j.sourceId??null,applyMode:'prepare',preparationRequestId:preparation.requestId,resumeQuestionId:c.pendingResumes?.[j.id]??null,recoveryQuestionId:c.pendingRecoveries?.[j.id]??null};
        }
        return{verificationOnly:Boolean(manual?.verificationOnly),repeatUncertain:Boolean(manual?.repeatUncertain),manualRequestId:manual?.requestId,retryRequestId:c.pendingRetries?.[j.id]?.requestId??null,recoveryQuestionId:c.pendingRecoveries?.[j.id]??null,resumeQuestionId:c.pendingResumes?.[j.id]??null,kind:j.status==='uncertain'?'verify':'application',jobId:j.id,sourceId:j.sourceId??null,applyMode:manual?(manual.verificationOnly?'prepare':'auto'):source?.applyMode??(maySubmit?'auto':'prepare')};
      }
    }
    if(targetReached)return null;
    const reservedSources=new Set(reservations.filter(w=>w.task.kind==='search').map(w=>w.task.sourceId));
    const sourceOwner=source=>source.resumeContext?.workerId??(p.browserMode==='separate'&&source.resumeContext?'main':null);
    const dueSources=this.store.sources(id).filter(source=>!reservedSources.has(source.id)&&(!sourceOwner(source)||sourceOwner(source)===(this.store.workerId??'main'))&&source.enabled&&(source.nextRunAt??0)<=this.now()).sort((a,b)=>(a.nextRunAt??0)-(b.nextRunAt??0));
    const partial=dueSources.find(source=>source.lastStatus==='partial'&&source.scanProgress);
    if(partial)return{kind:'search',sourceId:partial.id,jobsBefore:allJobs.filter(job=>job.sourceId===partial.id).length};
    // Score only listings without a saved assessment; profile changes do not invalidate scores.
    // Ranking never owns the form and never changes application status or its checkpoint.
    const unranked=ordered.find(j=>!preparationHeld(j)&&(!j.manualApplication||j.manualApplication.verificationOnly)&&!['submitted','already_submitted','skipped','uncertain','submitting'].includes(j.status)&&rankDecision(p,j).state==='pending');
    if(unranked)return{kind:'rank',jobId:unranked.id,sourceId:unranked.sourceId??null};
    const due=dueSources[0];
    if(due)return{kind:'search',sourceId:due.id,jobsBefore:allJobs.filter(j=>j.sourceId===due.id).length};
    c.nextSearchAt=this.nextSourceAt(id);
    return null;
  }
  async tick(){
    if(this.busy||this.closed)return;this.busy=true;
    try{for(const p of this.store.candidates()){
      if(this.store.setup(p.id)&&this.store.setup(p.id).status!=='complete')continue;
      let c=this.store.campaign(p.id);if(c?.status!=='running')continue;
      const observedSession=this.active(p.id);
      const usage=observedSession?await this.readContext(p.id,observedSession):null;
      c=this.store.campaign(p.id);
      if(this.closed||c?.status!=='running'||this.active(p.id)?.sessionId!==observedSession?.sessionId||this.contextBusy(p.id))continue;
      if(c.task){
        if(!c.task.report&&!this.browserGate(p.id,c,c.task))continue;
        c=this.store.campaign(p.id);
        if(c.task.recovery){await this.resumeTurn(p.id,c);continue;}
        if(!c.task.seenWorking&&!this.launching.has(p.id)&&this.now()-c.task.createdAt>90000){
          if(c.task.delivery==='Stalled'&&(c.task.deliveryRetryAttempts??0)<=6){
            c.task.recovery={readyAt:this.now()+20*60000,reason:'Sağlayıcı önceki turu başlatamadı; aynı görevi kayıtlı durumdan sürdür.',deliveryRetry:true};
            c.note='Agent sağlayıcısı geçici olarak görev alamıyor; aynı iş 20 dakika sonra otomatik yeniden denenecek.';
            this.save(p.id,c);
          }else this.save(p.id,{...c,status:'paused',note:'Görev için 90 saniye içinde çalışma başlangıcı doğrulanamadı. Çift gönderimi önlemek için duraklatıldı; terminali kontrol edip Başlat ile devam edebilirsin.'});
        }
        continue;
      }
      const session=this.active(p.id);if(session?.state&&session.state!=='Idle')continue;
      const threshold=this.store.profile(p.id).agentSettings.contextRestartPercent??0;
      const retry=c.contextRestartRetry;
      if(retry||(threshold>0&&session?.state==='Idle'&&c.contextBoundarySessionId===session.sessionId)){
        if(retry&&this.now()<retry.readyAt)continue;
        if(!retry&&usage?.pending)continue;
        if(retry||usage?.peakPercent>=threshold){
          this.launching.add(p.id);
          const renewal=retry??{session:{provider:session.provider,sessionId:session.sessionId},usage:{percent:usage.percent,peakPercent:usage.peakPercent},threshold,failures:0};
          try{await this.rotateContext(p.id,renewal.session,renewal.usage,renewal.threshold);}
          catch(error){
            const current=this.store.campaign(p.id);
            if(current?.status==='running'){
              const failures=renewal.failures+1,delays=[5000,15000,30000];
              this.save(p.id,{...current,contextRestartRetry:{...renewal,failures,readyAt:this.now()+(delays[failures-1]??0)},
                ...(failures>delays.length?{status:'paused',note:'Context yenileme 3 yeniden denemeden sonra başarısız: '+error.message}:{note:`Context yenilenemedi; ${delays[failures-1]/1000} saniye sonra yeniden denenecek (${failures}/3): ${error.message}`})});
            }
            continue;
          }
          finally{this.launching.delete(p.id);}
          c=this.store.campaign(p.id);
          if(this.closed||c?.status!=='running'||c.task)continue;
          delete c.contextRestartRetry;delete c.contextBoundarySessionId;this.save(p.id,c);
        }
      }
      if(this.now()<c.wakeAt)continue;
      const previousNext=c.nextSearchAt,chosen=this.choose(p.id,c);if(!chosen){
        if(uniqueJobCount(this.store.jobs(p.id),['submitted','already_submitted'])>=c.target){this.save(p.id,{...c,status:'complete',note:'Başvuru hedefine ulaşıldı; işlenebilir öncelikli başvuru kalmadı.'});continue;}
        const sources=this.store.sources(p.id),findOnly=new Set(sources.filter(s=>s.applyMode==='find_only').map(s=>s.id));
        const held=this.store.jobs(p.id).filter(j=>j.status==='found'&&findOnly.has(j.sourceId)).length;
        const waitingReason=held?'source_apply_mode':sources.some(source=>source.enabled)?'source_schedule':'no_enabled_sources';
        const note=held?`${held} ilan kaynakların “Sadece bul” ayarı nedeniyle başvuruya alınmıyor. Sources → Başvuru modu ayarını değiştir.`:waitingReason==='no_enabled_sources'?'Şu anda puan, yetki ve bekleyen yanıt koşullarını karşılayan başvuru yok; yeni ilan taramaları da kapalı. Başvurular tablosundaki durumları veya Sources ayarlarını kontrol et.':'Şu anda işlenebilir başvuru yok; sonraki kaynak taraması bekleniyor.';
        if(c.waitingReason!==waitingReason||c.note!==note||previousNext!==c.nextSearchAt)this.save(p.id,{...c,waitingReason,note});
        continue;
      }
      if(!this.browserGate(p.id,c,chosen))continue;
      delete c.browserWait;delete c.waitingReason;delete c.contextBoundarySessionId;
      const task={...chosen,id:randomUUID(),seenWorking:false,report:null,createdAt:this.now()};c.task=task;this.save(p.id,c);
      const source=task.sourceId?this.store.source(p.id,task.sourceId):null;
      const prompt=campaignPrompt({task,source,profile:this.store.profile(p.id),definition:this.store.workspaces.definition(p.id)});
      this.launching.add(p.id);
      try{
        if(!this.active(p.id))await this.launch(p.id,prompt,task.kind==='rank'?null:task.jobId);
        else{if(task.jobId&&task.kind!=='rank'){const j=this.store.job(p.id,task.jobId);if(['blocked','uncertain'].includes(j.status)&&j.sessionId!==this.active(p.id).sessionId)this.store.reclaim(p.id,j.id,this.active(p.id).sessionId);}await this.send(prompt,p.id);}
        // A stop/pause may arrive while launch was in flight.
        if(this.store.campaign(p.id)?.status!=='running'){if(this.active(p.id)?.candidateId===p.id)await this.stop(p.id);continue;}
        if(task.jobId&&task.kind!=='rank'){const job=this.store.job(p.id,task.jobId);if(['blocked','uncertain'].includes(job.status)&&job.sessionId!==this.active(p.id)?.sessionId)this.store.reclaim(p.id,job.id,this.active(p.id).sessionId);}
        const delivered=this.store.campaign(p.id);
        if(delivered?.status==='running'&&delivered.task?.id===task.id){
          const job=task.jobId?this.store.job(p.id,task.jobId):null;
          const note=delivered.task.seenWorking?(task.kind==='search'&&source?`${source.name} taranıyor`:job?`${job.company} · ${job.role} işleniyor`:'Agent görevi işliyor'):'Görev kuyrukta; agentın başlaması bekleniyor';
          this.save(p.id,{...delivered,note});
        }
      }catch(error){c=this.store.campaign(p.id);if(c?.status==='running'){if(error.code==='BROWSER_WAIT'){this.waitForBrowser(p.id,{requested:true});continue;}c.task=null;c.failures++;if(this.active(p.id)){c.status='paused';c.note='Mesaj teslimi doğrulanamadı. Çift iş göndermemek için duraklatıldı: '+error.message;}else{c.wakeAt=this.now()+Math.min(300000,10000*2**Math.min(c.failures,5));c.note=error.message;if(c.failures>=5){c.status='paused';c.note='Tekrarlanan başlatma hatası: '+error.message;}}this.save(p.id,c);}}finally{this.launching.delete(p.id);const current=this.store.campaign(p.id);if(current&&['paused','stopped'].includes(current.status)&&current.task?.id===task.id&&!this.active(p.id))this.save(p.id,{...current,task:null});}
      break;
    }}finally{this.busy=false;}
  }
}
