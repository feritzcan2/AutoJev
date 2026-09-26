export const PROMPT='JobLoop onboarding. Read .agents/skills/setup-profile/SKILL.md if not already in context. Read get_task_context for setup status, profile and saved answers; continue only incomplete setup. Save progress with update_setup_profile. When ready set stage=review and wait for app approval; no job search or applications during setup.';
export class Setups {
 constructor(store,{launch,send,active,changed}){Object.assign(this,{store,launch,send,active,changed});this.busy=false;this.closed=false;}
 async begin(id){const s=this.store.setup(id),p=this.store.profile(id);if(!s||s.status==='complete')throw Error('Setup bulunamadı');if(!p.cvPath&&!s.source)throw Error('CV veya LinkedIn bağlantısı gerekli');this.store.saveSetup(id,{...s,status:'running',needsTurn:true,error:null,failures:0});this.changed(id);await this.tick();}
 answered(id){const s=this.store.setup(id);if(s?.status==='running'){this.store.saveSetup(id,{...s,needsTurn:true,error:null});this.changed(id);}}
 exited(id){const s=this.store.setup(id);if(s?.status==='running'){const failures=(s.failures??0)+1;this.store.saveSetup(id,{...s,needsTurn:failures<3,failures,error:'Agent oturumu kapandı. Kayıtlı profilden devam edilecek.'});this.changed(id);}}
 async tick(){if(this.busy||this.closed)return;this.busy=true;try{
  for(const p of this.store.candidates()){
   const s=this.store.setup(p.id);if(s?.status!=='running'||!s.needsTurn||this.store.questions(p.id).some(q=>q.answer===null))continue;
   if(this.store.campaign(p.id)?.status==='running')continue;
   const active=this.active(p.id);if(active&&(active.candidateId!==p.id||active.state!=='Idle'))continue;
   this.store.saveSetup(p.id,{...s,needsTurn:false,error:null});
   try{if(active)await this.send(PROMPT,p.id);else await this.launch(p.id,PROMPT);}catch(e){const current=this.store.setup(p.id);this.store.saveSetup(p.id,{...current,needsTurn:false,error:e.message});}this.changed(p.id);break;
  }
 }finally{this.busy=false;}}
}
