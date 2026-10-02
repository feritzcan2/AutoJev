export function workerScreenshot(api,pane){
 let dead=false,pending=false,version=0,session=pane.worker.active?.sessionId??null,last=null;
 const visible=()=>!dead&&!pane.dead&&!document.hidden&&pane.view()==='screenshot'&&pane.screenshot.getClientRects().length>0&&inViewport();
 function inViewport(){const r=pane.screenshot.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;}
 function status(message){
  pane.screenshotStatus.textContent=message+(last?' · '+new Date(last.capturedAt).toLocaleTimeString('tr-TR'): '');
  if(!last)pane.screenshotEmpty.textContent=message;
 }
 function update(){
  const next=pane.worker.active?.sessionId??null;
  if(next!==session){
   session=next;version++;
   if(next){last=null;pane.screenshotImage.removeAttribute('src');pane.screenshotImage.hidden=true;pane.screenshotEmpty.hidden=false;pane.screenshotUrl.textContent='';status('Görüntü bekleniyor…');}
  }
  if(!session)status(last?'Worker durdu · Son görüntü':'Worker’ın aktif tarayıcı işi yok.');
 }
 async function refresh(){
  update();if(!visible()||!session||pending)return;
  const request=version,run=session;pending=true;
  try{
   const result=await api.workerPreview(pane.candidate,pane.id);
   if(dead||request!==version||run!==pane.worker.active?.sessionId||!visible())return;
   if(result.state==='ready'&&result.runId===run){
    last=result;pane.screenshotImage.src=result.image;pane.screenshotImage.hidden=false;pane.screenshotEmpty.hidden=true;
    pane.screenshotUrl.textContent=result.url;pane.screenshotUrl.title=result.title?`${result.title}\n${result.url}`:result.url;
    status('Son güncelleme');
   }else status((last?'Son görüntü · ':'')+(result.message??'Yeni görüntü bekleniyor…'));
  }catch(error){if(!dead&&request===version)status((last?'Son görüntü · ':'')+error.message);}
  finally{pending=false;}
 }
 const timer=setInterval(refresh,1500),observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))void refresh();});observer.observe(pane.screenshot);
 document.addEventListener('visibilitychange',refresh);
 return {update,refresh,dispose(){dead=true;version++;clearInterval(timer);observer.disconnect();document.removeEventListener('visibilitychange',refresh);pane.screenshotImage.removeAttribute('src');last=null;}};
}
