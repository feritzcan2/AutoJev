import {interviewRun, conversationWaiting} from '../app/workspaces/conversation.mjs';
import {automationProgress} from '../app/automation/progress.mjs';
import {defaultPermission} from '../app/agents/settings.mjs';
import './onboarding.css';

// Welcome screen of a new job search: the user picks the agent and the CV, the
// setup agent fills the profile from the CV, the user reviews it and starts.
const providerOrder = ['claude', 'codex', 'opencode'];
// The review form shows these criteria; the rest stay on the profile page.
const reviewFields = ['preferences', 'country', 'location', 'constraints', 'application_facts'];
const readinessIds = ['chrome', 'chrome-profile', 'chrome-debug', 'jev', 'failed'];
const modes = [
  [
    'observe',
    'Find and notify',
    'Finds and scores suitable listings; does not submit applications.',
  ],
  ['prepare', 'Find, leave applying to me', 'Applies when you say "Apply".'],
  ['auto', 'Apply automatically', 'Applies to suitable listings on its own.'],
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
  head.append(el('b', 'AutoJev', 'onboarding-brand'), steps);
  for (const label of ['CV', 'Profile', 'Start']) steps.append(el('li', label));
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
    provider = null,
    readiness = null,
    reviewKey = '',
    reviewDirty = false;

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
  async function checkProviders() {
    const catalog = getCatalog().filter((p) => p.supported && providerOrder.includes(p.id));
    catalog.sort((x, y) => providerOrder.indexOf(x.id) - providerOrder.indexOf(y.id));
    providers = new Map(catalog.map((p) => [p.id, {label: p.label, state: 'checking'}]));
    render();
    await Promise.all(
      catalog.map(async (p) => {
        let state = 'error',
          detail = '';
        try {
          const result = await api.readiness({provider: p.id}),
            failed = result.checks.find(
              (c) => ['agent', 'login'].includes(c.id) && c.state === 'error',
            ),
            warning = result.checks.find((c) => c.id === 'login' && c.state === 'warning');
          state = failed ? 'error' : warning ? 'warning' : 'ready';
          detail = failed?.detail ?? warning?.detail ?? '';
        } catch (failure) {
          detail = failure.message;
        }
        providers.set(p.id, {label: p.label, state, detail});
      }),
    );
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
    const current = next === 'start' ? 0 : 1;
    [...steps.children].forEach((item, index) => {
      item.dataset.state = index < current ? 'done' : index === current ? 'current' : 'pending';
    });
    if (next !== step) {
      step = next;
      card.replaceChildren(
        ...(step === 'start' ? startStep() : step === 'reading' ? readingStep() : reviewStep()),
      );
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
    const pick = button('Choose CV', () => attempt(pickCv), 'primary onboarding-cv');
    pick.dataset.action = 'pick-cv';
    const hint = el(
      'small',
      'PDF, DOCX or TXT. The file stays on this computer; your notes go to the agent with it.',
      'onboarding-hint',
    );
    const links = el('div', null, 'onboarding-links');
    links.append(button('I want to set it up in a chat', () => attempt(skip), 'link'));
    return [...intro, agents, notes, pick, hint, links];
  }
  function readingStep() {
    const status = el('div', null, 'onboarding-progress');
    status.append(el('span', null, 'onboarding-spinner'), el('span', '0:00', 'onboarding-elapsed'));
    const attention = el('p', null, 'onboarding-attention');
    attention.hidden = true;
    const links = el('div', null, 'onboarding-links');
    links.append(button('Open the agent screen', () => chat(id), 'link'));
    return [
      el('h1', 'Reading your CV'),
      el(
        'p',
        'The agent is building your profile from your CV. This usually takes a minute or two; the screen moves on by itself.',
        'onboarding-lead',
      ),
      status,
      attention,
      links,
    ];
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
    ];
  }

  function update() {
    if (step === 'start') {
      const list = card.querySelector('.onboarding-agents .authorization');
      list.replaceChildren();
      for (const [value, p] of providers) {
        const choice = el('label', null, 'choice'),
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
        copy.append(
          el('b', p.label),
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
        list.append(choice);
      }
      if (!providers.size) list.append(el('p', 'Loading the agent list…', 'onboarding-hint'));
      const blocked = !provider || ['checking', 'error'].includes(providers.get(provider)?.state);
      card.querySelector('[data-action=pick-cv]').disabled = busy || blocked;
      card.querySelector('[data-action=pick-cv]').textContent = busy ? 'Adding CV…' : 'Choose CV';
      const links = card.querySelector('.onboarding-links');
      if (cancellable && !links.querySelector('[data-cancel]')) {
        const leave = button('Cancel', () => attempt(leaveOnboarding), 'link');
        leave.dataset.cancel = '';
        links.append(leave);
      }
    } else if (step === 'reading') {
      const run = interviewRun(data),
        attention = card.querySelector('.onboarding-attention');
      attention.hidden = !(run?.state === 'AwaitingInput' || run?.usageLimit);
      attention.textContent = run?.usageLimit
        ? 'The agent reached its usage limit. Check the status on the agent screen.'
        : 'The agent is waiting for an approval in the terminal to continue. Open the agent screen and answer.';
      tick();
    } else if (step === 'review') updateReview();
  }
  function tick() {
    if (step !== 'reading' || !data) return;
    const run = interviewRun(data),
      since = Date.parse(run?.lastMessageAt ?? run?.startedAt ?? ''),
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
      failed = !interviewRun(data) && ['failed', 'timeout', 'interrupted'].includes(latest?.status);
    card.querySelector('.onboarding-reply').textContent =
      reply?.text ?? 'Check the details the agent filled in and complete anything missing.';
    const failure = card.querySelector('.onboarding-failure');
    failure.replaceChildren();
    if (failed)
      failure.append(
        el(
          'p',
          'Could not build the profile from the CV: ' +
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
    if (!readiness) checkReadiness(form);
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
      input.checked = value === a.mode;
      copy.append(el('b', title), el('small', description));
      choice.append(input, copy);
      choices.append(choice);
    }
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
    renderSources(form);
    renderReadiness(form);
  }
  // Saved sources, plus the template boards for the country typed on the form.
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
        if (country && choice.countries.includes(country))
          row(choice.url, choice.name, 'Suggested · ' + choice.label, true);
  }
  function renderReadiness(form) {
    const root = form.querySelector('.onboarding-readiness');
    if (!root) return;
    root.replaceChildren();
    const open = (readiness?.checks ?? []).filter(
      (c) => readinessIds.includes(c.id) && c.state !== 'ready',
    );
    root.hidden = !open.length;
    if (!open.length) return;
    root.append(el('h2', 'Before you start'));
    for (const check of open) {
      const item = el('div', null, 'onboarding-check');
      item.dataset.state = check.state;
      item.append(el('b', check.label), el('span', check.detail));
      if (check.id === 'jev') {
        const key = el('div', null, 'onboarding-key'),
          input = el('input');
        input.type = 'password';
        input.name = 'jevKey';
        input.placeholder = 'TypeSafe API key';
        input.autocomplete = 'off';
        key.append(
          input,
          button('Save key', () =>
            attempt(async () => {
              await api.saveJevSettings({apiKey: input.value});
              readiness = null;
              checkReadiness(form);
            }),
          ),
        );
        item.append(key);
      }
      root.append(item);
    }
    root.append(button('Check again', () => checkReadiness(form), 'link'));
  }
  async function checkReadiness(form) {
    const owner = id;
    readiness = {checks: []};
    try {
      readiness = await api.readiness({provider: data.automation.agentSettings.provider});
    } catch (failure) {
      readiness = {
        checks: [{id: 'failed', label: 'Setup check', state: 'error', detail: failure.message}],
      };
    }
    if (owner === id && form.isConnected) renderReadiness(form);
  }

  async function prepare() {
    if (!id) {
      const a = await api.workspaceCreate('job-search', {});
      id = a.id;
      await created(id);
    }
    if (provider) {
      const settings = {
        provider,
        model: 'default',
        reasoning: 'default',
        permission: defaultPermission(provider),
      };
      await api.automationSave(id, {agentSettings: settings});
      await api.setupAgentSettings(id, settings);
    }
    return id;
  }
  async function pickCv() {
    const notes = card.querySelector('[name=notes]')?.value ?? '',
      owner = await prepare();
    if (!(await api.pickDocument(owner))) return;
    localStorage.setItem(flagKey(owner), 'cv');
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
  // An untouched workspace opened only for this screen is removed again.
  async function leaveOnboarding() {
    const owner = id,
      empty = Boolean(data && automationProgress(data).fresh && !data.documents?.length);
    close();
    await cancel(owner, {remove: empty});
  }
  async function save(form) {
    const owner = id,
      f = form.elements;
    const jev = await api.jevSettingsStatus();
    if (!jev.configured) throw Error(jev.error ?? 'Save the TypeSafe API key to start the search.');
    const chosen = new Set(
      [...form.querySelectorAll('input[name=source]')].filter((i) => i.checked).map((i) => i.value),
    );
    if (!chosen.size) throw Error('Choose at least one source.');
    for (const source of data.sources)
      if (chosen.has(source.url) !== source.enabled)
        await api.automationSourceSave(owner, source.url, {enabled: chosen.has(source.url)});
    for (const group of data.sourceCatalog ?? [])
      for (const choice of group.choices)
        if (chosen.has(choice.url) && !data.sources.some((s) => s.url === choice.url))
          await api.automationSourceAdd(owner, {url: choice.url, name: choice.name});
    const current = (await api.workspaceSnapshot(owner)).automation,
      criteria = {...current.criteria};
    for (const key of reviewFields) if (f[key]) criteria[key] = f[key].value.trim();
    if (f.experience) criteria.experience = f.experience.value.trim();
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
