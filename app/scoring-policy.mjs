import {createHash} from 'node:crypto';
import {scoreThresholdValue, saveScoreThreshold} from './score-thresholds.mjs';

import {SCORING_VERSION} from '../src/scoring-state.js';
export {SCORING_VERSION};
// Scoring is the same for every template. The rubric is the workspace's own
// criteria.ranking text, written by the setup agent for its goal.
export const SCORING_INSTRUCTIONS = `Score each record 0–100 against criteria.ranking. If criteria.ranking is empty, score against the goal and the other saved criteria.
1. Read the record's details and the saved profile (read_scoring_profile: facts, preferences, documents). Missing facts stay unknown; never invent them.
2. Only score is required. Reasons, strengths, gaps and uncertainties are optional.
3. Save eligibility separately: verified when the record's mandatory conditions are established, mismatch for a confirmed unmet mandatory condition, unverified when information is missing or ambiguous. Do not lower the score because of eligibility.
4. Unreadable details: status=unavailable and score=null.
5. During source scans, submit assessed findings with their actual scores. When scoringPolicy.saveThreshold is set, new findings below it are skipped by the app instead of saved; count skipped receipts as exclusions and acknowledge the Jev batch without retrying them. Equal scores qualify for saving. An unset saveThreshold keeps low scores too. Never treat missing or unreadable details as a low score; use score=null and report the reading failure. Existing records and manual rescoring are retained.
6. scoringPolicy.threshold only decides which records qualify for automatic actions: a lower or missing score never qualifies, and a high score never authorizes an action.`;
export function scoringPolicy(automation) {
  const criteria = automation.criteria ?? {};
  const threshold = scoreThresholdValue(criteria, 'score_threshold', 'Puanlama eşiği') ?? 60;
  if (threshold < 1) throw Error('Puanlama eşiği 1–100 arasında olmalı.');
  const saveThreshold = saveScoreThreshold(criteria);
  const policy = {version: SCORING_VERSION, threshold, saveThreshold};
  return {
    ...policy,
    digest: createHash('sha256')
      .update(JSON.stringify([policy, automation.revision, criteria.ranking ?? '']))
      .digest('hex'),
    instructions: SCORING_INSTRUCTIONS,
  };
}
