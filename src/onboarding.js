import {
  interviewRun,
  conversationWaiting,
  CONVERSATION_WORKER,
} from '../app/workspaces/conversation.mjs';
import {automationProgress} from '../app/automation/progress.mjs';
import {withAgentDefaults, withSetupAgentDefaults} from '../app/agents/settings.mjs';
import {WorkerTerminalSurface} from './worker-terminal-surface.js';
import {terminalAttention, trustKeys} from './agent-attention.js';
import './onboarding.css';
import {rulesField, RULES_HINT} from './template-fields.js';
import {DEFAULT_SCORE_THRESHOLD} from '../app/scoring/thresholds.mjs';

// Welcome screen of a new job search: the user picks the agent and the CV, the
// setup agent fills the profile from the CV, the user reviews it and starts.
const providerOrder = ['claude', 'codex', 'opencode'];
const RECOMMENDED_PROVIDER = 'claude';
// The review form shows these criteria; the rest stay on the profile page.
const reviewFields = ['preferences', 'country', 'location', 'application_facts'];
const readinessIds = ['chrome', 'chrome-profile', 'chrome-extension', 'jev', 'failed'];
// Connected while the CV is read, so the search can start right after the review.
const chromeIds = ['chrome', 'chrome-profile', 'chrome-extension', 'failed'];
// Missing agents and a closed Chrome connection are checked again on their own.
const RECHECK_MS = 5000,
  EXTENSION_RECHECK_MS = 2000;
const modes = [
  [
    'observe',
    'Only find',
    'Finds and scores suitable listings; applies only when you say "Apply".',
  ],
  ['auto', 'Find and apply', 'Also applies on its own to listings that reach the minimum score.'],
];
const flagKey = (id) => 'onboarding:' + id;

const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const button = (text, onclick, cls = 'quiet') => {
  const node = el('button', text, cls);
  node.type = 'button';
  node.onclick = onclick;
  return node;
};
// The fixes a readiness check offers: a command to copy, a page to open or an
// extension setup step the app performs.
function fixAction(api, action) {
  if (Array.isArray(action)) {
    const box = el('div', null, 'onboarding-fixes');
    box.append(...action.map((one) => fixAction(api, one)));
    return box;
  }
  const box = el('div', null, 'onboarding-fix');
  if (action.extension) {
    box.append(
      button(
        action.label,
        () => api.extensionSetup?.(action.extension, action.profile).catch(() => {}),
        'link',
      ),
    );
    return box;
  }
  if (action.link) {
    box.append(button(action.label, () => api.openLink(action.link).catch(() => {}), 'link'));
    return box;
  }
  const copy = button(
    action.label,
    () =>
      navigator.clipboard.writeText(action.command).then(
        () => (copy.textContent = 'Copied'),
        () => {},
      ),
    'link',
  );
  box.append(el('code', action.command), copy);
  return box;
}

// Small drawings of what each extension setup step looks like in Chrome.
const STEP_ICONS = {
  toggle:
    '<svg viewBox="0 0 40 24" aria-hidden="true"><rect x="2" y="4" width="36" height="16" rx="8"/><circle cx="29" cy="12" r="5"/></svg>',
  folder:
    '<svg viewBox="0 0 40 24" aria-hidden="true"><path d="M3 6h9l3 3h12v11H3z"/><path d="M29 14h8m-3-3 3 3-3 3"/></svg>',
  check:
    '<svg viewBox="0 0 40 24" aria-hidden="true"><circle cx="20" cy="12" r="9"/><path d="m15 12 4 4 7-8"/></svg>',
};
export function installSteps(steps) {
  const list = el('ol', null, 'install-steps');
  for (const step of steps) {
    const row = el('li'),
      icon = el('span', null, 'install-step-icon');
    icon.innerHTML = STEP_ICONS[step.icon] ?? '';
    row.append(icon, el('span', step.text));
    list.append(row);
  }
  return list;
}

export function onboardingStep(data) {
  const run = interviewRun(data);
  if (run && !conversationWaiting(run)) return 'reading';
  return (data.runs ?? []).some((r) => r.kind === 'interview') ? 'review' : 'start';
}

// A blank workspace, or one whose CV was uploaded but whose profile is not saved yet.
export function wantsOnboarding(data) {
  const a = data.automation,
    flag = localStorage.getItem(flagKey(a.id));
  return (
    Boolean(data.definition?.onboarding) &&
    flag !== 'skip' &&
    a.reviewedRevision == null &&
    (flag === 'cv' || automationProgress(data).fresh)
  );
}

export function onboardingScreen(api, {getCatalog, created, finish, chat, cancel}) {
  const root = el('div', null, 'onboarding');
  root.id = 'onboarding';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Start a job search');
  document.body.append(root);
  const head = el('header', null, 'onboarding-head'),
    steps = el('ol', null, 'onboarding-steps'),
    card = el('section', null, 'onboarding-card'),
    error = el('p', null, 'onboarding-error');
  head.append(el('b', 'AutoJob', 'onboarding-brand'), steps);
  for (const label of ['CV', 'Reading', 'Review']) steps.append(el('li', label));
  error.setAttribute('role', 'alert');
  error.hidden = true;
  root.append(head, card, error);
  let id = null,
    data = null,
    step = null,
    cancellable = false,
    busy = false,
    loading = 0,
    unsubscribe = null,
    timer = null,
    providers = new Map(),
    providersAt = 0,
    checkingProviders = false,
    provider = null,
    readiness = null,
    readinessAt = 0,
    checkingReadiness = false,
    readinessKey = '',
    readingRevision = null,
    terminalShown = true,
    reviewKey = '',
    reviewDirty = false,
    terminal = null;

  const showError = (message = '') => {
    error.textContent = message;
    error.hidden = !message;
  };
  async function attempt(fn) {
    if (busy) return;
    busy = true;
    showError();
    render();
    try {
      await fn();
    } catch (failure) {
      showError(failure.message);
    } finally {
      busy = false;
      render();
    }
  }

  async function open(workspaceId = null) {
    id = workspaceId;
    data = null;
    step = null;
    reviewKey = '';
    reviewDirty = false;
    readiness = null;
    showError();
    root.hidden = false;
    document.body.classList.add('onboarding-open');
    unsubscribe ??= api.onAutomationChange((event) => {
      if (id && (!event.automationId || event.automationId === id)) load();
    });
    timer ??= setInterval(tick, 1000);
    const list = await api.workspaces().catch(() => []);
    cancellable = list.some((item) => item.id !== id);
    await load();
    if (!providers.size) checkProviders();
  }
  function close() {
    closeTerminal();
    root.hidden = true;
    document.body.classList.remove('onboarding-open');
    unsubscribe?.();
    unsubscribe = null;
    clearInterval(timer);
    timer = null;
    id = null;
    data = null;
  }
  async function load() {
    const owner = id,
      version = ++loading;
    if (owner) {
      let next;
      try {
        next = await api.workspaceSnapshot(owner);
      } catch (failure) {
        if (owner === id) showError(failure.message);
        return;
      }
      if (owner !== id || version !== loading) return;
      data = next;
    }
    render();
  }

  // Agent check: installed command and a signed-in session, per provider.
  // A quiet check keeps the shown states until the new ones arrive.
  async function checkProviders(quiet = false) {
    if (checkingProviders) return;
    checkingProviders = true;
    const catalog = getCatalog().filter((p) => p.supported && providerOrder.includes(p.id));
    catalog.sort((x, y) => providerOrder.indexOf(x.id) - providerOrder.indexOf(y.id));
    if (!quiet || !providers.size)
      providers = new Map(catalog.map((p) => [p.id, {label: p.label, state: 'checking'}]));
    render();
    await Promise.all(
      catalog.map(async (p) => {
        let state = 'error',
          detail = '',
          action = null;
        try {
          const result = await api.readiness({provider: p.id}),
            failed = result.checks.find(
              (c) => ['agent', 'login'].includes(c.id) && c.state === 'error',
            ),
            warning = result.checks.find((c) => c.id === 'login' && c.state === 'warning');
          state = failed ? 'error' : warning ? 'warning' : 'ready';
          detail = failed?.detail ?? warning?.detail ?? '';
          action = failed?.action ?? warning?.action ?? null;
        } catch (failure) {
          detail = failure.message;
        }
        providers.set(p.id, {label: p.label, state, detail, action});
      }),
    );
    providersAt = Date.now();
    checkingProviders = false;
    if (!provider || providers.get(provider)?.state === 'error')
      provider =
        [...providers].find(([, p]) => p.state === 'ready')?.[0] ??
        [...providers].find(([, p]) => p.state === 'warning')?.[0] ??
        [...providers.keys()][0] ??
        null;
    render();
  }

  function render() {
    if (root.hidden) return;
    const next = id && data ? onboardingStep(data) : 'start';
    root.dataset.step = next;
    const current = ['start', 'reading', 'review'].indexOf(next);
    [...steps.children].forEach((item, index) => {
      item.dataset.state = index < current ? 'done' : index === current ? 'current' : 'pending';
    });
    if (next !== step) {
      closeTerminal();
      step = next;
      readinessKey = '';
      if (step === 'reading') {
        readingRevision = data.automation.revision;
        terminalShown = true;
      }
      card.replaceChildren(
        ...(step === 'start' ? startStep() : step === 'reading' ? readingStep() : reviewStep()),
      );
      if (step === 'reading') openTerminal(card.querySelector('.onboarding-terminal'));
    }
    update();
  }

  function startStep() {
    const intro = [
      el('h1', 'Let’s start your job search from your CV'),
      el(
        'p',
        'Choose your CV. The agent builds your profile from it; you review it and start the search.',
        'onboarding-lead',
      ),
    ];
    const agents = el('fieldset', null, 'onboarding-agents');
    agents.append(el('legend', 'Which AI agent should run?'), el('div', null, 'authorization'));
    const notes = el('label', 'Notes for the agent (optional)', 'onboarding-notes'),
      input = el('textarea');
    input.name = 'notes';
    input.maxLength = 12000;
    input.placeholder =
      'Where do you want to work, which roles, remote or on-site, salary, start date, anything your CV does not say.';
    notes.append(input);
    const cv = el('div', null, 'onboarding-cv-row'),
      pick = button('Choose CV', () => attempt(pickCv), 'onboarding-cv');
    pick.dataset.action = 'pick-cv';
    cv.append(pick, el('span', null, 'onboarding-cv-file'));
    const hint = el(
      'small',
      'PDF, DOCX or TXT. The file stays on this computer; your notes go to the agent with it.',
      'onboarding-hint',
    );
    const begin = button('Start', () => attempt(startReading), 'primary onboarding-start');
    begin.dataset.action = 'start';
    const links = el('div', null, 'onboarding-links');
    links.append(button('I want to set it up in a chat', () => attempt(skip), 'link'));
    return [...intro, agents, notes, cv, hint, begin, links];
  }
  function readingStep() {
    const status = el('div', null, 'onboarding-progress'),
      milestones = el('ol', null, 'onboarding-milestones');
    for (const label of ['Starting the setup agent', 'Reading your CV', 'Filling in your profile'])
      milestones.append(el('li', label));
    status.append(milestones, el('span', '0:00', 'onboarding-elapsed'));
    // Claude's folder trust question has one safe answer, so it gets a button here.
    const attention = el('div', null, 'onboarding-attention'),
      trust = button(
        'Trust this folder',
        () =>
          attempt(async () => {
            for (const key of terminal?.trust ?? []) {
              await api.input(id, key, CONVERSATION_WORKER, conversationSession()?.sessionId);
              await new Promise((resolve) => setTimeout(resolve, 150));
            }
          }),
        'primary',
      );
    trust.dataset.action = 'trust';
    attention.append(el('p'), trust);
    attention.hidden = true;
    const chrome = el('section', null, 'onboarding-readiness');
    chrome.setAttribute('aria-label', 'Chrome');
    // The terminal stays laid out while hidden so it keeps its size and prompts are read.
    const wrap = el('div', null, 'onboarding-terminal-wrap'),
      screen = el('div', null, 'worker-terminal onboarding-terminal');
    screen.setAttribute('aria-label', 'Setup agent terminal');
    wrap.append(screen);
    const toggle = button(
      'Show the agent terminal',
      () => {
        terminalShown = !terminalShown;
        update();
      },
      'link',
    );
    toggle.dataset.action = 'terminal';
    const links = el('div', null, 'onboarding-links');
    links.append(
      toggle,
      button('Open the agent screen', () => chat(id), 'link'),
    );
    return [
      el('h1', 'Reading your CV'),
      el(
        'p',
        'The agent is building your profile from your CV. This usually takes a minute or two; the screen moves on by itself. Meanwhile, connect Chrome: the search runs in it.',
        'onboarding-lead',
      ),
      status,
      attention,
      chrome,
      wrap,
      links,
    ];
  }

  // The setup agent's live terminal, so approvals it asks for can be answered here.
  const conversationSession = () =>
    data?.workers?.find((w) => w.id === CONVERSATION_WORKER)?.active ?? null;
  function openTerminal(container) {
    const owner = id,
      t = {owner, pending: [], loading: true, sequence: 0, prompt: null};
    t.surface = new WorkerTerminalSurface(
      (text) =>
        api
          .input(owner, text, CONVERSATION_WORKER, conversationSession()?.sessionId)
          .catch((failure) => showError(failure.message)),
      (rows, cols) =>
        api
          .resize(owner, rows, cols, CONVERSATION_WORKER, conversationSession()?.sessionId)
          .catch(() => {}),
      () => {},
    );
    t.unsubscribe = api.onAgentEvent((event) => {
      if (
        event.candidateId !== owner ||
        event.workerId !== CONVERSATION_WORKER ||
        event.event !== 'output'
      )
        return;
      if (t.loading) t.pending.push(event);
      else writeTerminal(t, event);
    });
    terminal = t;
    void replayTerminal(t, container);
  }
  async function replayTerminal(t, container) {
    try {
      await t.surface.mount(container);
      if (t !== terminal) return;
      const output = await api.terminalOutput(t.owner, CONVERSATION_WORKER);
      if (t !== terminal) return;
      await t.surface.restore(output);
      if (t !== terminal) return;
      t.sequence = output.sequence;
      for (const event of t.pending) writeTerminal(t, event);
    } catch (failure) {
      if (t === terminal) showError(failure.message);
    } finally {
      if (t === terminal) {
        t.loading = false;
        t.pending = [];
        t.surface.finishRestore();
        sampleTerminal(t);
      }
    }
  }
  function writeTerminal(t, event) {
    if (event.sequence <= t.sequence) return;
    t.sequence = event.sequence;
    t.surface.write(new Uint8Array(event.bytes), () => sampleTerminal(t));
  }
  // Claude's folder trust question and permission prompts fire no agent state change.
  function sampleTerminal(t) {
    if (t !== terminal) return;
    const rows = t.surface.terminal.rows,
      screen = t.surface.probe().text.split('\n').slice(-rows).join('\n'),
      found = terminalAttention(screen, conversationSession()?.state);
    const prompt = ['trust', 'permission'].includes(found?.kind) ? found.kind : null,
      trust = prompt === 'trust' ? trustKeys(screen) : null;
    if (prompt === t.prompt && JSON.stringify(trust) === JSON.stringify(t.trust)) return;
    t.prompt = prompt;
    t.trust = trust;
    update();
  }
  function closeTerminal() {
    if (!terminal) return;
    terminal.unsubscribe();
    terminal.surface.dispose();
    terminal = null;
  }
  function reviewStep() {
    reviewKey = '';
    const form = el('form', null, 'onboarding-form');
    form.onsubmit = (event) => {
      event.preventDefault();
      attempt(() => save(form));
    };
    form.oninput = (event) => {
      reviewDirty = true;
      if (event.target.name === 'country') renderSources(form);
    };
    return [
      el('h1', 'Review your profile'),
      el('p', null, 'onboarding-reply'),
      el('div', null, 'onboarding-failure'),
      form,
      el('div', null, 'onboarding-links'),
    ];
  }

  function update() {
    // Every step can be left; on a first run with no other profile, leaving means starting over.
    const links = card.querySelector('.onboarding-links'),
      leave = cancellable ? 'Cancel' : step === 'start' ? null : 'Start over';
    if (links && leave && !links.querySelector('[data-cancel]')) {
      const node = button(leave, () => attempt(leaveOnboarding), 'link');
      node.dataset.cancel = '';
      links.append(node);
    }
    if (step === 'start') {
      const list = card.querySelector('.onboarding-agents .authorization');
      list.replaceChildren();
      for (const [value, p] of providers) {
        const row = el('div', null, 'onboarding-agent'),
          choice = el('label', null, 'choice'),
          input = el('input'),
          copy = el('span');
        input.type = 'radio';
        input.name = 'onboarding-provider';
        input.value = value;
        input.checked = value === provider;
        input.onchange = () => {
          provider = value;
          render();
        };
        const name = el('b', p.label);
        if (value === RECOMMENDED_PROVIDER)
          name.append(' ', el('span', 'Recommended', 'onboarding-badge'));
        copy.append(
          name,
          el(
            'small',
            p.state === 'checking'
              ? 'Checking…'
              : p.state === 'ready'
                ? 'Ready'
                : p.detail || 'Unavailable',
          ),
        );
        choice.dataset.state = p.state;
        choice.append(input, copy);
        row.append(choice);
        if (p.action && p.state !== 'ready') row.append(fixAction(api, p.action));
        list.append(row);
      }
      if (!providers.size) list.append(el('p', 'Loading the agent list…', 'onboarding-hint'));
      else if (![...providers.values()].some((p) => ['ready', 'checking'].includes(p.state)))
        list.append(
          el(
            'p',
            'Install or sign in to one of these agents. This screen checks again every few seconds.',
            'onboarding-hint',
          ),
        );
      const blocked = !provider || ['checking', 'error'].includes(providers.get(provider)?.state),
        file = chosenCv(),
        pick = card.querySelector('[data-action=pick-cv]');
      pick.disabled = busy;
      pick.textContent = file ? 'Choose another CV' : 'Choose CV';
      card.querySelector('.onboarding-cv-file').textContent = file ?? '';
      card.querySelector('[data-action=start]').disabled = busy || blocked || file == null;
    } else if (step === 'reading') {
      const run = interviewRun(data),
        prompt = terminal?.prompt,
        attention = card.querySelector('.onboarding-attention'),
        waiting = Boolean(prompt || run?.state === 'AwaitingInput' || run?.usageLimit);
      attention.hidden = !waiting;
      // Without a readable menu the user answers the trust question in the terminal.
      const trust = prompt === 'trust' && !run?.usageLimit && Boolean(terminal?.trust);
      attention.querySelector('p').textContent = run?.usageLimit
        ? 'The agent reached its usage limit. Check the status in the terminal below.'
        : trust
          ? 'Claude Code asks whether it may work in this profile’s folder. The folder belongs to AutoJob.'
          : prompt === 'trust'
            ? 'Claude Code asks whether it may work in this profile’s folder. Choose “Yes, I trust this folder” in the terminal below and press Enter.'
            : 'The agent is waiting for an approval to continue. Answer it in the terminal below.';
      const trustButton = attention.querySelector('[data-action=trust]');
      trustButton.hidden = !trust;
      trustButton.disabled = busy;
      // Other questions are answered in the terminal itself.
      if (waiting && !trust) terminalShown = true;
      card.querySelector('.onboarding-terminal-wrap').dataset.shown = String(terminalShown);
      card.querySelector('[data-action=terminal]').textContent = terminalShown
        ? 'Hide the agent terminal'
        : 'Show the agent terminal';
      // Milestones: the agent session is up, then the profile is saved.
      const started = Boolean(conversationSession()),
        filled = data.automation.revision !== readingRevision,
        reached = filled ? 2 : started ? 1 : 0;
      [...card.querySelectorAll('.onboarding-milestones li')].forEach((item, index) => {
        item.dataset.state = index < reached ? 'done' : index === reached ? 'current' : 'pending';
      });
      if (!readiness) checkReadiness();
      renderReadiness();
      tick();
    } else if (step === 'review') updateReview();
  }
  function tick() {
    // Missing agents and Chrome setup are checked again until they are ready.
    const now = Date.now();
    if (
      step === 'start' &&
      providers.size &&
      now - providersAt > RECHECK_MS &&
      ![...providers.values()].some((p) => ['ready', 'checking'].includes(p.state))
    )
      void checkProviders(true);
    if (
      data &&
      ['reading', 'review'].includes(step) &&
      readiness?.checked &&
      !checkingReadiness &&
      now - readinessAt > RECHECK_MS &&
      openChecks().some((c) => chromeIds.includes(c.id))
    )
      void checkReadiness();
    // A missing extension is a local file check: look for it sooner, so the
    // step turns ready right after the user installs it.
    else if (
      data &&
      ['reading', 'review'].includes(step) &&
      !checkingReadiness &&
      !checkingExtension &&
      now - extensionAt > EXTENSION_RECHECK_MS &&
      openChecks().some((c) => c.id === 'chrome-extension')
    )
      void checkExtension();
    if (step !== 'reading' || !data) return;
    // Run times are epoch milliseconds.
    const run = interviewRun(data),
      since = new Date(run?.lastMessageAt ?? run?.startedAt ?? NaN).getTime(),
      seconds = Number.isFinite(since) ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0;
    const label = card.querySelector('.onboarding-elapsed');
    if (label)
      label.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function updateReview() {
    const a = data.automation,
      reply = [...data.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.conversation && m.runId),
      latest = data.runs.find((r) => r.kind === 'interview'),
      undelivered = interviewRun(data)?.undelivered,
      failed =
        undelivered ||
        (!interviewRun(data) && ['failed', 'timeout', 'interrupted'].includes(latest?.status));
    card.querySelector('.onboarding-reply').textContent =
      reply?.text ?? 'Check the details the agent filled in and complete anything missing.';
    const failure = card.querySelector('.onboarding-failure');
    failure.replaceChildren();
    if (failed)
      failure.append(
        el(
          'p',
          undelivered
            ? 'The CV task did not reach the setup agent.'
            : 'Could not build the profile from the CV: ' +
                (latest.summary || 'the agent could not finish.'),
        ),
        button('Try again', () => attempt(readAgain)),
      );
    const form = card.querySelector('.onboarding-form'),
      key = JSON.stringify([a.revision, a.updatedAt]);
    if (key !== reviewKey && !reviewDirty) {
      reviewKey = key;
      fillReview(form);
    }
    form.querySelector('[type=submit]').disabled = busy;
    form.querySelector('[data-action=read-again]').disabled = busy;
    if (!readiness) checkReadiness();
  }
  function fillReview(form) {
    const a = data.automation,
      fields = new Map((data.definition?.fields ?? []).map((f) => [f.id, f]));
    form.replaceChildren();
    const text = (name, label, value, {placeholder = '', multiline = true, required = false}) => {
      const field = el('label', label),
        input = el(multiline ? 'textarea' : 'input');
      input.name = name;
      input.value = value ?? '';
      input.placeholder = placeholder;
      input.required = required;
      input.maxLength = 6000;
      field.append(input);
      return field;
    };
    const profile = el('div', null, 'onboarding-fields');
    profile.append(
      text('title', 'Full name', a.title === data.definition?.title ? '' : a.title, {
        placeholder: 'Your first and last name',
        multiline: false,
      }),
      text('goal', 'The job you are looking for', a.goal, {
        placeholder: 'E.g. senior backend engineering in Berlin or remote',
        required: true,
      }),
    );
    for (const key of reviewFields) {
      const field = fields.get(key);
      if (!field) continue;
      profile.append(
        text(key, field.label, a.criteria[key], {
          placeholder: field.question,
          multiline: !['country', 'location'].includes(key),
          required: field.required,
        }),
      );
    }
    const rules = fields.get('hard_rules');
    if (rules)
      profile.append(rulesField('hard_rules', rules.label, a.criteria.hard_rules, RULES_HINT));
    const experience = fields.get('experience');
    if (experience) {
      const more = el('details', null, 'onboarding-more');
      more.append(
        el('summary', experience.label),
        text('experience', experience.label, a.criteria.experience, {
          placeholder: experience.question,
        }),
      );
      profile.append(more);
    }
    const mode = el('fieldset', null, 'onboarding-section'),
      choices = el('div', null, 'authorization');
    mode.append(el('legend', 'Agent permissions'), choices);
    for (const [value, title, description] of modes) {
      const choice = el('label', null, 'choice'),
        input = el('input'),
        copy = el('span');
      input.type = 'radio';
      input.name = 'mode';
      input.value = value;
      input.required = true;
      input.checked = value === a.mode;
      copy.append(el('b', title), el('small', description));
      choice.append(input, copy);
      choices.append(choice);
    }
    // Find and apply only runs with an explicit minimum score.
    const score = el('label', 'Minimum score to apply', 'authorization-score'),
      scoreInput = el('input');
    Object.assign(scoreInput, {
      name: 'score_threshold',
      type: 'number',
      min: '1',
      max: '100',
      step: '1',
      placeholder: '1–100, required for Find and apply',
      value: a.criteria.score_threshold || String(DEFAULT_SCORE_THRESHOLD),
    });
    score.append(scoreInput);
    choices.append(score);
    const syncScore = () => {
      const auto = form.elements.mode.value === 'auto';
      scoreInput.required = auto;
      score.hidden = !auto;
    };
    choices.addEventListener('change', syncScore);
    const sources = el('fieldset', null, 'onboarding-section onboarding-sources');
    sources.append(el('legend', 'Where should we search?'), el('div', null, 'onboarding-checks'));
    const checks = el('section', null, 'onboarding-readiness');
    checks.setAttribute('aria-label', 'Before you start');
    const foot = el('div', null, 'onboarding-foot'),
      again = button('Refill from CV', () => attempt(readAgain)),
      submit = el('button', 'Save and start the search', 'primary');
    again.dataset.action = 'read-again';
    submit.type = 'submit';
    foot.append(again, submit);
    form.append(profile, mode, sources, checks, foot);
    readinessKey = '';
    syncScore();
    renderSources(form);
    renderReadiness();
  }
  // Saved sources, the template boards for the country typed on the form, and
  // the remote work boards for the user to tick.
  function renderSources(form) {
    const list = form.querySelector('.onboarding-checks'),
      country = (form.elements.country?.value ?? '').trim().toUpperCase(),
      previous = new Map(
        [...list.querySelectorAll('input')].map((input) => [input.value, input.checked]),
      );
    list.replaceChildren();
    const row = (url, name, detail, checked) => {
      const label = el('label', null, 'check'),
        input = el('input'),
        copy = el('span');
      input.type = 'checkbox';
      input.name = 'source';
      input.value = url;
      input.checked = previous.get(url) ?? checked;
      copy.append(el('b', name), el('small', detail));
      label.append(input, copy);
      list.append(label);
    };
    for (const source of data.sources)
      row(source.url, source.name, new URL(source.url).hostname, source.enabled);
    for (const group of data.sourceCatalog ?? [])
      for (const choice of group.choices)
        if (country && choice.countries.includes(country) && choice.enabled !== false)
          row(choice.url, choice.name, 'Suggested · ' + choice.label, true);
        else if (country && choice.countries.includes(country))
          row(choice.url, choice.name, 'Optional · ' + choice.label, false);
        else if (choice.remote) row(choice.url, choice.name, 'Optional · ' + choice.label, false);
  }
  const openChecks = () =>
    (readiness?.checks ?? []).filter((c) => readinessIds.includes(c.id) && c.state !== 'ready');
  // Reading step: the Chrome setup, done while the agent reads. Review: whatever is still open.
  function renderReadiness() {
    const root = card.querySelector('.onboarding-readiness');
    if (!root || !readiness) return;
    const chromeOnly = step === 'reading',
      open = openChecks().filter((c) => !chromeOnly || chromeIds.includes(c.id)),
      key = JSON.stringify([step, readiness.checked, open]);
    if (key === readinessKey) return;
    readinessKey = key;
    root.replaceChildren();
    root.dataset.state = open.length ? 'open' : 'ready';
    root.hidden = !chromeOnly && !open.length;
    if (chromeOnly && !readiness.checked) {
      root.append(el('p', 'Checking Chrome…', 'onboarding-hint'));
      return;
    }
    if (chromeOnly && !open.length) {
      root.append(el('b', '✓ Chrome is ready', 'onboarding-ready'));
      return;
    }
    if (!open.length) return;
    root.append(el('h2', chromeOnly ? 'Connect Chrome' : 'Before you start'));
    for (const check of open) {
      const item = el('div', null, 'onboarding-check');
      item.dataset.state = check.state;
      item.append(el('b', check.label), el('span', check.detail));
      if (check.steps) item.append(installSteps(check.steps));
      if (check.action) item.append(fixAction(api, check.action));
      // The Jev key is entered later under Configuration → Jev; here the
      // worker agent can take over the listing decisions instead.
      if (check.id === 'jev') {
        const key = el('div', null, 'onboarding-key');
        key.append(
          button(
            'Let the agent decide instead',
            () =>
              attempt(async () => {
                const agentSettings = {...data.automation.agentSettings, decisions: 'agent'};
                await api.automationSave(id, {agentSettings});
                data.automation.agentSettings = agentSettings;
                await checkReadiness();
              }),
            'link',
          ),
        );
        item.append(key);
      }
      root.append(item);
    }
    root.append(
      el('small', 'This list checks again every few seconds.', 'onboarding-hint'),
      button('Check again', () => checkReadiness(), 'link'),
    );
  }
  let checkingExtension = false,
    extensionAt = 0;
  async function checkExtension() {
    checkingExtension = true;
    const installed = await api.extensionInstalled?.().catch(() => false);
    extensionAt = Date.now();
    checkingExtension = false;
    if (installed) await checkReadiness();
  }
  async function checkReadiness() {
    if (checkingReadiness) return;
    const owner = id;
    checkingReadiness = true;
    readiness ??= {checks: []};
    let next;
    try {
      next = await api.readiness({
        provider: data.automation.agentSettings.provider,
        decisions: data.automation.agentSettings.decisions ?? 'agent',
      });
    } catch (failure) {
      next = {
        checks: [{id: 'failed', label: 'Setup check', state: 'error', detail: failure.message}],
      };
    }
    readinessAt = Date.now();
    checkingReadiness = false;
    if (owner !== id) return;
    readiness = {...next, checked: true};
    renderReadiness();
  }

  async function prepare() {
    if (!id) {
      const a = await api.workspaceCreate('job-search', {});
      id = a.id;
      await created(id);
    }
    if (provider) {
      const settings = withAgentDefaults({provider});
      await api.automationSave(id, {agentSettings: settings});
      await api.setupAgentSettings(id, withSetupAgentDefaults({provider}));
    }
    return id;
  }
  // The latest document the user added; the setup agent reads it after Start.
  const chosenCv = () => {
    const m = data?.messages?.findLast((m) => m.role === 'system' && m.document);
    return m ? (m.documentName ?? m.document.split('/').pop()) : null;
  };
  async function pickCv() {
    const owner = await prepare();
    if (!(await api.pickDocument(owner))) return;
    localStorage.setItem(flagKey(owner), 'cv');
    await load();
  }
  async function startReading() {
    const notes = card.querySelector('[name=notes]')?.value ?? '',
      owner = await prepare();
    await api.automationOnboarding(owner, {notes});
    await load();
  }
  async function readAgain() {
    reviewDirty = false;
    await api.automationOnboarding(id);
    await load();
  }
  async function skip() {
    const notes = (card.querySelector('[name=notes]')?.value ?? '').trim(),
      owner = await prepare();
    localStorage.setItem(flagKey(owner), 'skip');
    // Notes start the chat setup as its first message.
    if (notes) await api.automationMessage(owner, notes);
    await chat(owner);
    close();
  }
  // Before the CV only an untouched workspace is removed; after it, leaving
  // discards the unfinished profile together with its setup agent.
  async function leaveOnboarding() {
    const owner = id,
      started = step !== 'start',
      empty = Boolean(
        data && automationProgress(data).fresh && !data.documents?.some((d) => !d.generated),
      );
    if (
      started &&
      !confirm(
        (cancellable ? 'Cancel this profile?' : 'Start over?') +
          ' The CV and everything the agent filled in are deleted.',
      )
    )
      return;
    close();
    if (owner && (started || empty)) localStorage.removeItem(flagKey(owner));
    await cancel(owner, {remove: started || empty});
    if (!cancellable) await open();
  }
  async function save(form) {
    const owner = id,
      f = form.elements;
    if (data.automation.agentSettings?.decisions === 'jev') {
      const jev = await api.jevSettingsStatus();
      if (!jev.configured)
        throw Error(
          jev.error ??
            'Save the TypeSafe API key under Configuration → Jev, or let the agent make the listing decisions.',
        );
    }
    const chosen = new Set(
      [...form.querySelectorAll('input[name=source]')].filter((i) => i.checked).map((i) => i.value),
    );
    if (!chosen.size) throw Error('Choose at least one source.');
    for (const source of data.sources)
      if (chosen.has(source.url) !== source.enabled)
        await api.automationSourceSave(owner, source.url, {enabled: chosen.has(source.url)});
    for (const group of data.sourceCatalog ?? [])
      for (const choice of group.choices)
        if (chosen.has(choice.url) && !data.sources.some((s) => s.url === choice.url)) {
          await api.automationSourceAdd(owner, {url: choice.url, name: choice.name});
          // A board off in the template joins switched on when the user ticks it.
          if (choice.enabled === false)
            await api.automationSourceSave(owner, choice.url, {enabled: true});
        }
    const current = (await api.workspaceSnapshot(owner)).automation,
      criteria = {...current.criteria};
    for (const key of reviewFields) if (f[key]) criteria[key] = f[key].value.trim();
    if (f.experience) criteria.experience = f.experience.value.trim();
    if (f.hard_rules) criteria.hard_rules = f.hard_rules.value.trim();
    criteria.score_threshold = f.score_threshold.value.trim();
    if (criteria.country) criteria.country = criteria.country.toUpperCase();
    delete criteria.save_score_threshold;
    await api.automationProfileSave(
      owner,
      {
        title: f.title.value.trim() || current.title,
        goal: f.goal.value.trim(),
        criteria,
        mode: f.mode.value,
      },
      {expectedRevision: current.revision},
    );
    await api.workspaceStart(owner);
    localStorage.removeItem(flagKey(owner));
    await finish(owner);
    close();
  }

  return {open, close};
}
