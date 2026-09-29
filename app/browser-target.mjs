// Keyboard adapter for a current element ref. This only resolves the target;
// action authority is the automation agent's responsibility.
export async function pressBrowserTarget(client,jev,args,owner){
 if(typeof args.key!=='string'||!args.key.trim())throw Error('Tuş gerekli');
 if(!jev){
  if(!/^(?:f\d+)*e\d+$/.test(args.ref))throw Error('Sayfa gözlemindeki ref gerekli');
  const focused=await client.callTool({name:'browser_evaluate',arguments:{function:'e => e.focus()',element:'Observed keyboard target',target:args.ref}});
  if(focused.isError)return focused;
  return client.callTool({name:'browser_press_key',arguments:{key:args.key}});
 }
 const slot=client.tab(args.tabId),saved=slot.fillFields?.get(args.ref)??slot.clickTargets?.get(args.ref)??slot.controls?.get(args.ref)??slot.cookieFrameTargets?.get(args.ref);
 if(!saved||saved.owner!==owner||slot.owner!==owner)throw Error('Bu oturumun güncel hedefi gerekli');
 let handle=saved.input,dispose=false;
 try{
  if(!handle){handle=await slot.page.evaluateHandle(node=>window.__jevFast?.nodes.get(node),saved.action?.node??saved.node);dispose=true;}
  slot.pending=null;await handle.press(args.key,{timeout:2000});
  return {content:[{type:'text',text:JSON.stringify({...await client.observe(slot),executed:true,status:'ready'})}]};
 }finally{if(dispose)await handle?.dispose();}
}
