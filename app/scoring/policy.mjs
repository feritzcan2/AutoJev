// @ts-check
import {createHash} from 'node:crypto';
import {autoApplyThreshold, saveScoreThreshold} from './thresholds.mjs';
import {parseHardRules} from '../../src/hard-rules.js';

import {SCORING_VERSION} from '../../src/scoring-state.js';
export {SCORING_VERSION};
// Scoring is the same for every template. The rubric is the workspace's own
// criteria.ranking text, written by the setup agent for its goal.
export const SCORING_INSTRUCTIONS = `Score each record 0–100 against criteria.ranking. If criteria.ranking is empty, score against the goal and the other saved criteria.
1. Read the record's details and the saved profile (read_scoring_profile: facts, preferences, documents). Missing facts stay unknown; never invent them.
2. Only score is required. Reasons, strengths, gaps and uncertainties are optional.
3. Elimination rules: when scoringPolicy.hardRules is listed, answer EVERY rule in rules as {rule: its number, result, evidence}: pass when the record establishes the rule, fail when the record explicitly contradicts it, unknown when the record does not say. A rule for one case only ("Outside Berlin, …", "For remote roles, …") passes when the record is not in that case. Evidence is a short quote or fact from the record. The app decides eligibility from these answers with each rule's ifNotStated choice; do not send eligibility then, and do not lower the score because of a rule.
   Without hardRules, save eligibility separately: verified when the record's mandatory conditions are established, mismatch for a confirmed unmet mandatory condition, unverified when information is missing or ambiguous. A remote role limited to named countries or regions (an applicant location, a "Remote, US" style location, or timezone limits) is a mandatory location condition; a globally distributed team does not lift it. Do not lower the score because of eligibility. A mandatory condition the record never mentions stays unverified; an explicit conflicting statement is mismatch, and wording that only hints at a restriction stays unverified.
4. Unreadable details: status=unavailable and score=null.
5. During source scans, submit assessed findings with their actual scores. When scoringPolicy.saveThreshold is set, new findings below it are skipped by the app instead of saved; count skipped receipts as exclusions and acknowledge the Jev batch without retrying them. Equal scores qualify for saving. An unset saveThreshold keeps low scores too. Never treat missing or unreadable details as a low score; use score=null and report the reading failure. Existing records and manual rescoring are retained.
6. scoringPolicy.threshold only decides which records qualify for automatic actions: a lower or missing score never qualifies, and a high score never authorizes an action.`;
export function scoringPolicy(automation) {
  const criteria = automation.criteria ?? {};
  const threshold = autoApplyThreshold(criteria);
  if (threshold < 1) throw Error('The scoring threshold must be between 1 and 100.');
  const saveThreshold = saveScoreThreshold(criteria);
  const hardRules = parseHardRules(criteria.hard_rules);
  const policy = {
    version: SCORING_VERSION,
    threshold,
    saveThreshold,
    ...(hardRules.length ? {hardRules} : {}),
  };
  return {
    ...policy,
    digest: createHash('sha256')
      .update(JSON.stringify([policy, automation.revision, criteria.ranking ?? '']))
      .digest('hex'),
    instructions: SCORING_INSTRUCTIONS,
  };
}
