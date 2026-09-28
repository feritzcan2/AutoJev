import {existsSync} from 'node:fs';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runtimeResourceRoot} from './runtime-paths.mjs';
import {findExecutable} from './chrome-installation.mjs';
import {homedir} from 'node:os';
const exec=promisify(execFile);
export const sourceIntegrations=[
 {id:'linkedin',name:'LinkedIn',url:'https://www.linkedin.com/jobs/',market:'global'},
 {id:'freehire',name:'FreeHire',url:'https://freehire.me/',market:'global'},
 {id:'jobindex',name:'Jobindex',url:'https://www.jobindex.dk/',market:'DK'},
 {id:'jobnet',name:'Jobnet',url:'https://jobnet.dk/',market:'DK'},
 {id:'jobdanmark',name:'Jobdanmark',url:'https://jobdanmark.dk/',market:'DK'},
 {id:'jobbank',name:'Akademikernes Jobbank',url:'https://jobbank.dk/',market:'DK'},
];
export function integration(id){return sourceIntegrations.find(x=>x.id===id);}
export function validateSourceSearch(input,previous={}){
 const method=input.searchMethod??previous.searchMethod??'free',integrationId=input.integrationId===undefined?previous.integrationId??null:input.integrationId;
 if(!['free','browser','tool'].includes(method))throw Error('Geçersiz arama yöntemi');
 if(integrationId&&!integration(integrationId))throw Error('Bilinmeyen hazır araç');
 const skillText=input.skillText??previous.skillText??null;
 if(skillText!==null&&(typeof skillText!=='string'||skillText.length>60000||!skillText.trim()))throw Error('Skill metni boş olamaz (en fazla 60000 karakter)');
 const customTool=input.customTool===undefined?previous.customTool??null:input.customTool;
 if(customTool&&(!path.isAbsolute(customTool.command??'')||!Array.isArray(customTool.args)||customTool.args.some(a=>typeof a!=='string'||a.length>3000)||customTool.args.length>40))throw Error('Özel araç için mutlak dosya yolu ve JSON argüman listesi gerekli');
 if(method==='tool'&&!integrationId&&!customTool)throw Error('Araç yöntemi için hazır veya özel araç seç');
 const fallback=input.fallback??previous.fallback??'web';if(!['web','browser','none'].includes(fallback))throw Error('Geçersiz alternatif yöntem');
 return{searchMethod:method,integrationId,skillText,customTool,fallback};
}
export async function sourceInstructions(root,source){
 const resources=runtimeResourceRoot({root});
 const builtin=integration(source.integrationId);
 const upstream=builtin?await readFile(path.join(root,'vendor/ai-job-search/.agents/skills',builtin.id+'-search/SKILL.md'),'utf8'):null;
 const legacyDefault=`---\nname: jobloop-source-${source.kind}\ndescription: Search this JobLoop source using the configured method and candidate preferences.\n---\nSearch ${source.name} (${source.url}) within the candidate's actual role, country, remote and salary preferences. Verify listing URLs and record current jobs through JobLoop MCP. Do not invent listings.\n`;
 const custom=source.skillText&&source.skillText!==legacyDefault;
 const base=custom?source.skillText:upstream??legacyDefault;
 return{sourceId:source.id,name:source.name,searchMethod:source.searchMethod??'free',fallback:source.fallback??'web',skillOrigin:custom?'custom':upstream?'upstream':'jobloop',skillText:base,tool:source.customTool??(builtin?{command:'bun',args:['run',resources!==root?path.join(resources,'dist/source-tools',builtin.id+'.mjs'):path.join(root,'vendor/ai-job-search/.agents/skills',builtin.id+'-search/cli/src/cli.ts')]}:null),...(upstream&&upstream!==base?{toolReference:upstream}:{}),upstream:builtin?JSON.parse(await readFile(path.join(root,'vendor/ai-job-search/UPSTREAM.json'),'utf8')):null,
 workflow:'Record all discovered listings within the search scope, including uncertain and low-fit matches. Use only JobLoop rank-jobs and record_job_rank for scoring and selection; do not apply alternative source scoring or shortlist filters. Use this source skill for the current task. In tool mode invoke run_source_tool with CLI arguments documented in skillText (toolReference is supplied only when it differs from skillText); the app supplies the executable path. Read details for promising listings. Browser mode uses browser tools; free mode permits web search and browsing. Use only the configured fallback when a tool fails and report that failure. Save actual browser tabs through save_source_checkpoint when browsing. Check result URLs in batches through check_jobs before detail retrieval; reuse needsResearch=false results. Record new/pending jobs through add_job; JobLoop owns deduplication and history. Link observed employer vacancy URLs through link_job_url. Report the bounded task with report_campaign_work. Do not write upstream seen_jobs or tracker files. Do not rewrite the CV. Never apply during a search task.'};
}
export async function runSourceTool(root,source,args,{test=false,execute=exec}={}){
 if(!Array.isArray(args)||args.length>50||args.some(x=>typeof x!=='string'||x.length>4000))throw Error('Geçersiz araç argümanları');
 if(!test&&source.searchMethod!=='tool')throw Error('Bu kaynak araç modunda değil');
 const config=await sourceInstructions(root,source);if(!config.tool)throw Error('Bu kaynakta araç yok');
 const command=config.tool.command==='bun'?(process.env.JOBLOOP_BUN||await findExecutable('bun')||['/opt/homebrew/bin/bun','/usr/local/bin/bun',path.join(homedir(),'.bun/bin',process.platform==='win32'?'bun.exe':'bun')].find(p=>existsSync(p))||'bun'):config.tool.command;
 try{const result=await execute(command,[...config.tool.args,...args],{cwd:runtimeResourceRoot({root}),timeout:test?20000:60000,maxBuffer:2000000,env:{...process.env,NO_COLOR:'1'}});return{ok:true,output:result.stdout,diagnostic:result.stderr};}
 catch(e){return{ok:false,output:String(e.stdout??'').slice(0,20000),diagnostic:String(e.stderr||e.message).slice(0,12000)};}
}
