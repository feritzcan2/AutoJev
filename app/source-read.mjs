import {boundedText,webUrl} from './automation-templates.mjs';
import {SOURCE_TOOL_IDS} from './source-tool-ids.mjs';
import {scanIssue,clearScanIssue} from './scan-issues.mjs';

// CLI processes belong to the provider. This is explicitly an agent report,
// never browser evidence and never evidence of a submitted action.
export const sourceReadSchema={type:'object',additionalProperties:false,properties:{url:{type:'string'},command:{type:'string',minLength:1,maxLength:2000},summary:{type:'string',minLength:1,maxLength:2000},error:{type:'boolean'}},required:['url','command','summary']};
export function recordSourceRead(db,id,runId,input){
 const run=db.activeRun(id,runId),tool=db.get(id).sourceSettings?.[run.sourceUrl]?.tool;
 if(!run.sourceUrl||run.recordId||!['trial','run'].includes(run.kind)||!SOURCE_TOOL_IDS.includes(tool))throw Error('CLI raporu yalnızca araç bağlı kaynak denemesi veya taramasında kullanılabilir');
 const read={url:webUrl(input.url),command:boundedText(input.command,'Çalıştırılan komut',2000),summary:boundedText(input.summary,'CLI yanıtı',2000),error:input.error===true,tool,at:db.now(),reportedBy:'agent'};
 const navigation=read.error?run.navigation??[]:[...(run.navigation??[]),{url:read.url,at:read.at,method:'cli',tool}];
 db.putRun({...run,sourceReads:[...(run.sourceReads??[]),read].slice(-20),navigation});
 if(read.error)scanIssue(db,id,runId,{url:read.url,kind:'source_tool_error',evidence:read.summary,verified:true,global:true});
 else clearScanIssue(db,id,runId,read.url);
 return {url:read.url,text:read.summary,method:'cli'};
}
