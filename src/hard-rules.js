// @ts-check
// Elimination rules shared by the profile form, the setup agent, scoring and
// Jev. criteria.hard_rules stores one rule per line, starting with what a
// listing that never mentions the rule means. The scoring agent only answers
// pass/fail/unknown per rule; the eligibility follows from these answers here.
export const HARD_RULE_CHOICES = {
  accept: 'Accept if not stated',
  reject: 'Reject if not stated',
  hold: 'Hold if not stated',
};
export const MAX_HARD_RULES = 12;
const MAX_RULE_LENGTH = 400;
const prefix = new RegExp(`^(${Object.values(HARD_RULE_CHOICES).join('|')})\\s*:\\s*`, 'i');

/** @returns {{n: number, rule: string, ifNotStated: 'accept' | 'reject' | 'hold'}[]} */
export function parseHardRules(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ''))
    .filter(Boolean)
    .map((line, index) => {
      const match = prefix.exec(line);
      const choice = match
        ? /** @type {'accept' | 'reject' | 'hold'} */ (
            Object.keys(HARD_RULE_CHOICES).find(
              (key) => HARD_RULE_CHOICES[key].toLowerCase() === match[1].toLowerCase(),
            )
          )
        : 'hold';
      return {
        n: index + 1,
        rule: match ? line.slice(match[0].length).trim() : line,
        ifNotStated: choice,
      };
    })
    .filter((r) => r.rule);
}
export const formatHardRules = (rules) =>
  rules
    .filter((r) => r.rule.trim())
    .map((r) => `${HARD_RULE_CHOICES[r.ifNotStated] ?? HARD_RULE_CHOICES.hold}: ${r.rule.trim()}`)
    .join('\n');
// Canonical text for saving: every line gets an explicit choice.
export function normalizeHardRules(text) {
  const rules = parseHardRules(text);
  if (rules.length > MAX_HARD_RULES)
    throw Error(`Elimination rules: at most ${MAX_HARD_RULES} rules, one per line`);
  const long = rules.find((r) => r.rule.length > MAX_RULE_LENGTH);
  if (long)
    throw Error(`Elimination rule ${long.n}: at most ${MAX_RULE_LENGTH} characters; split it`);
  return formatHardRules(rules);
}

const RESULTS = ['pass', 'fail', 'unknown'];
/**
 * answers: [{rule: n, result: 'pass'|'fail'|'unknown', evidence?}] from the
 * scoring agent. Every rule needs an answer, so a forgotten rule is an error
 * the agent can fix instead of a silent elimination.
 */
export function hardRuleEligibility(rules, answers) {
  if (!Array.isArray(answers))
    throw Error(
      `arguments.rules: answer each of the ${rules.length} elimination rules in scoringPolicy.hardRules with {rule, result: pass|fail|unknown}`,
    );
  const byRule = new Map();
  for (const answer of answers) {
    if (!rules.some((r) => r.n === answer?.rule) || !RESULTS.includes(answer?.result))
      throw Error(
        'arguments.rules: each answer needs rule (a hardRules number) and result pass|fail|unknown',
      );
    byRule.set(answer.rule, answer);
  }
  const missing = rules.filter((r) => !byRule.has(r.n)).map((r) => r.n);
  if (missing.length)
    throw Error(
      `arguments.rules: answer elimination rule(s) ${missing.join(', ')} too (pass, fail or unknown)`,
    );
  const results = rules.map((r) => {
    const answer = byRule.get(r.n);
    return {
      rule: r.n,
      text: r.rule,
      ifNotStated: r.ifNotStated,
      result: answer.result,
      evidence: String(answer.evidence ?? '')
        .trim()
        .slice(0, 500),
    };
  });
  const failed = results.filter(
    (r) => r.result === 'fail' || (r.result === 'unknown' && r.ifNotStated === 'reject'),
  );
  const held = results.filter((r) => r.result === 'unknown' && r.ifNotStated === 'hold');
  const line = (r) =>
    `${r.result === 'fail' ? 'Not met' : 'Not stated'}: ${r.text}${r.evidence ? ` (${r.evidence})` : ''}`;
  return {
    eligibility: failed.length ? 'mismatch' : held.length ? 'unverified' : 'verified',
    eligibilityReason: (failed.length ? failed : held).map(line).join('\n'),
    ruleResults: results,
  };
}

// The rule that decided a record, for the table badge and filters: the first
// eliminating rule, otherwise the first held one. Records without rule answers
// return null and keep the plain eligibility label.
export function decidingRule(assessment) {
  const results = assessment?.ruleResults;
  if (!Array.isArray(results)) return null;
  const failed = results.find(
    (r) => r.result === 'fail' || (r.result === 'unknown' && r.ifNotStated === 'reject'),
  );
  if (failed) return {kind: 'eliminated', rule: failed};
  const held = results.find((r) => r.result === 'unknown' && r.ifNotStated === 'hold');
  return held ? {kind: 'held', rule: held} : null;
}
export const shortRule = (text, max = 32) =>
  text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
