import {DEFAULT_COMPACT_PERCENT} from './context-compaction.mjs';

export const defaultPermission=provider=>provider==='claude'?'auto':provider==='codex'?'bypassPermissions':'default';

export function withAgentDefaults(settings={}){
 const provider=settings.provider??'codex';
 return {model:'default',reasoning:'default',network:null,contextCompactPercent:DEFAULT_COMPACT_PERCENT,contextRestartPercent:0,...settings,provider,permission:settings.permission??defaultPermission(provider)};
}
