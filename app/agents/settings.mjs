// @ts-check
import {DEFAULT_COMPACT_TOKENS} from './context-compaction.mjs';

export const defaultPermission = (provider) =>
  provider === 'claude' ? 'auto' : provider === 'codex' ? 'bypassPermissions' : 'default';
// Who makes the listing decisions inside browser tasks: the Jev model
// (TypeSafe key) or the worker agent itself, through its next tool call.
export const DECISION_MODES = ['jev', 'agent'];
export const agentDecides = (settings) => (settings?.decisions ?? 'agent') === 'agent';

export function withAgentDefaults(settings = {}) {
  const provider = settings.provider ?? 'codex';
  return {
    model: provider === 'claude' ? 'haiku' : 'default',
    ...(provider === 'claude' ? {trialModel: 'opus[1m]', contactModel: 'opus[1m]'} : {}),
    reasoning: provider === 'claude' ? 'medium' : 'default',
    network: null,
    contextCompactTokens: provider === 'claude' ? 200000 : DEFAULT_COMPACT_TOKENS,
    contextRestartTokens: 0,
    ...settings,
    provider,
    permission: settings.permission ?? defaultPermission(provider),
    decisions: settings.decisions ?? 'agent',
  };
}

// A new profile's setup chat starts on each provider's strongest model.
export const SETUP_MODELS = {claude: 'opus', codex: 'gpt-6-astra'};
export function withSetupAgentDefaults(settings = {}) {
  const s = withAgentDefaults(settings);
  return {...s, model: settings.model ?? SETUP_MODELS[s.provider] ?? s.model};
}
