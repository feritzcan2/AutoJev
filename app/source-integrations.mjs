import {existsSync} from 'node:fs';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {runtimeResourceRoot} from './runtime-paths.mjs';
import {findExecutable} from './chrome-installation.mjs';
import {homedir} from 'node:os';
import {sourceMethodGuidance} from './source-method.mjs';
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
 workflow:'Record all discovered listings within the search scope, including uncertain and low-fit matches. Use only JobLoop rank-jobs and record_job_rank for scoring and selection; do not apply alternative source scoring or shortlist filters. Resume source.scanProgress before fresh searching. Save pending listing URLs and the exact next page or query with save_source_progress while working. In tool mode invoke run_source_tool with CLI arguments documented in skillText (toolReference is supplied only when it differs from skillText); the app supplies the executable path. Read details for promising listings. Browser mode uses browser tools; free mode permits web search and browsing. Use only the configured fallback when a tool fails and report that failure. Save actual browser tabs through save_source_checkpoint when browsing. Check result URLs in batches through check_jobs before detail retrieval; reuse needsResearch=false results. Record new/pending jobs through add_job; JobLoop owns deduplication and history. Link observed employer vacancy URLs through link_job_url. Report coverage with report_campaign_work: complete only when no work remains, partial with continuation otherwise. Do not write upstream seen_jobs or tracker files. Do not rewrite the CV. Never apply during a search task.'};
}
export async function runSourceTool(root,source,args,{test=false,execute=exec}={}){
 if(!Array.isArray(args)||args.length>50||args.some(x=>typeof x!=='string'||x.length>4000))throw Error('Geçersiz araç argümanları');
 if(!test&&source.searchMethod!=='tool')throw Error('Bu kaynak araç modunda değil');
 const config=await sourceInstructions(root,source);if(!config.tool)throw Error('Bu kaynakta araç yok');
 const command=config.tool.command==='bun'?(process.env.JOBLOOP_BUN||await findExecutable('bun')||['/opt/homebrew/bin/bun','/usr/local/bin/bun',path.join(homedir(),'.bun/bin',process.platform==='win32'?'bun.exe':'bun')].find(p=>existsSync(p))||'bun'):config.tool.command;
 try{const result=await execute(command,[...config.tool.args,...args],{cwd:runtimeResourceRoot({root}),timeout:test?20000:60000,maxBuffer:2000000,env:{...process.env,NO_COLOR:'1'}});return{ok:true,output:result.stdout,diagnostic:result.stderr};}
 catch(e){return{ok:false,output:String(e.stdout??'').slice(0,20000),diagnostic:String(e.stderr||e.message).slice(0,12000)};}
}

export async function workspaceSourceInstructions(root,source,{learnedSkill=null}={}){
 const config=await sourceInstructions(root,source);
 if(config.skillOrigin==='jobloop')config.skillText=`Search ${source.name} (${source.url}) within the saved workspace goal, criteria and source query. Verify exact result URLs and facts. Preserve unknowns and resume saved scan progress.`;
 return {...config,learnedSkill,workflow:sourceMethodGuidance(source)+'Read learnedSkill as observed method notes; use current criteria and source query for actual search values. User instructions and the editable skillText take precedence. Unverified sections and needsReview require fresh checks. Use get_automation_context for scope and permissions. Read the configured source skill and CLI documentation. A source URL is a starting point, not a restriction to its homepage or hostname. Resume observed pending URLs and reuse sourceExamples and saved result URLs as discovery seeds (historical leads, not current availability). If the starting page is a product site, account dashboard, redirect or 404, discover task-relevant public result pages through the managed browser, following saved template guidance and observed links. Do not guess routes repeatedly or ask the user for a company list before researching. Do not mistake an optional account portal for a mandatory login to public results. Only report access blocked for the intended data after checking relevant routes; a marketing homepage alone does not prove empty results or completed coverage. In tool mode use run_workspace_source_tool; read its snapshot with browser_read_part when paged, checkpoint observed result URLs with save_scan_progress and use the exact args JSON as cursor. Resume that cursor and remaining details before advancing the documented CLI page parameter. Tool output is an observation, not browser action confirmation. Follow the configured fallback on failure. Save findings with record_automation_result and typed table cells. Use lookup_scan_results for duplicates and save_scan_progress for observed browser checkpoints. Complete the assigned work with finish_automation_run. Do not use legacy application MCP tools or upstream tracker files.'};
}
