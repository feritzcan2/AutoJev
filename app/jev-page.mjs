const transientRead=error=>/execution context was destroyed|cannot find context|context.*destroyed|Target page, context or browser has been closed|JSHandle.*disposed|Sayfa yükleniyor|Sayfa okuma sırasında yönlendi/i.test(error.message);

// Retry a complete observation, never the navigation/click/fill that preceded
// it. A live page can replace its execution context during an ordinary read.
export async function retryJevRead(page,read,{attempts=3,delay=150}={}){
 for(let attempt=0;;attempt++){
  try{return await read(attempt);}catch(error){
   if(attempt+1>=attempts||page.isClosed()||page.context?.().browser?.()?.isConnected?.()===false||!transientRead(error))throw error;
   await new Promise(resolve=>setTimeout(resolve,delay*(attempt+1)));
  }
 }
}

// Keep Jev's node cache in a private remote handle, not on the site's window.
// Functions still run against the real DOM; no browser identity is overridden.
export function privateJevPage(page){
 const frames=new WeakMap(),handles=new WeakMap();
 const scope=`const window=new Proxy(globalThis,{get(target,key){return key==='__jevFast'||key==='__jobloopFieldContext'?state[key]:Reflect.get(target,key,target);},set(target,key,value){if(key==='__jevFast'||key==='__jobloopFieldContext'){state[key]=value;return true;}return Reflect.set(target,key,value,target);}});`;
 const compiled=(fn,node=false)=>new Function(node?'element':'state',node?'payload':'arg',`${node?'const [state,arg]=payload;':''}${scope}return ${typeof fn==='string'?`(${fn})`:`(${fn.toString()})(${node?'element,arg':'arg'})`};`);
 function frameState(frame){
  let entry=frames.get(frame);if(!entry){entry={};frames.set(frame,entry);}return entry;
 }
 function invalidate(frame,entry=frames.get(frame)){
  if(frames.get(frame)===entry)frames.delete(frame);
  entry?.pending?.then(handle=>handle.dispose()).catch(()=>{});
 }
 async function state(frame){const entry=frameState(frame);return entry.pending??=frame.evaluateHandle(()=>({})).catch(error=>{entry.pending=null;throw error;});}
 function wrapHandle(handle,frame){
  if(!handle)return handle;if(handles.has(handle))return handles.get(handle);
  const proxy=new Proxy(handle,{get(target,key){
   if(key==='evaluate'||key==='evaluateHandle')return async(fn,arg)=>{
    const entry=frameState(frame);
    try{const result=await target[key](compiled(fn,true),[await state(frame),arg]);return key==='evaluateHandle'?wrapHandle(result,frame):result;}
    catch(error){if(transientRead(error))invalidate(frame,entry);throw error;}
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
    const entry=frameState(frame);
    try{const remote=await state(frame),result=await remote[key](compiled(fn),arg);return key==='evaluateHandle'?wrapHandle(result,frame):result;}
    catch(error){if(transientRead(error))invalidate(frame,entry);throw error;}
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});wrappedFrames.set(frame,proxy);return proxy;
 }
 page.on('framenavigated',frame=>invalidate(frame));
 return new Proxy(page,{get(target,key){
  if(key==='evaluate'||key==='evaluateHandle')return (...args)=>wrapFrame(target.mainFrame())[key](...args);
  if(key==='frames')return ()=>target.frames().map(wrapFrame);
  if(key==='mainFrame')return ()=>wrapFrame(target.mainFrame());
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
}
