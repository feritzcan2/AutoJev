// Keep Jev's node cache in a private remote handle, not on the site's window.
// Functions still run against the real DOM; no browser identity is overridden.
export function privateJevPage(page){
 const frames=new WeakMap(),handles=new WeakMap();
 const scope=`const window=new Proxy(globalThis,{get(target,key){return key==='__jevFast'||key==='__jobloopFieldContext'?state[key]:Reflect.get(target,key,target);},set(target,key,value){if(key==='__jevFast'||key==='__jobloopFieldContext'){state[key]=value;return true;}return Reflect.set(target,key,value,target);}});`;
 const compiled=(fn,node=false)=>new Function(node?'element':'state',node?'payload':'arg',`${node?'const [state,arg]=payload;':''}${scope}return ${typeof fn==='string'?`(${fn})`:`(${fn.toString()})(${node?'element,arg':'arg'})`};`);
 function frameState(frame){
  let entry=frames.get(frame);if(!entry){entry={};frames.set(frame,entry);}return entry;
 }
 async function state(frame){const entry=frameState(frame);return entry.pending??=frame.evaluateHandle(()=>({})).catch(error=>{entry.pending=null;throw error;});}
 function wrapHandle(handle,frame){
  if(!handle)return handle;if(handles.has(handle))return handles.get(handle);
  const proxy=new Proxy(handle,{get(target,key){
   if(key==='evaluate'||key==='evaluateHandle')return async(fn,arg)=>{
    const result=await target[key](compiled(fn,true),[await state(frame),arg]);return key==='evaluateHandle'?wrapHandle(result,frame):result;
   };
   if(key==='asElement')return ()=>wrapHandle(target.asElement(),frame);
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});handles.set(handle,proxy);return proxy;
 }
 const wrappedFrames=new WeakMap();
 function wrapFrame(frame){
  if(wrappedFrames.has(frame))return wrappedFrames.get(frame);
  const proxy=new Proxy(frame,{get(target,key){
   if(key==='evaluate'||key==='evaluateHandle')return async(fn,arg)=>{
    const remote=await state(frame),result=await remote[key](compiled(fn),arg);return key==='evaluateHandle'?wrapHandle(result,frame):result;
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});wrappedFrames.set(frame,proxy);return proxy;
 }
 page.on('framenavigated',frame=>{const old=frames.get(frame);frames.delete(frame);old?.pending?.then(handle=>handle.dispose()).catch(()=>{});});
 return new Proxy(page,{get(target,key){
  if(key==='evaluate'||key==='evaluateHandle')return (...args)=>wrapFrame(target.mainFrame())[key](...args);
  if(key==='frames')return ()=>target.frames().map(wrapFrame);
  if(key==='mainFrame')return ()=>wrapFrame(target.mainFrame());
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
}
