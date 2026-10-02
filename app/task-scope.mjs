const applicationTools=new Set(['resume_application','update_application','save_application_checkpoint','record_validation_failure','continue_verification','record_submission','stop_application_followup','record_candidate_submission','defer_missing_documents','ask_candidate']);
const rankBrowserReads=new Set(['browser_jev_open','browser_jev_tabs','browser_jev_observe','browser_jev_inspect_form','browser_jev_screenshot','browser_jev_reveal','browser_jev_scroll','browser_jev_list_options','browser_jev_next','browser_jev_act','browser_jev_click']);

export function assertTaskTool(task,name){
  if(!task)return;
  if(name==='save_preparation'&&task.kind!=='preparation')throw Error('Paket kaydetmek için hazırlık görevi gerekli.');
  if(task.kind==='preparation'&&['continue_verification','record_validation_failure'].includes(name))throw Error('Hazırlık görevi gönderim yapamaz.');
  if(task.kind==='rank'&&applicationTools.has(name))throw Error('Puanlama görevinde başvuru doldurulamaz, değiştirilemez veya aday sorusu açılamaz. İlanı inceleyip record_job_rank ile puanla.');
  if(task.kind==='rank'&&name.startsWith('browser_')&&!rankBrowserReads.has(name))throw Error('Puanlama görevinde yalnızca ilan okunabilir. Form girişi, seçim ve dosya yükleme başvuru görevine aittir.');
}

export function assertWorkerAssignment(store,candidate,name,args){
  const task=store.campaign(candidate)?.task;
  const mutations=new Set([...applicationTools,'save_preparation','add_job','link_job_url','record_job_rank','save_source_checkpoint','save_source_progress','report_campaign_work','resolve_technical_question']);
  if(!mutations.has(name)&&!name?.startsWith('browser_'))return;
  if(!task&&store.setup(candidate)?.status!=='running')throw Error('Bu worker’a henüz görev atanmadı. Yeni görev bekle.');
  if(!task)return;
  const reservations=store.workerTasks(candidate);
  if(args.jobId&&reservations.some(w=>w.task.jobId===args.jobId))throw Error('Bu ilan başka bir worker’a atanmış. Yalnızca kendi görevini işle.');
  if(task.jobId&&args.jobId&&args.jobId!==task.jobId)throw Error('İlan bu worker’ın etkin görevine ait değil.');
  if(task.kind==='search'&&applicationTools.has(name)&&name!=='ask_candidate')throw Error('Arama worker’ı bu görevde başvuru işleyemez.');
  if(task.kind==='search'&&name==='ask_candidate'&&args.jobId)throw Error('Arama görevinde başvuru sorusu açılamaz.');
  if(name==='add_job'&&task.kind!=='search')throw Error('İlan eklemek için arama görevi gerekli.');
  if(name==='record_job_rank'&&task.kind==='search'&&store.job(candidate,args.jobId).discoveryTaskId!==task.id)throw Error('Bu ilan başka bir görevde puanlanacak.');
  if(args.sourceId&&['save_source_checkpoint','save_source_progress'].includes(name)&&args.sourceId!==task.sourceId)throw Error('Kaynak bu worker’ın görevine ait değil.');
}

// Check resolved observed actions too: act/click must not bypass the tool gate.
export function assertRankAction(taskKind,action){
  if(taskKind!=='rank'||!action)return;
  if(rankActionAllowed(action))return;
  throw Error('Puanlama görevi bu form işlemini yapamaz. Yalnızca ilan bağlantılarını/sekmelerini oku; başvuru doldurma veya gönderme.');
}
export const rankActionAllowed=action=>['wait','scroll'].includes(action.kind)||action.kind==='click'&&['link','tab'].includes(action.role)&&!action.choice&&action.checked===undefined&&action.pressed===undefined;
