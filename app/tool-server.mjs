import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {validate} from './tool-schema.mjs';

export async function startToolServer({resolve,assertOwner,onHook=async()=>({accepted:false}),defaultWorkflow=null,onExchange=()=>{}}){
 const grants=new Map();
 const observe=(grant,event)=>{try{onExchange(grant,event);}catch{ /* Logging cannot turn a completed tool call into a retry. */ }};
 const server=createServer(async(req,res)=>{
  const reply=(code,body)=>{const payload=body===undefined?'':JSON.stringify(body);res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':Buffer.byteLength(payload)});res.end(payload);};
  if(req.url==='/agent-observation'&&req.method==='POST'&&!req.headers.origin){
   let size=0,parts=[];try{for await(const part of req){size+=part.length;if(size>128*1024)return reply(413,{error:'Too large'});parts.push(part);}const hook=JSON.parse(Buffer.concat(parts));return reply(200,{id:hook.id,...await onHook(hook)});}catch{return reply(400,{accepted:false});}
  }
  if(req.url!=='/mcp')return reply(404,{error:'Not found'});
  if(req.headers.origin)return reply(403,{error:'Origin not permitted'});
  const token=(req.headers.authorization??'').replace(/^Bearer /,''),entry=[...grants.entries()].find(([key])=>key.length===token.length&&timingSafeEqual(Buffer.from(key),Buffer.from(token)));
  if(!entry)return reply(401,{error:'Unauthorized'});
  const grant=entry[1];let protocol;
  try{protocol=resolve(grant);}catch{return reply(401,{error:'Worker session closed'});}
  if(req.method!=='POST')return reply(405,{error:'POST required'});
  let bytes=0,parts=[];
  try{for await(const part of req){bytes+=part.length;if(bytes>128*1024)return reply(413,{error:'Request too large'});parts.push(part);}}catch{return;}
  let rpc;try{rpc=JSON.parse(Buffer.concat(parts));}catch{return reply(400,{error:'Invalid JSON'});}
  if(!rpc||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string')return reply(400,{error:'Invalid JSON-RPC'});
  if(rpc.id===undefined)return reply(202);
  const result=value=>reply(200,{jsonrpc:'2.0',id:rpc.id,result:value});
  if(rpc.method==='initialize')return result({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'jobloop',version:'0.1.0'}});
  if(rpc.method==='ping')return result({});
  if(rpc.method==='tools/list'){try{const value={tools:protocol.listTools?await protocol.listTools():protocol.tools};result(value);observe(grant,{kind:'tool_catalog',name:'tools/list',result:value});return;}catch(error){return reply(200,{jsonrpc:'2.0',id:rpc.id,error:{code:-32603,message:error.message}});}}
  if(rpc.method!=='tools/call')return reply(200,{jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Method not found'}});
  try{
   if(!grants.has(token))throw Error('Worker oturumu kapandı.');
   protocol=resolve(grant);const name=rpc.params?.name,args=rpc.params?.arguments??{};
   if(protocol.callResult){const value=await protocol.callResult(name,args);result(value);observe(grant,{name,result:value});return;}
   const execute=()=>{const definition=protocol.tools.find(t=>t.name===name);if(!definition)throw Error('Unknown tool');validate(definition.inputSchema,args);return protocol.call(grant.workspaceId,grant.sessionId,name,args);};
   const value=await (protocol.guardToolCall?protocol.guardToolCall(name,args,execute):execute()),response={content:[{type:'text',text:JSON.stringify(value)}]};result(response);observe(grant,{name,result:response});return;
  }catch(error){const value={isError:true,content:[{type:'text',text:error.message}]};result(value);observe(grant,{name:rpc.params?.name??'',result:value});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {endpoint:`http://127.0.0.1:${server.address().port}/mcp`,grant(workspaceId,sessionId,workerId='main',workflow=defaultWorkflow){if(workflow?.assertOwner)workflow.assertOwner(workspaceId);else assertOwner(workspaceId);const token=randomBytes(32).toString('hex');grants.set(token,{workspaceId,sessionId,workerId,workflow});return token;},revoke(token){grants.delete(token);},close(){server.closeAllConnections();return new Promise(r=>server.close(r));}};
}
