export const defaultPermission=provider=>provider==='claude'?'auto':provider==='codex'?'bypassPermissions':'default';

export function withAgentDefaults(settings={}){
 const provider=settings.provider??'codex';
 return {model:'default',reasoning:'default',network:null,contextRestartPercent:0,...settings,provider,permission:settings.permission??defaultPermission(provider)};
}
