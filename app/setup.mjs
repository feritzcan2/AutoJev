import {compactionPending} from './context-compaction.mjs';
export const PROMPT='JobLoop onboarding. Read .agents/skills/setup-profile/SKILL.md if not already in context. Read get_task_context for setup status, profile and saved answers; continue only incomplete setup. Save progress with update_setup_profile. When ready set stage=review and wait for app approval; no job search or applications during setup.';
export const IMPROVE_PROMPT='JobLoop profile improvement requested by the candidate. Read .agents/skills/setup-profile/SKILL.md for improvement mode and get_task_context once for the existing profile, CV and saved answers. This is a new profile task even if the resumed conversation previously finished onboarding or worked on applications. Start from the current profile. Ask what the candidate wants to change or improve through ask_candidate if they have not said yet; wait for their answer before proposing a final profile. Discuss focused improvements and apply their corrections with update_setup_profile. Save a complete, self-contained current profile: replace corrected facts and remove obsolete or deleted information from facts and preferences. Do not append legacy/old-information sections, change logs, or references telling the reader to consult earlier profiles, answers or conversations. Do not restore removed information from old answers, files or conversation memory. Preserve only unrelated information that is still valid. Ask only necessary follow-ups. When the requested changes are ready, set stage=review for the user to check them. Do not search for jobs, process applications, change authorization/settings, or restart the campaign.';
export class Setups {
 constructor(store,{launch,send,active,changed,browserReady=()=>({ready:true})}){Object.assign(this,{store,launch,send,active,changed,browserReady});this.busy=false;this.closed=false;}
 async begin(id){const s=this.store.setup(id),p=this.store.profile(id);if(!s||s.status==='complete')throw Error('Setup bulunamadı');if(s.mode!=='improve'&&!p.cvPath&&!s.source)throw Error('CV veya LinkedIn bağlantısı gerekli');this.store.saveSetup(id,{...s,status:'running',needsTurn:true,askForChanges:s.askForChanges||s.mode==='improve'&&s.status==='review',error:null,failures:0});this.changed(id);await this.tick();}
 answered(id){const s=this.store.setup(id);if(s?.status==='running'){this.store.saveSetup(id,{...s,needsTurn:true,error:null});this.changed(id);}}
 exited(id){const s=this.store.setup(id);if(s?.status==='running'){const failures=(s.failures??0)+1;this.store.saveSetup(id,{...s,needsTurn:failures<3,failures,error:'Agent oturumu kapandı. Kayıtlı profilden devam edilecek.'});this.changed(id);}}
 async tick(){if(this.busy||this.closed)return;this.busy=true;try{
  for(const p of this.store.candidates()){
   const s=this.store.setup(p.id);if(s?.status!=='running'||!s.needsTurn||this.store.setupQuestions(p.id).some(q=>q.answer===null))continue;
   if(this.store.campaign(p.id)?.status==='running')continue;
   const active=this.active(p.id);if(compactionPending(active))continue;
   if(active&&(active.candidateId!==p.id||active.state!=='Idle'))continue;
   if(!active&&!this.browserReady(p.id).ready){if(!s.browserWait){this.store.saveSetup(p.id,{...s,browserWait:true});this.changed(p.id);}continue;}
   this.store.saveSetup(p.id,{...s,needsTurn:false,browserWait:false,askForChanges:false,error:null});
   const prompt=s.mode==='improve'?IMPROVE_PROMPT+(s.askForChanges?' The candidate just opened this conversation or returned from review. Ask what they want to change now; earlier conversation requests do not answer this new question.':''):PROMPT;
   try{if(active)await this.send(prompt,p.id);else await this.launch(p.id,prompt);}catch(e){const current=this.store.setup(p.id);this.store.saveSetup(p.id,{...current,needsTurn:e.code==='BROWSER_WAIT',browserWait:e.code==='BROWSER_WAIT',askForChanges:s.askForChanges,error:e.code==='BROWSER_WAIT'?null:e.message});}this.changed(p.id);break;
  }
 }finally{this.busy=false;}}
}
