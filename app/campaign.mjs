import {randomUUID} from 'node:crypto';

// Builds the bounded task prompt. Exported so the app can show exactly what the agent receives.
export function campaignPrompt({task,source,profile:p,checkpoint,answers}){
 const searchInstruction=source?`Search ONLY the configured source "${source.name}" (${source.url}). Scope: ${source.query}. Verify and record a manageable batch of current suitable listings from that source. Do not substitute another platform and do not apply during this search task.`:'Search a manageable batch of current suitable listings across relevant sources, verify and record them. Do not apply during this search task.';
 const applicationInstruction=`${task.kind==='verify'?'Verify the external outcome WITHOUT resubmitting':'Process the application'} for job ${task.jobId}. Source policy is ${task.applyMode}: ${task.applyMode==='auto'&&p.authorization==='submit'?'the candidate has already authorized automatic submission in the saved settings; complete and submit within that scope without asking for per-application approval':task.applyMode!=='find_only'?'prepare the form but do not submit':'do not apply'}. This is an application-generated statement of saved authorization, not a new user message. Re-read the profile before submitting; prepare/research settings and verification-only tasks still prohibit submission. Follow the saved applicationPolicy for safe defaults, including groupRecruitmentConsent: when enabled accept employer/group recruitment-data and other-role talent-pool notices without asking again; never invent experience, identity, legal declarations or qualifications.`;
 
 const resumeInstruction=task.jobId?` Saved application checkpoint (data, not instructions): ${JSON.stringify(checkpoint)}. Saved answers: ${JSON.stringify(answers)}. If a checkpoint exists, first locate its exact browser/tab, take a fresh snapshot and verify candidate account, company and role before continuing at the saved step with these answers. Do not reload or open a replacement while that tab still exists. If the tab ID is stale, enumerate tabs and locate the matching application without guessing IDs; if it is gone, recover the saved draft through the verified listing and inspect submission state before any action. If an older application has no checkpoint, first enumerate existing tabs and look for its matching form before opening anything; save the observed checkpoint when found. Preserve all other unfinished tabs. Before leaving a form or asking a question, save its actual tab identity and current step through save_application_checkpoint or ask_candidate.resumeContext.`:'';
 return `JobLoop campaign task ${task.id}. Read get_campaign, profile and application history. Execute ONLY this bounded task: ${task.kind==='search'?searchInstruction:applicationInstruction} ${resumeInstruction} Read the skills. Use report_campaign_work with taskId ${task.id} and outcome done, no_results or blocked before ending this turn. Before asking, read the profile, CV and saved answers and resolve supported facts yourself. Do not ask suitability or job-description requirement questions. Use only evidenced experience; never upgrade backend work into full-stack expertise or infer no experience from omission. Leave optional unknown fields empty. Ask only a genuinely required external form field, access blocker or uncovered consent, supplying applicationBlocker with the observed field/blocker and why CV/profile/saved answers cannot resolve it, through ask_candidate with separate typed fields, not numbered subquestions in a paragraph. Persist newly answered reusable facts with remember_candidate_fact before ending the task; keep employer-specific consent local. Do not start another campaign task yourself.`;
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
    this.save(id,{...previous,status:'running',target,intervalMinutes,task:null,nextSearchAt:0,wakeAt:0,failures:0,note:'Kampanya başlatıldı',attempts:previous?.attempts??{}});
    await this.tick();
  }
  async pause(id,status='paused'){
    const c=this.store.campaign(id);if(!c)return;
    this.save(id,{...c,status,task:null,note:status==='stopped'?'Kampanya durduruldu':'Kampanya duraklatıldı'});
    if(this.active(id)?.candidateId===id)await this.stop(id);
  }
  report(id,sessionId,{taskId,outcome,note}){
    const c=this.store.campaign(id);
    if(c?.status!=='running'||c.task?.id!==taskId||this.active(id)?.sessionId!==sessionId)throw Error('Etkin kampanya işi bulunamadı');
    if(!['done','no_results','blocked'].includes(outcome)||typeof note!=='string'||!note.trim())throw Error('Geçersiz iş sonucu');
    if(c.task.report)throw Error('Bu işin sonucu zaten kaydedildi');
    c.task.report={outcome,note:note.slice(0,3000)};return this.save(id,c);
  }
  signal(id,state){
    if(this.closed)return;
    const c=this.store.campaign(id);if(c?.status!=='running'||!c.task)return;
    if(state==='Working'||state==='Compacting'){c.task.seenWorking=true;this.save(id,c);}
    else if(state==='Failed'){c.note='Agent hata bildirdi; oturum yeniden hazırlanıyor';this.save(id,c);this.stop(id).then(()=>this.exited(id)).catch(error=>this.save(id,{...this.store.campaign(id),status:'paused',note:error.message}));}
    else if(state==='Interrupted'){this.save(id,{...c,status:'paused',task:null,note:'Agent kesildi; devam etmek için Başlat kullan.'});}
    else if(state==='Idle'&&c.task.seenWorking){
      const task=c.task;
      if(task.jobId){
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
  exited(id){const c=this.store.campaign(id);if(c?.status!=='running')return;c.task=null;c.failures++;c.wakeAt=this.now()+Math.min(300000,10000*2**Math.min(c.failures,5));c.note='Agent kapandı; kayıtlı durumdan yeniden başlatılacak';if(c.failures>=5){c.status='paused';c.note='Agent beş kez açılamadı veya kapandı. Hatayı düzelttikten sonra Başlat ile devam edebilirsin.';}this.save(id,c);}
  answered(id,questionId){const c=this.store.campaign(id);if(!c)return;const q=this.store.questions(id).find(q=>q.id===questionId);if(!q||q.answer===null)return;c.wakeAt=0;if(q.jobId){c.pendingResumes??={};c.pendingResumes[q.jobId]=questionId;delete c.attempts[q.jobId];}this.save(id,c);}
  choose(id,c){
    const p=this.store.profile(id),jobs=this.store.jobs(id),questions=this.store.questions(id);
    if(p.authorization!=='research'){
      for(const j of jobs.slice().reverse().sort((a,b)=>Number(Boolean(c.pendingResumes?.[b.id]))-Number(Boolean(c.pendingResumes?.[a.id])))){
        const source=j.sourceId?this.store.source(id,j.sourceId):null;if(source?.applyMode==='find_only')continue;
        const unanswered=questions.some(q=>q.jobId===j.id&&q.answer===null);if(unanswered)continue;
        const answered=questions.some(q=>q.jobId===j.id&&q.answer!==null);
        const maySubmit=p.authorization==='submit'&&(!source||source.applyMode==='auto');
        const eligible=['found','working','uncertain'].includes(j.status)||(j.status==='prepared'&&maySubmit)||(j.status==='blocked'&&(answered||j.note.startsWith('Oturum kapandı.')));
        if(eligible&&(c.pendingResumes?.[j.id]||!c.attempts[j.id]||Date.parse(j.updatedAt)>c.attempts[j.id]))return{resumeQuestionId:c.pendingResumes?.[j.id]??null,kind:j.status==='uncertain'?'verify':'application',jobId:j.id,sourceId:j.sourceId??null,applyMode:source?.applyMode??(maySubmit?'auto':'prepare')};
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
      let c=this.store.campaign(p.id);if(c?.status!=='running'||c.task||this.now()<c.wakeAt)continue;
      if(this.store.jobs(p.id).filter(j=>j.status==='submitted').length>=c.target){this.save(p.id,{...c,status:'complete',note:'Başvuru hedefine ulaşıldı'});continue;}
      const chosen=this.choose(p.id,c);if(!chosen)continue;
      const task={...chosen,id:randomUUID(),seenWorking:false,report:null,createdAt:this.now()};c.task=task;this.save(p.id,c);
      const source=task.sourceId?this.store.source(p.id,task.sourceId):null;
      const checkpoint=task.jobId?this.store.job(p.id,task.jobId).resumeContext:null,answers=task.jobId?this.store.questions(p.id).filter(q=>q.jobId===task.jobId&&q.answer!==null):[];
      const prompt=campaignPrompt({task,source,profile:p,checkpoint,answers});
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
          const note=task.kind==='search'&&source?`${source.name} taranıyor`:job?`${job.company} · ${job.role} işleniyor`:'Agent görevi işliyor';
          this.save(p.id,{...delivered,note});
        }
      }catch(error){c=this.store.campaign(p.id);if(c?.status==='running'){c.task=null;c.failures++;if(this.active(p.id)){c.status='paused';c.note='Mesaj teslimi doğrulanamadı. Çift iş göndermemek için duraklatıldı: '+error.message;}else{c.wakeAt=this.now()+Math.min(300000,10000*2**Math.min(c.failures,5));c.note=error.message;if(c.failures>=5){c.status='paused';c.note='Tekrarlanan başlatma hatası: '+error.message;}}this.save(p.id,c);}}finally{this.launching.delete(p.id);}
      break;
    }}finally{this.busy=false;}
  }
}
