import {questionKnowledge,validateQuestionReview} from './question-gate.mjs';
import {sourceInstructions,runSourceTool} from './source-integrations.mjs';
import {fileURLToPath} from 'node:url';
const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
import {questionFieldsSchema} from './question-forms.mjs';
import {reusableFactKeys} from './store.mjs';
import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
const str={type:'string',minLength:1,maxLength:12000};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const applicationBlocker=object({kind:{type:'string',enum:['required_form_field','access','uncovered_consent']},evidence:str,reasonUnknown:str,consentScope:{type:'string',enum:['submission','recruitment_privacy','group_recruitment','other']},review:object({cvChecked:str,missingFacts:{type:'array',minItems:1,maxItems:2,items:object({key:{...str,enum:[...reusableFactKeys,'application_specific']},gap:str,knownValueGap:str},['key','gap'])}}),recovery:object({kind:{type:'string',enum:['form_entry','user_only']},userActionReason:str,visualCheck:object({method:{type:'string',enum:['screenshot']},result:{type:'string',enum:['empty','invalid']},evidence:str}),attempts:{type:'array',maxItems:4,items:object({method:str,result:str})}},['kind','userActionReason'])},['kind','evidence','reasonUnknown']);
const resumeContext=object({browser:str,tabId:str,url:str,step:str,nextAction:str});
export const tools=[
  {name:'update_setup_profile',description:'During candidate setup only: save evidence-based profile fields and real progress. Use review when ready for the user to edit and approve. Cannot change authorization, agent settings or complete setup.',inputSchema:object({stage:{type:'string',enum:['reading','preferences','review']},message:str,name:str,preferences:str,facts:{type:'string',minLength:1,maxLength:30000}},['stage','message'])},
  {name:'report_activity',description:'Tell the candidate what you are actually doing right now. Report a short concrete action when changing steps (searching, inspecting a listing, filling a form, uploading, checking confirmation or waiting). Do not report thoughts, guesses or claim submission without record_submission. No heartbeat spam.',inputSchema:object({message:str,jobId:str},['message'])},
  {name:'get_campaign',description:'Read campaign target, current task ID, status and scheduled next search.',inputSchema:object({})},
  {name:'report_campaign_work',description:'Report the current bounded task outcome before ending your turn. This does not claim a submitted application. Application reports are rejected unless the recorded application is complete or has a durable blocker. User-dependent blockers require a job-linked ask_candidate question and blocked status. Technical blockers without user input require blocker evidence. Prepared is not complete when auto-submission is authorized.',inputSchema:object({taskId:str,outcome:{type:'string',enum:['done','no_results','blocked']},note:str,blocker:object({kind:{type:'string',enum:['technical']},requiresUserInput:{type:'boolean'},evidence:str,reason:str})},['taskId','outcome','note'])},
  {name:'remember_candidate_fact',description:'Persist a reusable candidate fact supported by this candidate’s CV, existing profile or an explicit saved answer. Read the profile first. Supply a short exact evidence quote and sourceId: question ID for answer, candidate ID for profile, current CV path for cv. Merge existing values for the same key; do not erase other known languages/skills. Never store employer-specific decisions, consent, agreements or guesses as general facts. Cannot change submission authorization or application policy.',inputSchema:object({key:{...str,enum:reusableFactKeys},value:str,source:{...str,enum:['answer','profile','cv']},sourceId:str,evidence:str})},
  {name:'get_task_context',description:'Read current setup/campaign task, profile, assigned job/source, global and job-specific answers, and compact unfinished-tab checkpoints. Prefer this over full history for each task. Also refreshes the profile/answer review required before asking questions.',inputSchema:object({})},
  {name:'get_candidate_profile',description:'Read candidate facts, CV path, preferences and submission authorization. Unknown facts remain unknown.',inputSchema:object({})},
  {name:'list_applications',description:'Read every known listing and application before searching or applying; includes questions and recent events.',inputSchema:object({})},
  {name:'add_job',description:'Record a verified live listing and its fit. Returns an existing record for likely duplicates.',inputSchema:object({url:str,company:str,role:str,location:str,fit:str})},
  {name:'update_application',description:'Report work status. Follow found → working → prepared → submitting. After a submission with no confirmation use uncertain. Submitted requires record_submission.',inputSchema:object({jobId:str,status:{type:'string',enum:['working','prepared','submitting','blocked','uncertain','skipped']},note:str})},
  {name:'get_source_instructions',description:'Read a source’s current JobLoop skill, configured search method, tool reference and fallback. Required before every source search.',inputSchema:object({sourceId:str})},
  {name:'run_source_tool',description:'Run the configured local search/detail CLI for the current source task. Pass only CLI arguments from get_source_instructions; executable and base arguments are supplied by JobLoop. Returns actual stdout or an explicit error.',inputSchema:object({sourceId:str,args:{type:'array',items:str}})},
  {name:'save_source_checkpoint',description:'Save the actual browser, stable tab ID and current URL used for the current source search, so the user can focus that existing tab. Call after opening or navigating the search tab. Never invent IDs. Source must match the current campaign search task.',inputSchema:object({sourceId:str,browser:str,tabId:str,url:str})},
  {name:'save_application_checkpoint',description:'Save the actual browser identity, observed stable tab ID (not a JS variable or tab index), current form URL, current step and next action before leaving an incomplete form. Preserve this tab for resumption; do not close, navigate or reuse it for another job.',inputSchema:object({jobId:str,resumeContext})},
  {name:'resolve_technical_question',description:'Close a technical form-entry question after verifying the blocker is solved or the request was based on a misleading empty/redacted browser observation. This is not a candidate answer and cannot settle consent or missing facts. Supply observed evidence.',inputSchema:object({questionId:str,evidence:str})},
  {name:'ask_candidate',description:'For application questions first call get_task_context (or list_applications if full history is needed) to read current profile and saved answers, then read the CV. Supply applicationBlocker.review={cvChecked: source/path and finding, missingFacts:[{key,gap,knownValueGap?}]}; key is a reusable fact category or application_specific, knownValueGap explains why an existing fact cannot resolve this exact required detail. For access blockers supply recovery={kind:form_entry or user_only,userActionReason,attempts:[{method,result}]}; form_entry requires two distinct safe attempts plus visualCheck={method:screenshot,result:empty or invalid,evidence}. AX/DOM may omit or redact contact values even when visually filled. A blank programmatic value is NOT proof of failed typing; inspect a fresh screenshot of the visible field first. Preserve the tab with markHandoff each turn, including unrelated search turns while any form is pending. user_only is only for login, MFA, CAPTCHA, required tool confirmation or genuinely unavailable capability, never a workaround for failed typing. Do not retry submission. Use fields to ask a short form: each field has a stable id, a single label, type (text/boolean/select/multiselect/date/number), optional help and required flag, and options for choices. Never bundle numbered subquestions in a label. Boolean fields start unanswered. First check profile, CV and saved answers; ask only facts still missing or genuinely conflicting. Never ask the user to reconfirm known facts. Job-specific questions require applicationBlocker: an actual required form field, browser access blocker, or consent not covered by policy. Quote the actual field label/required marker or observed blocker in evidence and explain in reasonUnknown what is missing after checking CV/profile/answers. A job-description requirement or fit assessment is NOT a blocker; do not interview the candidate to verify suitability. Leave optional unknown fields empty. Automatic submission is already authorized when profile authorization=submit and the source allows auto: never ask whether to submit. For uncovered_consent also provide consentScope (submission, recruitment_privacy, group_recruitment or other); already granted permissions cannot be asked again. After an answer, persist reusable facts via remember_candidate_fact. For a question about an open application form, supply jobId and resumeContext from the actual browser so the answer returns to that exact tab and step. Leave the incomplete tab open and use another tab for independent work. Read list_applications for replies.',inputSchema:object({question:str,jobId:str,resumeContext,fields:questionFieldsSchema,applicationBlocker},['question'])},
  {name:'record_submission',description:'Record observed external confirmation, not an attempted click. Never fabricate proof or resubmit an uncertain application.',inputSchema:object({jobId:str,kind:{type:'string',enum:['success_page','confirmation_email','confirmation_message']},text:str,url:str,documents:str})}
];
export function validate(schema,value){
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('arguments must be an object');
    for(const key of schema.required??[])if(!(key in value))throw Error(`Missing ${key}`);
    for(const [key,item]of Object.entries(value)){if(!schema.properties[key])throw Error(`Unknown field ${key}`);validate(schema.properties[key],item);}
  }else if(schema.type==='array'){if(!Array.isArray(value)||value.length<(schema.minItems??0)||value.length>(schema.maxItems??100))throw Error('Invalid array');for(const item of value)validate(schema.items,item);
  }else if(schema.type==='boolean'){if(typeof value!=='boolean')throw Error('Invalid boolean');
  }else if(typeof value!=='string'||!value.trim()||value.length>(schema.maxLength??12000)||schema.enum&&!schema.enum.includes(value))throw Error('Invalid argument');
}
export async function startMcp(store,onChange=()=>{},onHook=async()=>({accepted:false}),browser=null,campaigns=null,custom=null){
  const grants=new Map();
  const server=createServer(async(req,res)=>{
    const reply=(code,body)=>{const payload=body===undefined?'':JSON.stringify(body);res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':Buffer.byteLength(payload)});res.end(payload);};
    if(req.url==='/agent-observation'&&req.method==='POST'&&!req.headers.origin){
      let size=0,parts=[];try{for await(const part of req){size+=part.length;if(size>128*1024)return reply(413,{error:'Too large'});parts.push(part);}const hook=JSON.parse(Buffer.concat(parts));const result=await onHook(hook);return reply(200,{id:hook.id,...result});}catch{return reply(400,{accepted:false});}
    }
    if(req.url!=='/mcp')return reply(404,{error:'Not found'});
    // No browser-origin access: UI uses isolated Electron IPC instead.
    if(req.headers.origin)return reply(403,{error:'Origin not permitted'});
    const token=(req.headers.authorization??'').replace(/^Bearer /,'');
    const entry=[...grants.entries()].find(([key])=>key.length===token.length&&timingSafeEqual(Buffer.from(key),Buffer.from(token)));
    if(!entry)return reply(401,{error:'Unauthorized'});
    if(req.method!=='POST')return reply(405,{error:'POST required'});
    let bytes=0,parts=[];
    try{for await(const part of req){bytes+=part.length;if(bytes>128*1024)return reply(413,{error:'Request too large'});parts.push(part);}}catch{return;}
    let rpc;try{rpc=JSON.parse(Buffer.concat(parts));}catch{return reply(400,{error:'Invalid JSON'});}
    if(!rpc||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string')return reply(400,{error:'Invalid JSON-RPC'});
    if(rpc.id===undefined)return reply(202);
    const result=value=>reply(200,{jsonrpc:'2.0',id:rpc.id,result:value});
    if(rpc.method==='initialize')return result({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'jobloop',version:'0.1.0'}});
    if(rpc.method==='ping')return result({});
    if(rpc.method==='tools/list'){try{return result({tools:custom?custom.tools:[...tools,...(browser?await browser.tools(entry[1].candidateId):[])]});}catch(error){return reply(200,{jsonrpc:'2.0',id:rpc.id,error:{code:-32603,message:error.message}});}}
    if(rpc.method!=='tools/call')return reply(200,{jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Method not found'}});
    const {candidateId,sessionId}=entry[1];
    try{
      const name=rpc.params?.name;
      if(custom){const definition=custom.tools.find(t=>t.name===name);if(!definition)throw Error('Unknown tool');const args=rpc.params.arguments??{};validate(definition.inputSchema,args);const value=await custom.call(candidateId,sessionId,name,args);return result({content:[{type:'text',text:JSON.stringify(value)}]});}
      const definition=tools.find(t=>t.name===name);if(!definition){if(browser&&name?.startsWith('browser_'))return result(await browser.call(candidateId,name,rpc.params.arguments??{},sessionId));throw Error('Unknown tool');}
      if(store.setup(candidateId)&&store.setup(candidateId).status!=='complete'&&['add_job','update_application','record_submission','report_campaign_work'].includes(name))throw Error('Complete setup before job search or applications');
      const a=rpc.params.arguments??{};validate(definition.inputSchema,a);let value;
      switch(name){
        case 'update_setup_profile':value=store.updateSetupProfile(candidateId,a);break;
        case 'report_activity':value=store.reportActivity(candidateId,sessionId,a);break;
        case 'get_campaign':value=campaigns?.get(candidateId)??null;break;
        case 'report_campaign_work':if(!campaigns)throw Error('Campaign unavailable');value=campaigns.report(candidateId,sessionId,a);break;
        case 'remember_candidate_fact':value=store.rememberFact(candidateId,a);break;
        case 'get_task_context':value=store.taskContext(candidateId);entry[1].questionKnowledge=questionKnowledge(store,candidateId);break;
        case 'get_candidate_profile':value=store.profile(candidateId);break;
        case 'list_applications':value=store.snapshot(candidateId);entry[1].questionKnowledge=questionKnowledge(store,candidateId);break;
        case 'add_job':{const task=campaigns?.get(candidateId)?.task;value=store.addJob(candidateId,{...a,sourceId:task?.kind==='search'?task.sourceId:null});break;}
        case 'update_application':value=store.updateJob(candidateId,a.jobId,a.status,a.note,sessionId);break;
        case 'get_source_instructions':value=await sourceInstructions(sourceRoot,store.source(candidateId,a.sourceId));break;
        case 'run_source_tool':{const task=campaigns?.get(candidateId)?.task;if(campaigns?.get(candidateId)?.status!=='running'||task?.kind!=='search'||task.sourceId!==a.sourceId)throw Error('Araç yalnızca etkin kaynak taramasında çalıştırılabilir');value=await runSourceTool(sourceRoot,store.source(candidateId,a.sourceId),a.args);break;}
        case 'save_source_checkpoint':value=store.saveSourceCheckpoint(candidateId,a.sourceId,a);break;
        case 'save_application_checkpoint':value=store.saveApplicationCheckpoint(candidateId,a.jobId,a.resumeContext,sessionId);break;
        case 'resolve_technical_question':value=store.resolveTechnicalQuestion(candidateId,a.questionId,a.evidence);break;
        case 'ask_candidate':{const jobId=a.jobId??campaigns?.get(candidateId)?.task?.jobId;if(jobId&&!a.applicationBlocker)throw Error('İlan şartlarını doğrulatmak için soru sorma. Önce CV, profil ve kayıtlı yanıtları kullan. Yalnızca gerçekten zorunlu form alanı, erişim engeli veya mevcut izinlerin kapsamadığı onay için applicationBlocker içinde gözlenen alanı/engeli ve eksik bilgiyi belirt. Opsiyonel bilinmeyen alanı boş bırak.');if(jobId)validateQuestionReview(store,candidateId,a,entry[1].questionKnowledge);if(a.applicationBlocker?.kind==='uncovered_consent'){const scope=a.applicationBlocker.consentScope;if(!scope)throw Error('Onayın kapsamını consentScope ile belirt');const profile=store.profile(candidateId),job=jobId?store.job(candidateId,jobId):null,source=job?.sourceId?store.source(candidateId,job.sourceId):null;if(scope==='submission'&&profile.authorization==='submit'&&(!source||source.applyMode==='auto')||scope==='recruitment_privacy'&&profile.applicationPolicy.acceptPrivacy||scope==='group_recruitment'&&profile.applicationPolicy.groupRecruitmentConsent)throw Error('Bu işlem kayıtlı ayarlarda zaten onaylı; tekrar onay sorma ve mevcut yetki kapsamında devam et.');}value=store.ask(candidateId,{...a,jobId},sessionId);break;}
        case 'record_submission':value=store.recordSubmission(candidateId,a.jobId,a,sessionId);break;
      }
      onChange(candidateId);result({content:[{type:'text',text:JSON.stringify(value)}]});
    }catch(error){result({isError:true,content:[{type:'text',text:error.message}]});}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return{endpoint:`http://127.0.0.1:${server.address().port}/mcp`,grant(candidateId,sessionId){store.profile(candidateId);const token=randomBytes(32).toString('hex');grants.set(token,{candidateId,sessionId});return token;},revoke(token){grants.delete(token);},close(){server.closeAllConnections();return new Promise(r=>server.close(r));}};
}
