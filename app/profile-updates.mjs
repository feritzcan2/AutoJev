import {planInput,missingProfileFields} from './automation-templates.mjs';

const fields=['title','goal','criteria','instructions','facts','mode'];
export const profilePlan=plan=>Object.fromEntries(fields.filter(key=>Object.hasOwn(plan,key)).map(key=>[key,plan[key]]));
export const profileChanged=(plan,base)=>Object.entries(profilePlan(plan)).some(([key,value])=>JSON.stringify(value)!==JSON.stringify(base[key]));

// Older conversations stored source suggestions inside the profile draft.
export function splitPlanDraft(a){
 const next={...a};
 for(const key of ['planDraft','profileUpdate']){
  const draft=a[key];if(!draft?.plan||!Object.hasOwn(draft.plan,'sources'))continue;
  const {sources}=draft.plan,plan=profilePlan(draft.plan);
  if(!next.sourceDraft&&draft.baseRevision===a.revision&&JSON.stringify(sources)!==JSON.stringify(a.sources))next.sourceDraft={id:`${key}:${draft.runId??draft.savedAt}:${draft.updatedAt??draft.savedAt}`,sources,runId:draft.runId,updatedAt:draft.updatedAt??draft.savedAt};
  if(key==='profileUpdate'||profileChanged(plan,{...a,...a.profileUpdate?.plan}))next[key]={...draft,plan};else delete next[key];
 }
 return next;
}
export function queueProfileUpdate(db,id,input,{expectedRevision}={}){
 const a=db.get(id),template=db.template(a.templateId);
 if(expectedRevision!==undefined&&expectedRevision!==a.revision)throw Error('Profil değişti. Güncel profili inceleyip yeniden kaydet.');
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key)))throw Error('Geçersiz profil alanı.');
 const plan=profilePlan({...planInput(template,input,a),mode:input.mode??a.mode});
 if(!['observe','prepare','auto'].includes(plan.mode))throw Error('Geçersiz işlem yetkisi');
 const missing=missingProfileFields(plan,template);if(missing.length)throw Error('Eksik bilgiler: '+missing.join(', '));
 const {planDraft,...current}=a;
 return db.put({...current,profileUpdate:{plan,baseRevision:a.revision,savedAt:db.now()}});
}

export function applyProfileUpdate(db,id){
 const a=db.get(id),update=a.profileUpdate;if(!update)return false;
 if(db.runs(id).some(run=>run.status==='running'&&run.kind!=='interview'))return false;
 if(update.baseRevision!==a.revision)throw Error('Kaydedilen profilin sürümü değişti. Profili yeniden inceleyip kaydet.');
 return db.store.workspaces.tasks.atomic(()=>{
  db.save(id,profilePlan(update.plan),{allowConversation:true});db.review(id,{allowConversation:true});
  const next=db.get(id);
  // Preserve a newer proposal created after the user saved this profile.
  if(a.planDraft)next.planDraft={...a.planDraft,baseRevision:next.revision};
  // Applying a profile does not start paused work. Existing tracking continues.
  if(a.status==='enabled')Object.assign(next,{status:'enabled',nextRunAt:db.now(),once:a.once,onceSources:a.onceSources?.filter(url=>next.sources.includes(url))});
  else if(['paused','blocked','complete'].includes(a.status))Object.assign(next,{status:a.status,nextRunAt:null});
  delete next.profileUpdate;db.put(next);db.event(id,'profile_applied',{revision:next.revision,savedAt:update.savedAt});return true;
 });
}
