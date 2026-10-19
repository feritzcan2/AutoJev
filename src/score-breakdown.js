import {HARD_RULE_CHOICES} from './hard-rules.js';
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
const ruleOutcome = (r) =>
  r.result === 'pass'
    ? {mark: '✓', tone: 'pass', note: 'Met'}
    : r.result === 'fail'
      ? {mark: '✗', tone: 'fail', note: 'Not met'}
      : {
          mark: r.ifNotStated === 'accept' ? '✓' : r.ifNotStated === 'reject' ? '✗' : '?',
          tone: r.ifNotStated === 'accept' ? 'pass' : r.ifNotStated === 'reject' ? 'fail' : 'hold',
          note: HARD_RULE_CHOICES[r.ifNotStated],
        };
// The elimination rules that did not pass, with the listing evidence. When
// every rule passed, one line says so.
export function ruleSummary(assessment) {
  const results = assessment.ruleResults;
  if (!Array.isArray(results)) {
    const reason = assessment.eligibilityReason;
    return reason ? el('p', reason) : null;
  }
  if (!results.length) return null;
  const box = el('div');
  box.className = 'record-rules';
  const open = results.filter((r) => ruleOutcome(r).tone !== 'pass');
  if (!open.length) {
    const line = el('p', `✓ All ${results.length} elimination rules met`);
    line.className = 'record-rules-ok';
    box.append(line);
    return box;
  }
  const list = el('ul');
  list.className = 'record-rule-list';
  list.setAttribute('aria-label', 'Elimination rules');
  for (const r of open) {
    const outcome = ruleOutcome(r),
      item = el('li'),
      mark = el('span', outcome.mark),
      body = el('div');
    item.dataset.tone = outcome.tone;
    mark.className = 'record-rule-mark';
    mark.setAttribute('aria-hidden', 'true');
    const head = el('p');
    head.append(el('span', r.text), el('small', outcome.note));
    body.append(head);
    if (r.evidence) body.append(el('q', r.evidence));
    item.append(mark, body);
    list.append(item);
  }
  const passed = results.length - open.length;
  box.append(el('h4', 'Elimination rules'), list);
  if (passed) box.append(el('small', `${passed} other rule${passed === 1 ? '' : 's'} met.`));
  box.append(el('small', 'To apply anyway, use Apply on the record.'));
  return box;
}
// How the score was calculated: the weighted criteria and their evidence.
export function scoreBreakdown(assessment) {
  const root = el('section');
  root.className = 'record-score-breakdown';
  root.setAttribute('aria-label', 'Score breakdown');
  const c = assessment.calculation;
  if (!c) {
    if (assessment.score !== null)
      root.append(el('p', 'The score was saved from the agent assessment.'));
    return root;
  }
  const table = el('table'),
    head = el('thead'),
    titles = el('tr'),
    body = el('tbody');
  for (const label of ['Criterion', 'Match', 'Weight', 'Points']) {
    const th = el('th', label);
    th.scope = 'col';
    titles.append(th);
  }
  head.append(titles);
  for (const d of c.dimensions) {
    const row = el('tr'),
      points = el('td'),
      bar = el('span'),
      fill = el('span');
    bar.className = 'record-score-bar';
    fill.style.width = Math.max(0, Math.min(100, d.points)) + '%';
    bar.append(fill);
    points.append(bar, el('span', String(Math.round(d.contribution))));
    points.title = `${d.points}/100 × ${d.weight}%`;
    row.dataset.level = d.level;
    row.append(
      el('td', labels[d.key]),
      el('td', levels[d.level]),
      el('td', d.weight + '%'),
      points,
    );
    body.append(row);
  }
  table.append(head, body);
  root.append(table);
  root.append(
    el(
      'p',
      c.cap === null
        ? `Weighted total: ${c.score}/100.`
        : `Weighted total: ${c.rawScore}/100, capped at ${c.cap} because a requirement is not fully met → ${c.score}/100.`,
    ),
  );
  const evidence = el('div');
  evidence.className = 'record-score-evidence';
  for (const d of [...c.dimensions, ...c.requirements]) {
    const item = el('div');
    item.append(
      el(
        'h4',
        d.key ? labels[d.key] + ' · ' + levels[d.level] : 'Requirement · ' + matches[d.match],
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
