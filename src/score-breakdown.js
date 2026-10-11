import {eligibilityLabels, assessmentEligibility} from './scoring-state.js';
const labels = {
  technical: 'Technical / professional fit',
  experience: 'Experience',
  role: 'Role',
  preferences: 'Work preferences',
};
const levels = {
  direct: 'Direct',
  partial: 'Partial',
  transferable: 'Transferable',
  unknown: 'Not verified',
  mismatch: 'Mismatch',
};
const matches = {
  met: 'Met',
  partial: 'Partial',
  unknown: 'Not verified',
  unmet: 'Not met',
};
const sources = {cv: 'CV', facts: 'Profile', preferences: 'Preferences'};
const el = (tag, text) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  return node;
};
export function scoreBreakdown(assessment) {
  const root = el('section');
  root.className = 'record-score-breakdown';
  root.setAttribute('aria-label', 'Score breakdown');
  root.append(el('p', eligibilityLabels[assessmentEligibility(assessment)]));
  if (assessment.eligibilityReason) root.append(el('p', assessment.eligibilityReason));
  const c = assessment.calculation;
  if (!c) {
    if (assessment.score !== null)
      root.append(el('p', 'The score was saved from the agent assessment.'));
    return root;
  }
  root.append(el('h4', 'Score breakdown'));
  const table = el('table'),
    head = el('thead'),
    titles = el('tr'),
    body = el('tbody');
  for (const label of ['Criterion', 'Match', 'Score', 'Weight', 'Contribution']) {
    const th = el('th', label);
    th.scope = 'col';
    titles.append(th);
  }
  head.append(titles);
  for (const d of c.dimensions) {
    const row = el('tr');
    for (const text of [
      labels[d.key],
      levels[d.level],
      d.points + '/100',
      '%' + d.weight,
      Number(d.contribution.toFixed(2)),
    ])
      row.append(el('td', text));
    body.append(row);
  }
  table.append(head, body);
  root.append(table);
  root.append(
    el(
      'p',
      c.cap === null
        ? `Weighted total: ${c.score}/100.`
        : `Weighted total: ${c.rawScore}/100 · Requirement cap: ${c.cap} · Result: ${c.score}/100.`,
    ),
  );
  if (c.eligibility !== 'verified')
    root.append(
      el(
        'p',
        c.eligibility === 'mismatch'
          ? 'A required condition or the core fit is not met.'
          : 'The required conditions or the core fit are not fully verified yet.',
      ),
    );
  const evidence = el('details');
  evidence.append(el('summary', 'Criterion evidence and required conditions'));
  for (const d of [...c.dimensions, ...c.requirements]) {
    const item = el('div');
    item.append(
      el(
        'h4',
        d.key
          ? labels[d.key] + ' · ' + levels[d.level]
          : 'Required condition · ' + matches[d.match],
      ),
      el('p', d.reason),
    );
    if (d.listingQuote) item.append(el('p', 'Listing: ' + d.listingQuote));
    item.append(
      el(
        'p',
        d.candidateQuote
          ? `${sources[d.candidateSource]}: ${d.candidateQuote}`
          : 'Candidate evidence not verified.',
      ),
    );
    evidence.append(item);
  }
  root.append(evidence);
  return root;
}
