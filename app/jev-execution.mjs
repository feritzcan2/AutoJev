// Keep one browser helper alive across short MCP requests. Polling never
// starts a second helper and finishing the request never cancels the first.
export class JevExecution {
 constructor({waitMs=15000}={}){this.waitMs=waitMs;this.current=null;}
 get busy(){return Boolean(this.current&&!this.current.settled);}
 receipt(){
  const task=this.current;
  return {status:'running',taskId:task.taskId??null,operation:task.operation,
   next:task.taskId?'Jev continues automatically until review, an issue or completion. Use read_jev_task to wait for its result; do not run shell sleep, restart the operation or use the browser.':'Jev is starting. Repeat browser_jev_run with the same input to retrieve its taskId; this will reuse the existing operation.'};
 }
 async wait(){
  const task=this.current;let timer;
  try{await Promise.race([task.promise,new Promise(resolve=>{timer=setTimeout(resolve,this.waitMs);})]);}finally{clearTimeout(timer);}
  if(!task.settled)return this.receipt();
  task.delivered=true;
  if(task.error)throw task.error;
  return task.value;
 }
 async run(input,execute){
  if(this.busy)return this.receipt();
  if(this.current&&!this.current.delivered)return this.wait();
  const task={taskId:input.taskId,operation:input.operation,settled:false,delivered:false};this.current=task;
  task.promise=Promise.resolve().then(async()=>{
   let next=input;
   for(;;){
    const value=await execute(value=>{task.taskId=value.id;task.operation=value.input.operation;},next);
    if(value.status!=='continue')return value;
    if(!value.taskId||value.taskId!==task.taskId)throw Error('Jev devam görevi değişti.');
    next={taskId:value.taskId};
    // Yield to cancellation and other workers between transport slices. No
    // main-model turn is needed to advance the same helper.
    await new Promise(setImmediate);
   }
  })
   .then(value=>{task.value=value;},error=>{task.error=error;}).finally(()=>{task.settled=true;});
  return this.wait();
 }
 owns(taskId){return Boolean(this.current&&this.current.taskId===taskId&&(!this.current.settled||!this.current.delivered));}
}
