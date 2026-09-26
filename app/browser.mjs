import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createRequire} from 'node:module';
import path from 'node:path';
import {mkdir,readFile,realpath,stat} from 'node:fs/promises';
import {JevBrowser,jevTools} from './jev-browser.mjs';
const require=createRequire(import.meta.url);

export function browserArguments(mode,directory){
  if(mode==='existing')throw Error('Mevcut Chrome, Codex’in kendi tarayıcı araçlarıyla kullanılır.');
  if(mode==='separate')return ['--browser','chrome','--user-data-dir',path.join(directory,'profile')];
  throw Error('Unknown browser mode');
}
export class BrowserTools {
  constructor(directory,modeForCandidate=()=> 'existing',jevOptionsForCandidate=()=>({})){this.directory=directory;this.modeForCandidate=modeForCandidate;this.jevOptionsForCandidate=jevOptionsForCandidate;this.clients=new Map();}
  async connect(candidateId){
    const mode=this.modeForCandidate(candidateId)??'existing';
    const options=this.jevOptionsForCandidate(candidateId),key=JSON.stringify({mode,profile:options.profile?.directory,connection:options.connection});
    const previous=this.clients.get(candidateId);
    if(previous?.key===key)return previous.pending;
    if(previous)await(await previous.pending).client.close();
    const pending=this.open(candidateId,mode,options).catch(error=>{this.clients.delete(candidateId);throw error;});
    this.clients.set(candidateId,{mode,key,pending});return pending;
  }
  async open(candidateId,mode,options={}){
    const directory=path.join(this.directory,'browsers',candidateId);
    const workspace=path.join(this.directory,'candidates',candidateId);
    await mkdir(workspace,{recursive:true,mode:0o700});
    await mkdir(directory,{recursive:true,mode:0o700});
    if(mode==='jev')return {client:new JevBrowser(path.join(directory,'jev-profile'),{...options,workspace}),tools:jevTools,directory,workspace};
    const cli=path.join(path.dirname(require.resolve('@playwright/mcp/package.json')),'cli.js');
    const transport=new StdioClientTransport({command:process.execPath,args:[cli,...browserArguments(mode,directory),'--output-dir',path.join(directory,'artifacts')],cwd:workspace,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stderr:'pipe'});
    const client=new Client({name:'jobloop-browser',version:'0.1.0'});
    try{await client.connect(transport);const {tools}=await client.listTools();return{client,tools,directory,workspace};}
    catch(error){await transport.close();throw error;}
  }
  async tools(candidateId){const mode=this.modeForCandidate(candidateId)??'existing';if(mode==='existing')return [];if(mode==='jev')return jevTools;return(await this.connect(candidateId)).tools;}
  async call(candidateId,name,args,sessionId){
    const {client,tools,directory,workspace}=await this.connect(candidateId);
    if(!tools.some(t=>t.name===name))throw Error('Unknown browser tool');
    const result=await (client instanceof JevBrowser?client.callTool({name,arguments:args},sessionId):client.callTool({name,arguments:args}));
    // Newer Playwright versions return snapshot files. Inline only this candidate's
    // bounded browser artifacts, so the agent can act without filesystem access.
    for(const part of [...(result.content??[])]){
      if(part.type!=='text')continue;
      for(const match of part.text.matchAll(/\[Snapshot\]\(([^)]+\.yml)\)/g)){
        try{
          const file=await realpath(path.resolve(workspace,match[1]));
          const artifacts=await realpath(path.join(directory,'artifacts'));
          if(!file.startsWith(artifacts+path.sep)||(await stat(file)).size>512000)continue;
          const snapshot=await readFile(file,'utf8');
          result.content.push({type:'text',text:snapshot.slice(0,100000)});
        }catch{/* Keep the original artifact reference if it was removed. */}
      }
    }
    return result;
  }
  async focus(candidateId,context){
    if(this.modeForCandidate(candidateId)!=='jev')throw Object.assign(Error('Bu aday için Jev tarayıcı modu seçili değil.'),{code:'BROWSER_MODE_CHANGED'});
    return (await this.connect(candidateId)).client.focus(context.tabId);
  }
  async close(){for(const {pending} of this.clients.values()){try{await(await pending).client.close();}catch{}}this.clients.clear();}
}
