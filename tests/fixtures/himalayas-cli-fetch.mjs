// Synthetic HTTP transport used only by CLI child-process tests.
globalThis.fetch=async(value,{signal,method,body}={})=>{
 if(process.env.JOBLOOP_TEST_COLLECT_WAIT==='1')await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 signal?.throwIfAborted();const url=new URL(value),page=Number(url.searchParams.get('page')??1);
 if(url.hostname==='mcp.himalayas.app'){
  if(method==='GET')return new Response('',{status:405});
  const request=JSON.parse(body);if(request.id==null)return new Response(null,{status:202});
  const result=request.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}}:{content:[{type:'text',text:'# Synthetic detail\n## Job Description\nShort but complete synthetic detail.'}]};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
 }
 if(process.env.JOBLOOP_TEST_COLLECT_FAILURE==='1'&&page===2)return new Response('',{status:403});
 const jobs=[{guid:`https://himalayas.app/companies/synthetic/jobs/role-${page}`,title:`Synthetic role ${page}`,companyName:'Synthetic Co',description:'<p>RAM_ONLY_DESCRIPTION_9724</p>',excerpt:'Synthetic summary',locationRestrictions:page===1?Array.from({length:200},(_,i)=>`Synthetic country ${i}`):['Germany']}];
 return new Response(JSON.stringify({jobs,offset:(page-1)*20,limit:20,totalCount:21}),{headers:{'content-type':'application/json'}});
};
