// Saved browser checkpoints can be copied to the wrong job by a prior agent.
// An employer-branded host belonging to another saved company is strong
// evidence that this is not the current job's form. Neutral ATS hosts pass.
const generic=new Set(['www','jobs','job','career','careers','apply','application','applications','de','eu','com','org','net','io','co','greenhouse','lever','ashbyhq','personio','successfactors','workday','stepstone','linkedin','smartrecruiters','indeed','icims','join']);
const words=s=>(s??'').normalize('NFKD').toLowerCase().replace(/\p{M}/gu,'').split(/[^a-z0-9]+/).filter(w=>w.length>=4&&!generic.has(w));
export function foreignEmployerCheckpoint(job,url,jobs=[]){
 let labels;try{labels=new URL(url).hostname.toLowerCase().split(/[.-]/).filter(w=>w.length>=4&&!generic.has(w));}catch{return false;}
 if(!labels.length)return false;
 const own=words(job?.company);
 if(labels.some(label=>own.some(word=>word===label)))return false;
 return jobs.some(other=>other?.id!==job?.id&&words(other?.company).some(word=>labels.includes(word)));
}
