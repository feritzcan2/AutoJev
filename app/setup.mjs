export const PROMPT='Run candidate setup only. Read .agents/skills/setup-profile/SKILL.md, get_candidate_profile and list_applications. Read the supplied CV/documents or LinkedIn source. Use update_setup_profile to save evidenced profile facts and progress; ask_candidate for at most two missing questions at a time. Do not search jobs or apply. When the profile is ready use stage=review and stop. User approval in the app opens the workspace.';
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
