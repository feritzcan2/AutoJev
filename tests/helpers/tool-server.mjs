import {startToolServer} from '../../app/tool-server.mjs';

export function startTestServer(core,defaultWorkflow=null){
 return startToolServer({defaultWorkflow,assertOwner:id=>core.workspaces.get(id),resolve:grant=>{
  if(!grant.workflow)throw Error('Test must grant an explicit workspace workflow');
  return grant.workflow;
 }});
}
