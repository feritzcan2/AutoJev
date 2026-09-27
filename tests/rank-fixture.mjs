// Existing workflow tests start with an eligible, evidenced listing.
// Ranking-specific tests use Store.addJob directly to exercise the unranked state.
export function rankInput(store,candidate,score=80,extra={}){
 return{profileKey:store.profile(candidate).rankingProfileKey,status:'scored',availability:'open',summary:'Fixture: demonstrated backend match',evidence:'Backend role, applications open',dimensions:Object.fromEntries(['technical','experience','role','preferences'].map(key=>[key,{score,reason:'Fixture posting and profile evidence'}])),strengths:['Relevant experience'],gaps:[],uncertainties:[],blockers:[],...extra};
}
export function addRankedJob(store,candidate,input){
 const result=store.addJob(candidate,input);
 if(!result.duplicate)result.job=store.rankJob(candidate,result.job.id,rankInput(store,candidate));
 return result;
}
