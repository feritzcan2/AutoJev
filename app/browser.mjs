import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createRequire} from 'node:module';
import path from 'node:path';
import {mkdir,readFile,realpath,stat} from 'node:fs/promises';
const require=createRequire(import.meta.url);

export function browserArguments(mode,directory){
  if(mode==='existing')throw Error('Mevcut Chrome, Codex’in kendi tarayıcı araçlarıyla kullanılır.');
  if(mode==='separate')return ['--browser','chrome','--user-data-dir',path.join(directory,'profile')];
  throw Error('Unknown browser mode');
}
export class BrowserTools {
  constructor(directory,modeForCandidate=()=> 'existing'){this.directory=directory;this.modeForCandidate=modeForCandidate;this.clients=new Map();}
  async connect(candidateId){
    const mode=this.modeForCandidate(candidateId)??'existing';
    const previous=this.clients.get(candidateId);
    if(previous?.mode===mode)return previous.pending;
    if(previous)await(await previous.pending).client.close();
    const pending=this.open(candidateId,mode).catch(error=>{this.clients.delete(candidateId);throw error;});
    this.clients.set(candidateId,{mode,pending});return pending;
  }
  async open(candidateId,mode){
    const directory=path.join(this.directory,'browsers',candidateId);
    const workspace=path.join(this.directory,'candidates',candidateId);
    await mkdir(workspace,{recursive:true,mode:0o700});
    await mkdir(directory,{recursive:true,mode:0o700});
    const cli=path.join(path.dirname(require.resolve('@playwright/mcp/package.json')),'cli.js');
    const transport=new StdioClientTransport({command:process.execPath,args:[cli,...browserArguments(mode,directory),'--output-dir',path.join(directory,'artifacts')],cwd:workspace,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stderr:'pipe'});
    const client=new Client({name:'jobloop-browser',version:'0.1.0'});
    try{await client.connect(transport);const {tools}=await client.listTools();return{client,tools,directory,workspace};}
    catch(error){await transport.close();throw error;}
  }
  async tools(candidateId){if((this.modeForCandidate(candidateId)??'existing')==='existing')return [];return(await this.connect(candidateId)).tools;}
  async call(candidateId,name,args){
    const {client,tools,directory,workspace}=await this.connect(candidateId);
    if(!tools.some(t=>t.name===name))throw Error('Unknown browser tool');
    const result=await client.callTool({name,arguments:args});
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
  async close(){for(const {pending} of this.clients.values()){try{await(await pending).client.close();}catch{}}this.clients.clear();}
}
