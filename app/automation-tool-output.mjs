const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));

// A write receipt is not another copy of the listing, proposal and audit trail.
// The saved record remains authoritative, including when a protected existing
// record was returned unchanged. Full reads and action guards are unchanged.
export function recordReceipt(record){
 return {...pick(record,['id','automationId','key','url','actionUrl','sourceUrl','title','status','state','workflowState','operationState','duplicate','trial','sampleKind','revision','digest','approvedDigest','requiresReview','attemptedAt','completedAt','updatedAt']),
  ...(record.assessment?{assessment:pick(record.assessment,['status','score','scoringVersion','eligibility','eligibilityReason','revision','scoredAt','gaps','uncertainties'])}:{}),
  hasProposal:Boolean(record.proposal),hasEvidence:Boolean(record.evidence||record.proof),
  detail:'Record reference. Read get_automation_result(itemId) for the full saved record, proposal and evidence before judging or acting.'};
}

const checkpointView=checkpoint=>{
 if(!checkpoint)return checkpoint;
 const {pendingUrls,pendingCount,nextOffset,...value}=checkpoint;return value;
};
const planView=plan=>plan?{...plan,...(plan.checkpoint?{checkpoint:checkpointView(plan.checkpoint)}:{})}:plan;
function queueView(queue,limit,summary){
 if(summary){const {pendingUrls,nextOffset,...rest}=queue;return {...rest,checkpoint:checkpointView(queue.checkpoint),entriesAvailable:queue.total,delegation:'Use browser_jev_run operation=collect_details with no URLs; Jev reads this queue internally. Resume an existing continue taskId first.'};}
 const pendingUrls=queue.pendingUrls.slice(0,limit),end=queue.offset+pendingUrls.length;
 return {...queue,checkpoint:checkpointView(queue.checkpoint),pendingUrls,nextOffset:end<queue.total?end:null};
}

// Show pending URLs once, in the selected search's paged queue. Checkpoints
// still carry their exact URL/cursor and plans retain cutoff/boundary evidence.
// Other searches and every remaining URL stay available through get_scan_queue.
export function scanToolOutput(value,{limit=25,summary=false}={}){
 if(!value||typeof value!=='object')return value;
 if(Array.isArray(value.pendingUrls)&&typeof value.searchId==='string'&&Number.isInteger(value.total))return queueView(value,limit,summary);
 const queue=value.queue??value.scanWork?.queue;
 if(!queue)return value;
 const result={...value};
 if(value.queue)result.queue=queueView(value.queue,limit,summary);
 if(value.scanWork)result.scanWork={...value.scanWork,queue:queueView(value.scanWork.queue,limit,summary)};
 if(value.scanPlan)result.scanPlan=planView(value.scanPlan);
 if(value.scanProgress){
  const {pendingUrls,nextOffset,...progress}=value.scanProgress;
  result.scanProgress={...progress,pendingCount:progress.pendingCount??pendingUrls?.length??0};
 }
 if(!summary&&(result.queue??result.scanWork.queue).nextOffset!==null)result.queueReading='Read remaining URLs with get_scan_queue(offset: nextOffset).';
 return result;
}

// renderedDocument already puts each exact link label and URL beside its card.
// Remove the duplicate index only when every entry is represented verbatim.
// Current action maps, prose, form values and non-duplicate links stay intact.
export function documentToolContent(content){
 return content.map(part=>{
  if(part.type!=='text')return part;
  const prefix=part.text.match(/^Page URL: [^\n]+\n/)?.[0]??'';
  let page;try{page=JSON.parse(part.text.slice(prefix.length));}catch{return part;}
  if(page?.observationMode!=='document'||typeof page.text!=='string'||!Array.isArray(page.links)||!page.links.length)return part;
  const lines=new Set(page.text.split('\n'));
  if(!page.links.every(link=>typeof link.text==='string'&&typeof link.url==='string'&&Object.keys(link).every(key=>['text','url'].includes(key))&&lines.has(`Link: ${link.text?link.text+' — ':''}${link.url}`)))return part;
  const {links,...projected}=page;
  return {...part,text:prefix+JSON.stringify({...projected,linksInText:true})};
 });
}

// renderedDocument writes every link as its own "Link: label — url" line. A
// listing brief is read for facts, not navigation, so those lines leave the
// sections while offsets keep pointing at the original evidence text.
const linkLine=/^Link: .*$/;
function briefSections(sections){
 return sections.map(section=>{
  if(typeof section.text!=='string'||!section.text.includes('Link: '))return section;
  const lines=section.text.split('\n'),kept=lines.filter(line=>!linkLine.test(line)),omitted=lines.length-kept.length;
  return omitted?{...section,text:kept.join('\n'),linksOmitted:omitted}:section;
 }).filter(section=>typeof section.text!=='string'||section.text.trim()||!section.linksOmitted);
}
export function briefToolOutput(value){
 if(!value||typeof value!=='object')return value;
 if(Array.isArray(value.briefs))return {...value,briefs:value.briefs.map(briefToolOutput)};
 return Array.isArray(value.sections)?{...value,sections:briefSections(value.sections)}:value;
}
