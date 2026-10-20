// @ts-check
// Shared by browser-rendered templates and the server-side scoring policy.
export function scoreThresholdValue(criteria, key, label) {
  const raw = criteria[key];
  if (raw == null || String(raw).trim() === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100)
    throw Error(label + ': an integer from 0 to 100 is required.');
  return value;
}
// Find and apply needs an explicit minimum score; without one (older auto
// workspaces, automatic contact search) it is 70.
export const DEFAULT_SCORE_THRESHOLD = 70;
export const autoApplyThreshold = (criteria) =>
  scoreThresholdValue(criteria ?? {}, 'score_threshold', 'Minimum score for automatic action') ??
  DEFAULT_SCORE_THRESHOLD;
export function assertAutoApplyThreshold(plan) {
  if (plan.mode !== 'auto') return;
  const value = scoreThresholdValue(plan.criteria ?? {}, 'score_threshold', 'Minimum score');
  if (value === null || value < 1)
    throw Error('Find and apply needs a minimum score from 1 to 100.');
}
export const saveScoreThreshold = (criteria) =>
  scoreThresholdValue(criteria, 'save_score_threshold', 'Minimum score to save');
