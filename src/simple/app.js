// JobLoop simple view: the default interface for job seekers.
// Upload CV → check profile → start → pick or skip jobs → answer questions once → autopilot.
// It drives the same IPC API as the classic view and never changes core behavior;
// the classic view stays one click away under "Advanced view".
import {automationAttention} from '../../app/automation/attention.mjs';
import {recordOperationStatus, recordProblem} from '../record-operation-status.js';
import {questionForm} from '../question-form.js';
import {BRAND, markIcon} from './brand.js';
import {playIntro} from './intro.js';
import {el, button, icon, plural, scoreOf, relative, host} from './ui.js';
import {checkmark, docScan, flyPlane, reduced, rollingNumber} from './motion.js';
import {LESS, NEVER, factLine, listOf, setFactLine, withItem, withoutItem} from './facts.js';
import './simple.css';
import './onboarding.css';

const api = window.jobloop,
  MODE_KEY = 'jobloop:view',
  candidates = document.getElementById('candidates');

const state = {
  id: null,
  data: null,
  view: 'jobs',
  tab: 'review',
  selected: new Set(),
  open: new Set(),
  busy: new Set(),
  loading: 0,
  // First snapshot not back yet: show a loading screen instead of a blank page.
  loaded: false,
  // Start was just pressed; the backend may take a few seconds to report it.
  startedAt: 0,
  error: '',
  profileDirty: false,
  // Motion state: what just opened or changed, so an animation plays once.
  asking: null,
  justAsked: null,
  justOpened: new Set(),
  justLearned: null,
  flying: new Set(),
  note: null,
  noteTimer: null,
  counts: null,
};

// ---- Mode switch -------------------------------------------------------
const simpleOn = () => {
  try {
    return localStorage.getItem(MODE_KEY) !== 'classic';
  } catch {
    return true;
  }
};
function setSimple(on) {
  try {
    localStorage.setItem(MODE_KEY, on ? 'simple' : 'classic');
  } catch {}
  document.body.classList.toggle('jl-simple', on);
  if (on) load();
}
// A way back from the classic view.
const back = el('button', 'quiet jl-back-simple', 'Back to simple view');
back.type = 'button';
back.onclick = () => setSimple(true);
document.querySelector('aside .sidebar-bottom')?.before(back);
document.title = BRAND;

// ---- Shell -------------------------------------------------------------
const root = el('div');
root.id = 'jl-root';
document.body.append(root);
const rail = el('div', 'jl-rail'),
  main = el('div', 'jl-main'),
  top = el('header', 'jl-top'),
  scroll = el('div', 'jl-scroll'),
  page = el('div', 'jl-page');
rail.setAttribute('role', 'navigation');
rail.setAttribute('aria-label', 'Main');
scroll.append(page);
main.append(top, scroll);
root.append(rail, main);

const brand = el('div', 'jl-brand');
brand.innerHTML = markIcon(32) + `<span>${BRAND}</span>`;
const navItems = [
  ['jobs', 'Jobs', 'jobs'],
  ['questions', 'Questions', 'question'],
  ['profile', 'Profile & CV', 'person'],
  ['settings', 'Settings', 'settings'],
];
const navButtons = new Map();
rail.append(brand);
for (const [view, label, glyph] of navItems) {
  const b = el('button', 'jl-nav');
  b.type = 'button';
  b.append(icon(glyph), el('span', 'jl-label', label), el('span', 'jl-count'));
  b.onclick = () => go(view);
  navButtons.set(view, b);
  rail.append(b);
}
const foot = el('div', 'jl-rail-foot'),
  who = el('button', 'jl-who'),
  advanced = button('Advanced view', () => setSimple(false), 'jl-btn ghost small'),
  privacy = el('div', 'jl-private');
who.type = 'button';
who.title = 'Switch or add a job search';
who.onclick = () => switchSearch();
privacy.append(el('i'), el('span', null, 'Your data stays on this computer'));
foot.append(who, privacy, advanced);
rail.append(foot);

function go(view) {
  state.view = view;
  state.selected.clear();
  render();
  scroll.scrollTop = 0;
}

// ---- Data --------------------------------------------------------------
let timer = null;
const scheduleLoad = () => {
  clearTimeout(timer);
  timer = setTimeout(load, 150);
};
async function load() {
  if (!document.body.classList.contains('jl-simple')) return;
  const version = ++state.loading;
  let id = candidates?.value || state.id;
  try {
    // A search that was just removed (Start over, Cancel) falls back to another.
    const list = await api.workspaces();
    if (!id || !list.some((w) => w.id === id)) id = list[0]?.id ?? null;
    const data = id ? await api.workspaceSnapshot(id) : null;
    if (version !== state.loading) return;
    if (id !== state.id) {
      state.selected.clear();
      state.open.clear();
      state.profileDirty = false;
      state.counts = null;
      state.asking = null;
      state.note = null;
    }
    state.id = id;
    state.data = data;
  } catch (error) {
    if (version === state.loading) state.error = error.message;
  }
  if (version === state.loading) state.loaded = true;
  render();
}
api.onAutomationChange?.((event) => {
  if (!event?.automationId || event.automationId === state.id) scheduleLoad();
});
candidates?.addEventListener('change', scheduleLoad);
setInterval(() => {
  if (state.view === 'jobs' && document.visibilityState === 'visible') scheduleLoad();
}, 15000);

const act = (key, fn) => async () => {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  state.error = '';
  render();
  try {
    await fn();
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy.delete(key);
    await load();
  }
};

// ---- Derived state ------------------------------------------------------
function groups(data) {
  const g = {review: [], progress: [], applied: [], skipped: []};
  for (const r of data?.results ?? []) {
    if (r.trial) continue;
    const op = recordOperationStatus(r);
    if (['dismissed', 'closed', 'withdrawn'].includes(r.status)) g.skipped.push(r);
    else if (['completed', 'manual_submitted', 'submitted'].includes(r.status)) g.applied.push(r);
    else if (op?.active || ['executing', 'uncertain'].includes(r.status) || recordProblem(r))
      g.progress.push(r);
    else g.review.push(r);
  }
  const byScore = (a, b) => (scoreOf(b) ?? -1) - (scoreOf(a) ?? -1);
  const byTime = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  g.review.sort(byScore);
  g.progress.sort(byTime);
  g.applied.sort(byTime);
  g.skipped.sort(byTime);
  return g;
}
const questions = (data) =>
  automationAttention(data ?? {}).filter((issue) => issue.kind === 'question');
const otherIssues = (data) =>
  automationAttention(data ?? {}).filter((issue) => issue.kind !== 'question');

function pilot(data) {
  const exec = data?.execution ?? {},
    a = data?.automation ?? {},
    asks = questions(data).length,
    active = ['enabled', 'running'].includes(exec.status) || Boolean(data?.activity?.running),
    // Between pressing Start and the backend reporting it, show it as starting.
    starting = !active && state.startedAt > 0 && Date.now() - state.startedAt < 90000,
    running = active || starting,
    auto = a.mode === 'auto',
    threshold = Number(a.criteria?.score_threshold) || null;
  let title, detail, tone;
  if (!running) {
    title = 'Autopilot off';
    detail = a.reviewedRevision == null ? 'Check your profile, then start' : 'Paused';
    tone = 'off';
  } else if (starting) {
    title = 'Starting…';
    detail = 'Getting your search ready';
    tone = 'on';
  } else if (asks) {
    title = 'Waiting for you';
    detail = `${plural(asks, 'question')} to answer`;
    tone = 'waiting';
  } else {
    title = auto ? 'Autopilot on' : 'Finding jobs';
    detail = data?.activity?.running
      ? (data.activity.title ?? 'Working')
      : exec.nextRunAt || a.nextRunAt
        ? 'Next scan ' + relative(exec.nextRunAt ?? a.nextRunAt)
        : auto
          ? `Applies to matches ${threshold ?? 60}+`
          : 'You pick what to apply to';
    tone = 'on';
  }
  if (active) state.startedAt = 0;
  return {running, starting, title, detail, tone, auto, threshold};
}

// ---- Render ---------------------------------------------------------------
function render() {
  if (!document.body.classList.contains('jl-simple')) return;
  const data = state.data,
    a = data?.automation;
  const g = groups(data),
    asks = questions(data);
  // Rail
  for (const [view, b] of navButtons) {
    if (view === state.view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
    const count = b.querySelector('.jl-count'),
      value = view === 'jobs' ? g.review.length : view === 'questions' ? asks.length : 0;
    count.textContent = value ? String(value) : '';
    count.hidden = !value;
    count.classList.toggle('alert', view === 'questions' && value > 0);
  }
  who.replaceChildren();
  const name = a?.title && a.title !== data?.definition?.title ? a.title : 'Your job search';
  who.append(el('span', 'jl-avatar', initials(name)), Object.assign(el('div'), {}));
  who.lastChild.append(el('b', null, name), el('small', null, 'Switch search'));

  if (!state.loaded) return renderLoading();
  if (!state.id || !a) return renderWelcome();
  renderTop(data, g, asks);
  page.replaceChildren();
  if (state.error) page.append(noticeBar(state.error));
  if (state.view === 'jobs') renderJobs(data, g, asks);
  else if (state.view === 'questions') renderQuestions(data, asks);
  else if (state.view === 'profile') renderProfile(data);
  else renderSettings(data);
  // Entrance animations play once: the next render draws these at rest.
  state.justOpened.clear();
  state.justAsked = null;
  state.justLearned = null;
}

function noticeBar(message) {
  const bar = el('div', 'jl-notice');
  bar.setAttribute('role', 'alert');
  bar.append(
    el('span', null, message),
    button('Dismiss', () => ((state.error = ''), render()), 'jl-btn ghost small'),
  );
  return bar;
}

function renderTop(data, g, asks) {
  const titles = {
    jobs: ['Jobs', `${g.review.length} to review · ${g.applied.length} applied`],
    questions: [
      'Questions',
      asks.length ? 'Answer once. JobLoop reuses it everywhere.' : 'All caught up',
    ],
    profile: ['Profile & CV', 'What JobLoop knows about you'],
    settings: ['Settings', 'Autopilot, AI and browser'],
  };
  const [title, sub] = titles[state.view];
  const heading = el('div');
  heading.append(el('h1', null, title), el('div', 'jl-sub', sub));
  const p = pilot(data),
    control = el('div', 'jl-pilot');
  control.dataset.state = p.tone;
  const copy = el('div', 'jl-pilot-copy');
  copy.append(el('b', null, p.title), el('small', null, p.detail));
  const key = 'pilot',
    toggle = button(
      state.busy.has(key) ? '…' : p.running ? 'Pause' : 'Start',
      act(key, async () => {
        if (p.running) {
          state.startedAt = 0;
          await api.workspaceStop(state.id);
        } else await startSearch();
      }),
      'jl-btn small ' + (p.running ? '' : 'accent'),
    );
  toggle.disabled = state.busy.has(key);
  control.append(el('span', 'jl-pilot-dot'), copy, toggle);
  top.replaceChildren(heading, control);
}

// ---- Jobs -----------------------------------------------------------------
function renderJobs(data, g, asks) {
  if (asks.length) {
    const banner = el('div', 'jl-banner');
    const copy = el('div');
    copy.append(
      el('b', null, `${plural(asks.length, 'question')} waiting for you`),
      el('small', null, 'Answer once and JobLoop keeps applying with it.'),
    );
    banner.append(
      el('span', 'jl-banner-icon', '?'),
      copy,
      button('Answer now', () => go('questions'), 'jl-btn primary small'),
    );
    page.append(banner);
  }
  for (const issue of otherIssues(data)) page.append(issueBanner(issue));
  const p = pilot(data);
  if (p.running && !asks.length && (g.review.length || state.tab !== 'review'))
    page.append(liveStrip(data, p));
  const recap = weekRecap(data, g);
  if (recap) page.append(recap);

  const tabs = el('div', 'jl-tabs');
  tabs.setAttribute('role', 'tablist');
  const tabDefs = [
    ['review', 'To review', g.review],
    ['progress', 'In progress', g.progress],
    ['applied', 'Applied', g.applied],
    ['skipped', 'Skipped', g.skipped],
  ];
  const before = state.counts;
  state.counts = Object.fromEntries(tabDefs.map(([id, , list]) => [id, list.length]));
  for (const [id, label, list] of tabDefs) {
    const t = el('button', 'jl-tab');
    t.type = 'button';
    t.dataset.tab = id;
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-selected', String(state.tab === id));
    // A count that just went up rolls to its new value.
    const count = el('span'),
      was = before?.[id];
    if (was != null && list.length > was) count.append(rollingNumber(list.length, {from: was}));
    else count.textContent = String(list.length);
    t.append(label, count);
    t.onclick = () => {
      state.tab = id;
      state.selected.clear();
      render();
    };
    tabs.append(t);
  }
  const bar = el('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap';
  bar.append(tabs);
  const list = tabDefs.find(([id]) => id === state.tab)[2];
  if (state.tab === 'review' && list.length > 1) {
    const all = button(
      state.selected.size === list.length ? 'Clear selection' : 'Select all',
      () => {
        if (state.selected.size === list.length) state.selected.clear();
        else list.forEach((r) => state.selected.add(r.id));
        render();
      },
      'jl-btn ghost small',
    );
    all.style.marginLeft = 'auto';
    bar.append(all);
  }
  page.append(bar);
  if (state.note) {
    const note = el('div', 'jl-skip-note');
    note.setAttribute('role', 'status');
    note.append(
      el('span', null, `${state.note.text} It’s in Skipped if you change your mind.`),
      button('Dismiss', () => ((state.note = null), render()), 'jl-quiet-link'),
    );
    page.append(note);
  }

  if (!list.length) return page.append(emptyJobs(data, state.tab, g));
  const box = el('div', 'jl-list');
  for (const r of list) box.append(jobCard(data, r));
  page.append(box);

  if (state.tab === 'review') {
    const ids = [...state.selected].filter((id) => list.some((r) => r.id === id)),
      bulk = el('div', 'jl-bulk');
    bulk.hidden = !ids.length;
    bulk.append(
      el('b', null, `${ids.length} selected`),
      button(
        'Skip',
        act('bulk-skip', async () => {
          for (const id of ids) await api.automationDismiss(state.id, id);
          state.selected.clear();
        }),
        'jl-btn small',
      ),
      button(
        `Apply to ${ids.length}`,
        act('bulk-apply', async () => {
          for (const id of ids)
            await applyTo(
              data,
              list.find((r) => r.id === id),
            );
          state.selected.clear();
        }),
        'jl-btn small accent',
      ),
    );
    page.append(bulk);
  }
}

// This week at a glance: what was found and sent, per day, and what JobLoop
// changed because of the user's own choices. Only real numbers; hidden on request.
const DAY = 86400000;
const weekKey = () => new Date(Date.now() - new Date().getDay() * DAY).toISOString().slice(0, 10);
function weekRecap(data, g) {
  const a = data.automation,
    since = Date.now() - 7 * DAY,
    results = (data.results ?? []).filter((r) => !r.trial);
  if (!results.length) return null;
  const hideKey = 'jl-recap-hidden:' + a.id;
  try {
    if (localStorage.getItem(hideKey) === weekKey()) return null;
  } catch {}
  const found = results.filter((r) => (r.createdAt ?? 0) >= since).length,
    sent = g.applied.filter((r) => (r.updatedAt ?? 0) >= since);
  const learned = [
    ...listOf(a.criteria?.preferences, LESS).map((x) => 'fewer ' + x),
    ...listOf(a.criteria?.constraints, NEVER).map((x) => 'never ' + x),
  ];
  const seenKey = 'jl-recap:' + a.id,
    first = sessionStorage.getItem(seenKey) !== String(found + ':' + sent.length);
  sessionStorage.setItem(seenKey, String(found + ':' + sent.length));
  const card = el('section', 'jl-card jl-recap'),
    head = el('div', 'jl-recap-head');
  head.append(
    el('h2', null, 'Your last 7 days'),
    button(
      'Hide this week',
      () => {
        try {
          localStorage.setItem(hideKey, weekKey());
        } catch {}
        render();
      },
      'jl-quiet-link',
    ),
  );
  const stats = el('div', 'jl-recap-stats');
  for (const [value, label, accent] of [
    [found, 'jobs found', false],
    [sent.length, 'applied', true],
    [g.progress.length, 'in progress', false],
  ]) {
    const stat = el('div', 'jl-stat' + (accent ? ' accent' : ''));
    stat.append(rollingNumber(value, {animate: first}), el('small', null, label));
    stats.append(stat);
  }
  // Applications sent on each of the last seven days.
  const bars = el('div', 'jl-recap-bars'),
    days = [...Array(7)].map((_, i) => {
      const start = new Date(Date.now() - (6 - i) * DAY);
      start.setHours(0, 0, 0, 0);
      return start;
    }),
    perDay = days.map(
      (d) =>
        sent.filter((r) => r.updatedAt >= d.getTime() && r.updatedAt < d.getTime() + DAY).length,
    ),
    most = Math.max(1, ...perDay);
  bars.setAttribute('role', 'img');
  bars.setAttribute(
    'aria-label',
    'Applications per day: ' +
      days
        .map((d, i) => `${d.toLocaleDateString(undefined, {weekday: 'short'})} ${perDay[i]}`)
        .join(', '),
  );
  days.forEach((d, i) => {
    const col = el('div', 'jl-day'),
      bar = el('i', perDay[i] ? '' : 'zero');
    bar.style.height = Math.max(4, Math.round((perDay[i] / most) * 52)) + 'px';
    if (first) {
      col.classList.add('rising');
      col.style.setProperty('--delay', i * 110 + 'ms');
    }
    col.setAttribute('aria-hidden', 'true');
    col.append(
      el('b', null, String(perDay[i])),
      bar,
      el('small', null, d.toLocaleDateString(undefined, {weekday: 'short'})),
    );
    bars.append(col);
  });
  const bodyRow = el('div', 'jl-recap-body');
  bodyRow.append(stats, bars);
  card.append(head, bodyRow);
  if (learned.length) {
    const changed = el('div', 'jl-recap-learned');
    changed.append(
      el('b', null, 'What I changed because of you'),
      el('span', null, 'From your skips: ' + learned.slice(0, 4).join('; ') + '.'),
    );
    card.append(changed);
  }
  return card;
}

function emptyJobs(data, tab, g) {
  const p = pilot(data),
    box = el('div', 'jl-empty jl-card');
  if (tab === 'review' && p.running) {
    const work = liveWork(data);
    box.classList.add('jl-searching');
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.append(
      scanAnimation(),
      el('h2', null, p.starting ? 'Starting your search' : 'Looking for jobs that fit you'),
      el(
        'p',
        'jl-live-line',
        work?.text ?? (p.starting ? 'Getting things ready…' : p.detail || 'Getting started…'),
      ),
      stepTrail(work ? work.step : 0),
      el(
        'p',
        null,
        'New matches show up here as soon as they are scored. You can close this window; JobLoop keeps going while the app is open.',
      ),
    );
    return box;
  }
  const mark = el('div');
  mark.innerHTML = markIcon(52);
  box.append(mark);
  if (tab === 'review')
    box.append(
      el('h2', null, g.applied.length ? 'Nothing new to review' : 'Ready when you are'),
      el(
        'p',
        null,
        'Start autopilot and JobLoop searches your sources, scores every listing against your CV, and lists the best ones here.',
      ),
      button('Start autopilot', act('pilot', startSearch), 'jl-btn accent big'),
    );
  else
    box.append(
      el(
        'h2',
        null,
        {
          progress: 'Nothing in progress',
          applied: 'No applications yet',
          skipped: 'Nothing skipped',
        }[tab],
      ),
      el(
        'p',
        null,
        {
          progress: 'When you press Apply, the application is filled and sent from here.',
          applied: 'Sent applications appear here with their confirmation.',
          skipped: 'Jobs you skip land here, so you can change your mind.',
        }[tab],
      ),
    );
  return box;
}

// Fit score: a ring with the number, and its meaning in words underneath.
const tierOf = (score) =>
  score == null ? null : score >= 80 ? 'strong' : score >= 60 ? 'good' : 'partial';
const tierText = {strong: 'Strong fit', good: 'Good fit', partial: 'Partial fit'};
function scoreBadge(score) {
  const tier = tierOf(score),
    box = el('div', 'jl-fit ' + (tier ?? 'none'));
  const ring = el('div', 'jl-score ' + (tier ?? 'none'));
  ring.style.setProperty('--p', String(score ?? 0));
  ring.append(el('b', null, score == null ? '–' : String(score)));
  box.append(ring, el('small', null, tier ? tierText[tier] : 'Not scored'));
  box.setAttribute('role', 'img');
  box.setAttribute(
    'aria-label',
    score == null ? 'Not scored yet' : `Fit score ${score} of 100, ${tierText[tier].toLowerCase()}`,
  );
  return box;
}

// Reasons to skip, each turned into something JobLoop learns. The job's own
// details make the rule specific; "Just skip" teaches nothing.
function skipReasons(r) {
  const cells = r.cells ?? {},
    place = cells.location?.split(/[·,(]/)[0].trim(),
    company = cells.company?.trim();
  return [
    ['Wrong kind of role', {line: LESS, item: `roles like “${r.title}”`}],
    place && ['Wrong location', {line: LESS, item: `jobs in ${place}`}],
    ['Too junior', {line: LESS, item: 'roles below my level'}],
    ['Pay too low', {line: LESS, item: 'roles that list low pay'}],
    company && ['Not this company', {line: NEVER, item: company}],
  ].filter(Boolean);
}
const learnedReply = (rule) =>
  rule.line === NEVER ? `Got it: I won’t apply to ${rule.item}.` : `Got it: fewer ${rule.item}.`;

// Adds or removes one item of a learned line and saves the profile.
async function saveLearned(rule, remove = false) {
  const a = state.data.automation,
    key = rule.line === NEVER ? 'constraints' : 'preferences',
    criteria = {...a.criteria},
    items = listOf(criteria[key], rule.line);
  criteria[key] = setFactLine(
    criteria[key],
    rule.line,
    remove ? withoutItem(items, rule.item, rule.line) : withItem(items, rule.item, rule.line),
  );
  await api.automationProfileSave(
    state.id,
    {title: a.title, goal: a.goal, criteria, mode: a.mode},
    {expectedRevision: a.revision},
  );
}

function jobCard(data, r) {
  const card = el('article', 'jl-job'),
    score = scoreOf(r),
    op = recordOperationStatus(r),
    problem = recordProblem(r),
    selectable = state.tab === 'review',
    asking = state.asking === r.id,
    flying = state.flying.has(r.id);
  card.dataset.id = r.id;
  card.dataset.selected = String(state.selected.has(r.id));
  if (asking) card.classList.add('asking');
  // Select
  if (selectable) {
    const check = el('input', 'jl-check');
    check.type = 'checkbox';
    check.checked = state.selected.has(r.id);
    check.setAttribute('aria-label', 'Select ' + r.title);
    check.onchange = () => {
      check.checked ? state.selected.add(r.id) : state.selected.delete(r.id);
      render();
    };
    card.append(check);
  } else card.append(el('span'));
  card.append(scoreBadge(score));
  // Body
  const body = el('div', 'jl-job-body'),
    title = el('button', 'jl-job-title', r.title),
    as = r.assessment ?? {},
    open = state.open.has(r.id);
  title.type = 'button';
  title.setAttribute('aria-expanded', String(open));
  const toggle = () => {
    if (open) state.open.delete(r.id);
    else {
      state.open.add(r.id);
      state.justOpened.add(r.id);
    }
    render();
  };
  title.onclick = toggle;
  const cells = r.cells ?? {},
    meta = el('div', 'jl-job-meta');
  meta.append([cells.company, cells.location, host(r.url)].filter(Boolean).join(' · '));
  if (as.strengths?.length || as.gaps?.length || as.summary) {
    const why = button(open ? 'Hide' : 'Why it fits', toggle, 'jl-why');
    why.setAttribute('aria-expanded', String(open));
    meta.append(why);
  }
  body.append(title, meta);
  if (as.eligibility === 'mismatch') {
    const chips = el('div', 'jl-chips');
    chips.append(el('span', 'jl-chip bad', 'Requirement not met'));
    body.append(chips);
  }
  card.append(body);
  // Actions / state
  const side = el('div', 'jl-job-actions');
  if (state.tab === 'review') {
    const k = 'rec:' + r.id,
      busy = state.busy.has(k),
      applyOp =
        r.recordAction?.directOperation ??
        (r.recordAction?.operation?.kind === 'execute' ? r.recordAction.operation : null);
    if (flying) side.append(sentCheck(r.id));
    else if (asking) {
      const close = button('', () => ((state.asking = null), render()), 'jl-icon-btn');
      close.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
      close.setAttribute('aria-label', 'Keep this job');
      close.title = 'Keep this job';
      side.append(close);
    } else {
      const skip = button(
        'Skip',
        () => {
          state.asking = r.id;
          state.justAsked = r.id;
          render();
        },
        'jl-btn ghost small',
      );
      const apply = button(busy ? 'Starting…' : 'Apply', null, 'jl-btn primary small');
      apply.onclick = () => flyApply(data, r, apply);
      skip.disabled = apply.disabled = busy;
      if (applyOp?.disabled) apply.title = applyOp.reason ?? '';
      side.append(skip, apply);
    }
  } else if (state.tab === 'progress') {
    const s = el('span', 'jl-state ' + (problem || op?.tone === 'blocked' ? 'blocked' : 'running'));
    s.append(
      el('i'),
      problem?.label ??
        op?.label ??
        (r.status === 'uncertain' ? 'Checking if it was sent' : 'Working'),
    );
    side.append(s);
    if (op?.id === 'waiting') side.append(button('Answer', () => go('questions'), 'jl-btn small'));
  } else if (state.tab === 'applied') {
    const s = el('span', 'jl-state done');
    s.append(el('i'), 'Sent ' + relative(r.updatedAt));
    side.append(s);
  } else {
    const s = el('span', 'jl-state');
    s.append(el('i'), r.status === 'closed' ? 'Listing closed' : 'Skipped');
    side.append(s);
  }
  card.append(side);
  // Why it fits
  if (open) {
    const detail = el('div', 'jl-job-detail');
    if (state.justOpened.has(r.id)) detail.classList.add('opening');
    const lines = el('div', 'jl-why-lines');
    for (const s of (as.strengths ?? []).slice(0, 2)) lines.append(whyLine('Fits', 'good', s));
    for (const s of (as.gaps ?? []).slice(0, 2)) lines.append(whyLine('Gap', 'warn', s));
    if (lines.childElementCount) detail.append(lines);
    if (as.summary) detail.append(el('p', null, as.summary));
    if (problem?.reason || op?.detail) detail.append(el('p', null, problem?.reason ?? op.detail));
    detail.append(button('Open listing ↗', () => api.openLink(r.url), 'jl-link'));
    card.append(detail);
  }
  // Why skip it?
  if (asking) {
    const ask = el('div', 'jl-ask');
    if (state.justAsked === r.id) ask.classList.add('opening');
    const q = el('p');
    q.append(
      el('b', null, 'Why skip it?'),
      ' ',
      el('span', null, 'I’ll use this to find better matches.'),
    );
    const chips = el('div', 'jl-ask-chips');
    for (const [label, rule] of skipReasons(r))
      chips.append(button(label, () => skipWith(r, rule, card), 'jl-reason'));
    chips.append(button('Just skip', () => skipWith(r, null, card), 'jl-reason plain'));
    ask.append(q, chips);
    card.append(ask);
  }
  return card;
}
function whyLine(label, tone, text) {
  const line = el('div', 'jl-why-line');
  line.append(el('span', 'jl-why-tag ' + tone, label), el('span', null, text));
  return line;
}

// Skipping: the card slides away, then the rule is saved and the job dismissed.
async function skipWith(r, rule, card) {
  const k = 'rec:' + r.id;
  if (state.busy.has(k)) return;
  state.busy.add(k);
  card.classList.add('leaving');
  await new Promise((done) => setTimeout(done, reduced() ? 0 : 220));
  state.asking = null;
  try {
    if (rule) await saveLearned(rule);
    await api.automationDismiss(state.id, r.id);
    state.note = {text: rule ? learnedReply(rule) : 'Skipped.', title: r.title, at: Date.now()};
    if (rule) state.justLearned = rule.item;
    clearTimeout(state.noteTimer);
    state.noteTimer = setTimeout(() => ((state.note = null), render()), 6000);
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy.delete(k);
    await load();
  }
}

// One checkmark per job, kept across re-renders so it plays only once.
const checks = new Map();
function sentCheck(id) {
  if (!checks.has(id)) checks.set(id, checkmark(32, {play: false, label: 'Sent to apply'}));
  return checks.get(id);
}

// Apply: the plane flies from the button to the In progress tab, the tab's
// count rolls up and a check replaces the buttons. The request runs meanwhile.
async function flyApply(data, r, from) {
  const k = 'rec:' + r.id;
  if (state.busy.has(k)) return;
  state.busy.add(k);
  state.error = '';
  const target = page.querySelector('.jl-tab[data-tab="progress"]');
  const flight = flyPlane(from, target);
  state.flying.add(r.id);
  render();
  let failed = null;
  const request = applyTo(data, r).catch((error) => (failed = error));
  await flight;
  if (!failed) sentCheck(r.id).play();
  await request;
  await new Promise((done) => setTimeout(done, failed || reduced() ? 0 : 650));
  state.flying.delete(r.id);
  checks.delete(r.id);
  state.busy.delete(k);
  if (failed) state.error = failed.message;
  await load();
}

async function applyTo(data, r) {
  if (!r) return;
  const action = r.recordAction ?? {},
    op = action.directOperation ?? (action.operation?.kind === 'execute' ? action.operation : null);
  if (op?.disabled) throw Error(op.reason ?? 'This job cannot be applied to yet.');
  await api.automationRecordRun(state.id, r.id, 'execute', {direct: true});
}

function issueBanner(issue) {
  const banner = el('div', 'jl-banner info'),
    copy = el('div');
  copy.append(
    el('b', null, issue.title ?? issue.name ?? 'Needs your attention'),
    el('small', null, issue.message ?? ''),
  );
  banner.append(el('span', 'jl-banner-icon', '!'), copy);
  if (['login', 'access', 'captcha', 'browser'].some((k) => String(issue.kind).includes(k)))
    banner.append(
      button(
        'Open browser',
        act('browser', () => api.automationBrowser(state.id)),
        'jl-btn small',
      ),
    );
  if (issue.dismissKey || issue.dismissable)
    banner.append(
      button(
        'Dismiss',
        act('dismiss:' + issue.id, () =>
          api.automationAttentionDismiss(state.id, issue.id, issue.dismissKey),
        ),
        'jl-btn ghost small',
      ),
    );
  return banner;
}

// ---- Questions --------------------------------------------------------------
function renderQuestions(data, asks) {
  if (!asks.length) {
    const box = el('div', 'jl-empty jl-card');
    const mark = el('div');
    mark.innerHTML = markIcon(52);
    box.append(
      mark,
      el('h2', null, 'No open questions'),
      el(
        'p',
        null,
        'When a form asks something your CV does not say, it shows up here once. Your answer is saved and reused for every future application.',
      ),
    );
    page.append(box);
  }
  const titles = new Map((data.results ?? []).map((r) => [r.id, r.title]));
  for (const issue of asks) {
    const card = el('section', 'jl-card jl-question' + (issue.fields?.length ? '' : ' single')),
      head = el('div', 'jl-question-head'),
      copy = el('div');
    copy.append(
      el('b', null, issue.message),
      el(
        'small',
        null,
        issue.recordId
          ? 'For ' + (titles.get(issue.recordId) ?? 'one application')
          : 'Used for all applications',
      ),
    );
    head.append(el('span', 'jl-banner-icon', '?'), copy);
    head.firstChild.style.cssText =
      'flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:99px;background:var(--jl-warn-soft);color:var(--jl-warn);font-weight:700';
    const form = questionForm(
      state.id,
      {id: issue.id, question: issue.message, fields: issue.fields},
      async (value) => {
        await api.workspaceAnswer(state.id, issue.id, value);
        await load();
      },
      {facts: data.automation.criteria?.application_facts},
    );
    card.append(
      head,
      form,
      el('p', 'jl-remember', 'Saved to your profile. You will not be asked again.'),
    );
    page.append(card);
  }
  const answered = (data.automation.questions ?? [])
    .filter((q) => q.answer != null)
    .slice(-12)
    .reverse();
  if (answered.length) {
    page.append(el('h2', null, 'Saved answers'));
    page.lastChild.style.cssText = 'font-size:15px;margin-top:12px';
    const list = el('dl', 'jl-card jl-answered');
    list.style.margin = '0';
    for (const q of answered) {
      const row = el('div');
      row.append(
        el('dt', null, q.text),
        el('dd', null, typeof q.answer === 'string' ? q.answer : JSON.stringify(q.answer)),
      );
      list.append(row);
    }
    page.append(list);
  }
}

// ---- Profile ---------------------------------------------------------------
const profileFields = [
  [
    'goal',
    'What you are looking for',
    'e.g. Senior backend roles in Berlin or remote in the EU',
    true,
  ],
  ['preferences', 'Roles, places and work mode', 'Target roles, cities, remote or hybrid'],
  ['location', 'Main search location', 'As job sites spell it, e.g. Berlin, Germany', false, true],
  ['experience', 'Experience and skills', 'Years, main skills, languages and levels'],
  ['constraints', 'Must-haves', 'Salary floor, work permit, language, start date'],
  [
    'application_facts',
    'Details forms ask for',
    'Phone, notice period, LinkedIn, salary expectation',
  ],
];
function renderProfile(data) {
  const a = data.automation,
    form = el('form', 'jl-card');
  form.oninput = () => (state.profileDirty = true);
  // CV
  const cv = section(
    'Your CV',
    'JobLoop reads it to fill your profile and tailor every application.',
  );
  const docs = data.documents ?? [],
    file = el('div', 'jl-file');
  const doc = docs.find((d) => /cv|resume|lebenslauf/i.test(d.name ?? d.file ?? '')) ?? docs[0];
  file.append(icon('file'));
  const fcopy = el('div');
  fcopy.append(
    el('b', null, doc ? (doc.name ?? doc.file) : 'No CV yet'),
    el('small', null, doc ? 'Stays on this computer' : 'PDF or DOCX'),
  );
  file.append(
    fcopy,
    button(
      doc ? 'Replace' : 'Upload CV',
      act('cv', () => api.pickDocument(state.id)),
      'jl-btn small',
    ),
  );
  cv.lastChild.append(file);
  if (doc)
    cv.lastChild.append(
      button(
        'Refill profile from CV',
        act('refill', () => api.automationOnboarding(state.id)),
        'jl-link',
      ),
    );
  // Basics
  const basics = section(
    'About you',
    'Fix anything that is wrong. The more precise, the better the matches.',
  );
  basics.lastChild.append(
    field(
      'title',
      'Full name',
      a.title === data.definition?.title ? '' : a.title,
      'Your first and last name',
      false,
      true,
    ),
  );
  for (const [key, label, placeholder, required, single] of profileFields) {
    const value = key === 'goal' ? a.goal : a.criteria?.[key];
    basics.lastChild.append(field(key, label, value, placeholder, required, single));
  }
  // What JobLoop learned from skips; each item can be removed.
  const rules = [
      ...listOf(a.criteria?.preferences, LESS).map((item) => ({line: LESS, item})),
      ...listOf(a.criteria?.constraints, NEVER).map((item) => ({line: NEVER, item})),
    ],
    learned = section(
      'What I’ve learned',
      'From your skips and answers. Remove anything I got wrong.',
    );
  if (!rules.length)
    learned.lastChild.append(
      el('p', 'jl-hint', 'Nothing yet. When you skip a job, tell me why and it shows up here.'),
    );
  const ruleList = el('div', 'jl-learned');
  for (const rule of rules) {
    const item = el('div', 'jl-rule' + (state.justLearned === rule.item ? ' new' : ''));
    item.append(el('span', null, (rule.line === NEVER ? 'Never apply to ' : 'Fewer ') + rule.item));
    const remove = button(
      '',
      act('rule:' + rule.item, () => saveLearned(rule, true)),
      'jl-icon-btn',
    );
    remove.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    remove.setAttribute('aria-label', 'Remove: ' + rule.item);
    item.append(remove);
    ruleList.append(item);
  }
  if (rules.length) learned.lastChild.append(ruleList);
  // Autopilot
  const mode = section('Autopilot', 'How far JobLoop may go on its own.');
  mode.lastChild.append(levels(a));
  const footer = el('div', 'jl-form-foot');
  footer.append(
    el('small', null, 'Saved on this computer. Shared with your AI only while it works.'),
    el('button', 'jl-btn primary', state.busy.has('profile') ? 'Saving…' : 'Save profile'),
  );
  footer.lastChild.type = 'submit';
  form.append(cv, basics, learned, mode, footer);
  form.onsubmit = (event) => {
    event.preventDefault();
    const f = form.elements,
      criteria = {...a.criteria};
    for (const [key] of profileFields)
      if (key !== 'goal' && f[key]) criteria[key] = f[key].value.trim();
    const auto = f.level.value === 'auto';
    if (auto) criteria.score_threshold = f.threshold.value;
    act('profile', async () => {
      await api.automationProfileSave(
        state.id,
        {
          title: f.title.value.trim() || a.title,
          goal: f.goal.value.trim(),
          criteria,
          mode: auto ? 'auto' : 'observe',
        },
        {expectedRevision: a.revision},
      );
      state.profileDirty = false;
    })();
  };
  page.append(form);
}
function section(title, text) {
  const s = el('section', 'jl-section'),
    head = el('div'),
    body = el('div', 'jl-fields');
  head.append(el('h2', null, title), el('p', null, text));
  s.append(head, body);
  return s;
}
function field(name, label, value, placeholder, required = false, single = false) {
  const wrap = el('label', 'jl-field', label),
    input = el(single ? 'input' : 'textarea');
  input.name = name;
  input.value = value ?? '';
  input.placeholder = placeholder ?? '';
  input.required = Boolean(required);
  input.maxLength = 6000;
  wrap.append(input);
  return wrap;
}
function levels(a) {
  const box = el('div', 'jl-fields'),
    grid = el('div', 'jl-levels'),
    threshold = Number(a.criteria?.score_threshold) || 80;
  const option = (value, title, text) => {
    const l = el('label', 'jl-level'),
      input = el('input');
    input.type = 'radio';
    input.name = 'level';
    input.value = value;
    input.checked = (a.mode === 'auto') === (value === 'auto');
    l.append(input, el('b', null, title), el('small', null, text));
    return l;
  };
  grid.append(
    option(
      'observe',
      'I pick, JobLoop applies',
      'Finds and scores jobs. Applies only to the ones you press Apply on.',
    ),
    option(
      'auto',
      'Full autopilot',
      'Also applies on its own to jobs above your fit score. You can still skip anything.',
    ),
  );
  const range = el('label', 'jl-threshold'),
    input = el('input'),
    out = el('output', null, String(threshold));
  input.type = 'range';
  input.name = 'threshold';
  input.min = '50';
  input.max = '95';
  input.step = '5';
  input.value = String(threshold);
  input.oninput = () => (out.textContent = input.value);
  range.append(el('span', null, 'Auto-apply at fit score'), input, out);
  const sync = () => (range.hidden = grid.querySelector('input:checked')?.value !== 'auto');
  grid.addEventListener('change', sync);
  box.append(grid, range);
  queueMicrotask(sync);
  return box;
}

// ---- Settings ---------------------------------------------------------------
function renderSettings(data) {
  const card = el('div', 'jl-card');
  const ai = section('AI', 'The assistant that reads listings and fills forms.'),
    provider = data.automation.agentSettings?.provider ?? 'not set',
    rows = el('div', 'jl-rows');
  rows.append(
    row(
      `Using ${providerLabel(provider)}`,
      'Runs with your own account. Change the model in Advanced view.',
    ),
  );
  ai.lastChild.append(rows);
  const browser = section('Browser', 'JobLoop opens job sites in Chrome to read and apply.'),
    b = data.browserStatus ?? {},
    brows = el('div', 'jl-rows');
  brows.append(
    row(
      b.ready ? 'Chrome connected' : 'Chrome not connected',
      b.ready
        ? 'Sign-ins in that Chrome are used for applying.'
        : 'Open the browser once and sign in to the job sites you use.',
      button(
        'Open browser',
        act('browser', () => api.automationBrowser(state.id)),
        'jl-btn small',
      ),
    ),
  );
  browser.lastChild.append(brows);
  const sources = section('Where to search', 'Job boards and company sites JobLoop checks.'),
    srows = el('div', 'jl-rows');
  for (const s of data.sources ?? []) {
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = s.enabled;
    toggle.setAttribute('aria-label', 'Search ' + s.name);
    toggle.style.cssText = 'width:18px;height:18px;accent-color:var(--jl-check)';
    toggle.onchange = act('src:' + s.url, () =>
      api.automationSourceSave(state.id, s.url, {enabled: toggle.checked}),
    );
    srows.append(row(s.name, host(s.url), toggle));
  }
  sources.lastChild.append(srows);
  // Privacy consent on forms: the same application rules line onboarding writes.
  const applying = section('Applying', 'What JobLoop may agree to on application forms.'),
    arows = el('div', 'jl-rows'),
    policy = data.automation.criteria?.application_policy ?? '',
    consent = el('input');
  consent.type = 'checkbox';
  consent.checked = /^accept/i.test(factLine(policy, 'Privacy consent'));
  consent.setAttribute('aria-label', 'Accept privacy consent on application forms');
  consent.style.cssText = 'width:18px;height:18px;accent-color:var(--jl-check)';
  consent.onchange = act('consent', async () => {
    const a = state.data.automation,
      criteria = {...a.criteria};
    criteria.application_policy = setFactLine(
      criteria.application_policy,
      'Privacy consent',
      consent.checked
        ? 'Accept the privacy policy and data processing consent a form requires to apply. Leave marketing, newsletter, job alert and talent pool opt-ins unticked.'
        : '',
    );
    await api.automationProfileSave(
      state.id,
      {title: a.title, goal: a.goal, criteria, mode: a.mode},
      {expectedRevision: a.revision},
    );
  });
  arows.append(
    row(
      'Accept privacy consent for me',
      'Ticks the privacy and data processing boxes a form requires. Marketing and talent pool opt-ins stay unticked.',
      consent,
    ),
  );
  applying.lastChild.append(arows);
  const more = section('Advanced', 'Agent models, workers, keys, notifications, data and backups.');
  more.lastChild.append(button('Open advanced view', () => setSimple(false), 'jl-btn'));
  card.append(ai, browser, sources, applying, more);
  page.append(card);
}
function row(title, text, control) {
  const r = el('div', 'jl-row'),
    copy = el('div');
  copy.append(el('b', null, title), el('small', null, text));
  r.append(copy);
  if (control) r.append(control);
  return r;
}
const providerLabel = (id) =>
  ({claude: 'Claude', codex: 'ChatGPT (Codex)', opencode: 'OpenCode'})[id] ?? id;

// ---- Welcome (no search yet) -----------------------------------------------------
function renderLoading() {
  top.replaceChildren();
  const box = el('div', 'jl-empty jl-loading jl-spin');
  box.setAttribute('role', 'status');
  box.style.paddingTop = '18vh';
  const mark = el('div');
  mark.innerHTML = markIcon(56);
  box.append(mark, el('h2', null, 'Opening your job search'), el('p', null, 'One moment…'));
  page.replaceChildren(box);
}

function startSearch() {
  state.startedAt = Date.now();
  render();
  return api.workspaceStart(state.id);
}

// What the agent is doing right now, in plain words, and which step of
// Search → Read → Score → Apply that is. Derived from the active runs.
const STEPS = ['Search', 'Read', 'Score', 'Apply'];
function liveWork(data) {
  const runs = data?.runs ?? [],
    active = (data?.activeRuns ?? (data?.activeRun ? [data.activeRun] : []))
      .map((run) => runs.find((r) => r.id === run.id) ?? run)
      .filter((run) => run.kind !== 'interview' && run.kind !== 'conversation');
  const run = active.find((r) => r.status === 'running') ?? active[0];
  if (!run) return null;
  const site = host(run.sourceUrl ?? ''),
    op = run.operation ?? run.kind;
  if (op === 'trial') return {step: 0, text: site ? `Learning how to search ${site}` : 'Learning a new job site'};
  if (['run', 'scan'].includes(op)) return {step: 0, text: site ? `Searching ${site}` : 'Searching job sites'};
  if (['detail', 'inspect'].includes(op)) return {step: 1, text: 'Reading a job listing'};
  if (op === 'record-score') return {step: 2, text: 'Scoring a listing against your CV'};
  if (op === 'record-prepare') return {step: 3, text: 'Filling in an application'};
  if (op === 'record-execute') return {step: 3, text: 'Sending an application'};
  if (op === 'record-verify') return {step: 3, text: 'Checking the application went through'};
  return {step: 0, text: 'Working on your search'};
}
function stepTrail(step) {
  const trail = el('ol', 'jl-steps');
  trail.setAttribute('aria-label', 'Progress');
  STEPS.forEach((name, i) => {
    const item = el('li', null, name);
    item.dataset.state = i < step ? 'done' : i === step ? 'now' : 'next';
    if (i === step) item.setAttribute('aria-current', 'step');
    trail.append(item);
  });
  return trail;
}
// A strip at the top of Jobs while the agent runs, so the page never looks idle.
function liveStrip(data, p) {
  const work = liveWork(data),
    strip = el('div', 'jl-live');
  strip.setAttribute('role', 'status');
  strip.setAttribute('aria-live', 'polite');
  const copy = el('div', 'jl-live-copy');
  copy.append(
    el('b', null, work?.text ?? (p.starting ? 'Starting your search' : 'Waiting for the next scan')),
    el(
      'small',
      null,
      work ? 'Live · updates as JobLoop works' : p.starting ? 'This takes a few seconds' : p.detail,
    ),
  );
  strip.append(el('span', 'jl-live-dot'), copy, stepTrail(work ? work.step : p.starting ? 0 : -1));
  strip.dataset.idle = String(!work && !p.starting);
  return strip;
}
// One scan animation reused across renders, so polling does not restart it.
let scanMark = null;
const scanAnimation = () => (scanMark ??= docScan(72));

function renderWelcome() {
  top.replaceChildren();
  page.replaceChildren();
  const box = el('div', 'jl-empty');
  box.style.paddingTop = '12vh';
  const mark = el('div');
  mark.innerHTML = markIcon(72);
  box.append(
    mark,
    el('h2', null, 'Your job search, on autopilot'),
    el(
      'p',
      null,
      'Upload your CV. JobLoop finds jobs that fit, you pick the ones you like, and it applies for you.',
    ),
    button('Upload your CV', () => document.getElementById('new')?.click(), 'jl-btn accent big'),
  );
  box.querySelector('h2').style.fontSize = '28px';
  page.append(box);
}

// ---- Switch search -------------------------------------------------------------
function switchSearch() {
  const options = [...(candidates?.options ?? [])].filter((o) => o.value);
  if (options.length <= 1) return document.getElementById('new')?.click();
  const index = options.findIndex((o) => o.value === state.id),
    next = options[(index + 1) % options.length];
  candidates.value = next.value;
  candidates.dispatchEvent(new Event('change', {bubbles: true}));
}
const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || 'J';

// ---- Boot ------------------------------------------------------------------------
document.body.classList.toggle('jl-simple', simpleOn());
if (simpleOn()) playIntro();
render();
load();
