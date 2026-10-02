// Coalesce change notifications while a snapshot is in flight. One later read
// observes changes that arrived during it, without queuing duplicate reads.
export function coalesceRefresh(read){
 let pending=null,again=false;
 return ()=>{
  again=true;
  if(!pending)pending=Promise.resolve().then(async()=>{
   do{again=false;await read();}while(again);
  }).finally(()=>{pending=null;});
  return pending;
 };
}
