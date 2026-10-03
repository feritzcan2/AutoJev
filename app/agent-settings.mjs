import {DEFAULT_COMPACT_TOKENS} from './context-compaction.mjs';
import {withoutContextPercentages} from './context-settings-migration.mjs';

export const defaultPermission=provider=>provider==='claude'?'auto':provider==='codex'?'bypassPermissions':'default';

export function withAgentDefaults(settings={}){
 settings=withoutContextPercentages(settings);
 const provider=settings.provider??'codex';
 return {model:'default',reasoning:'default',network:null,contextCompactTokens:DEFAULT_COMPACT_TOKENS,contextRestartTokens:0,...settings,provider,permission:settings.permission??defaultPermission(provider)};
}
