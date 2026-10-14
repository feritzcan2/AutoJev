// @ts-check
import {DEFAULT_COMPACT_TOKENS} from './context-compaction.mjs';

export const defaultPermission = (provider) =>
  provider === 'claude' ? 'auto' : provider === 'codex' ? 'bypassPermissions' : 'default';

export function withAgentDefaults(settings = {}) {
  const provider = settings.provider ?? 'codex';
  return {
    model: provider === 'claude' ? 'haiku' : 'default',
    ...(provider === 'claude' ? {trialModel: 'opus[1m]'} : {}),
    reasoning: provider === 'claude' ? 'medium' : 'default',
    network: null,
    contextCompactTokens: provider === 'claude' ? 200000 : DEFAULT_COMPACT_TOKENS,
    contextRestartTokens: 0,
    ...settings,
    provider,
    permission: settings.permission ?? defaultPermission(provider),
  };
}
