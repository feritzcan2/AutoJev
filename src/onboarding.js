import {
  interviewRun,
  conversationWaiting,
  CONVERSATION_WORKER,
} from '../app/workspaces/conversation.mjs';
import {automationProgress} from '../app/automation/progress.mjs';
import {withAgentDefaults, withSetupAgentDefaults} from '../app/agents/settings.mjs';
import {WorkerTerminalSurface} from './worker-terminal-surface.js';
import {terminalAttention} from './agent-attention.js';
import './onboarding.css';
import {BRAND, markIcon} from './simple/brand.js';
import {readChoicePrompt, choiceKeys} from './simple/terminal-prompt.js';
import {NEVER, factLine, setFactLine, cvFacts} from './simple/facts.js';
import {docScan, checkmark, typewrite} from './simple/motion.js';
import {rulesField, RULES_HINT} from './template-fields.js';

// Welcome screen of a new job search: the user picks the agent and the CV, the
// setup agent fills the profile from the CV, the user reviews it and starts.
const providerOrder = ['claude', 'codex', 'opencode'];
// The review form shows these criteria; the rest stay on the profile page.
const reviewFields = ['preferences', 'country', 'location', 'application_facts'];
const readinessIds = ['chrome', 'chrome-profile', 'chrome-debug', 'jev', 'failed'];
const modes = [
  [
    'observe',
    'I pick, JobLoop applies',
    'Finds and scores jobs for you. Applies only to the ones you press Apply on.',
  ],
  ['auto', 'Full autopilot', 'Also applies on its own to jobs at or above your minimum fit score.'],
];
const flagKey = (id) => 'onboarding:' + id;
// Long free-text criteria fold away on the review form.
const folded = new Set(['constraints', 'application_facts']);
// Answer once: saved as "Label: answer" lines in the application facts.
const quickQuestions = [
  {
    id: 'permit',
    label: 'Work permit',
    title: 'Can you work in the countries you target?',
    choices: [
      ['Yes, I can', 'Allowed to work there without sponsorship'],
      ['I need a visa', 'Needs visa sponsorship'],
    ],
  },
  {
    id: 'relocation',
    label: 'Relocation',
    title: 'Open to relocating?',
    choices: [
      ['Yes', 'Yes'],
      ['Maybe', 'Open to it for the right role'],
      ['No', 'No'],
    ],
  },
  {
    id: 'notice',
    label: 'Notice period',
    title: 'When can you start?',
    placeholder: 'e.g. 1 month notice, or from 1 December',
  },
  {
    id: 'salary',
    label: 'Salary expectation',
    title: 'Salary expectation',
    placeholder: 'e.g. 70,000 a year',
    currency: true,
  },
  {
    id: 'languages',
    label: 'Languages',
    title: 'Languages and levels',
    placeholder: 'e.g. English C1, Turkish B2',
  },
];
// Salary currency: saved on its own line so later forms can use or convert it.
const CURRENCY = 'Salary currency';
const currencies = [
  'EUR',
  'USD',
  'GBP',
  'TRY',
  'CHF',
  'PLN',
  'SEK',
  'NOK',
  'DKK',
  'CZK',
  'CAD',
  'AUD',
  'AED',
  'JPY',
  'INR',
];
const countryCurrency = {
  TR: 'TRY',
  GB: 'GBP',
  US: 'USD',
  CH: 'CHF',
  PL: 'PLN',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  CZ: 'CZK',
  CA: 'CAD',
  AU: 'AUD',
  AE: 'AED',
  JP: 'JPY',
  IN: 'INR',
  ...Object.fromEntries(
    'DE FR NL ES IT IE AT BE FI PT GR LU EE LV LT SK SI HR MT CY'.split(' ').map((c) => [c, 'EUR']),
  ),
};
const symbolCurrency = {'€': 'EUR', $: 'USD', '£': 'GBP', '₺': 'TRY', '¥': 'JPY', '₹': 'INR'};
// The saved currency, else the one the amount is written in, else the target country's.
function guessCurrency(facts, amount, country) {
  const saved = factLine(facts, CURRENCY).toUpperCase();
  if (currencies.includes(saved)) return saved;
  const written = String(amount).toUpperCase(),
    code = currencies.find((c) => written.includes(c)) ?? (/\bTL\b/.test(written) ? 'TRY' : null);
  if (code) return code;
  const symbol = Object.keys(symbolCurrency).find((s) => written.includes(s));
  if (symbol) return symbolCurrency[symbol];
  let iso = String(country ?? '')
    .trim()
    .toUpperCase();
  if (iso.length > 2) {
    const names = new Intl.DisplayNames(['en'], {type: 'region'});
    iso = Object.keys(countryCurrency).find((c) => names.of(c)?.toUpperCase() === iso) ?? '';
  }
  return countryCurrency[iso] ?? '';
}
// Privacy consent on application forms: a line in the application rules the agent follows.
const CONSENT = 'Privacy consent';
const CONSENT_TEXT =
  'Accept the privacy policy and data processing consent a form requires to apply. Leave marketing, newsletter, job alert and talent pool opt-ins unticked.';
const languagesFrom = (experience) =>
  String(experience ?? '')
    .match(/languages?\s*[:：]\s*(.+?)(?=\.\s|[\n·;]|$)/i)?.[1]
    .trim() ?? '';
const readingStages = ['Opening your CV', 'Reading your experience', 'Filling in your profile'];
// Terminal choices, worded for people: continue first, refuse last.
const choiceTone = (label) =>
  /^(?:no|deny|cancel|exit)\b/i.test(label)
    ? 'stop'
    : /don.?t ask again|always|for this session|all /i.test(label)
      ? 'always'
      : /^(?:yes|allow|approve|proceed|trust|continue)\b/i.test(label)
        ? 'go'
        : 'other';
const toneRank = {go: 0, always: 1, other: 2, stop: 3};
const choiceLabel = (label, tone, trust) =>
  trust
    ? ({go: 'Allow', stop: 'Don’t allow'}[tone] ?? label)
    : ({go: 'Allow', always: 'Always allow', stop: 'Don’t allow'}[tone] ?? label);
const providerNames = {claude: 'Claude', codex: 'ChatGPT (Codex)', opencode: 'OpenCode'};
const installLinks = {
  claude: 'https://code.claude.com/docs/en/overview',
  codex: 'https://developers.openai.com/codex/cli',
  opencode: 'https://opencode.ai/docs/',
};
// Plain-language setup items; the checks themselves come from the app.
const friendlyChecks = {
  chrome: {
    title: 'Install Google Chrome',
    text: 'JobLoop opens job sites in Chrome. Install it, open it once, then press Check again.',
    link: ['Download Chrome', 'https://www.google.com/chrome/'],
  },
  'chrome-profile': {
    title: 'Choose a Chrome profile',
    text: 'Open Chrome once so it creates a profile. Sign in there to the job sites you use.',
  },
  'chrome-debug': {
    title: 'Let JobLoop use Chrome',
    text: 'In Chrome, open chrome://inspect/#remote-debugging and turn on remote debugging. Chrome asks once to allow JobLoop.',
  },
  jev: {
    title: 'Add your TypeSafe key',
    text: 'JobLoop uses TypeSafe to fill application forms. Paste your API key here; it is stored encrypted on this computer.',
    link: ['Get a TypeSafe key', 'https://typesafe.ai'],
  },
};

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
  if ((data.runs ?? []).some((r) => r.kind === 'interview')) return 'review';
  // No CV: the user fills in the details themselves.
  return localStorage.getItem(flagKey(data.automation?.id)) === 'manual' ? 'review' : 'start';
}

// A blank workspace, or one whose CV was uploaded but whose profile is not saved yet.
export function wantsOnboarding(data) {
  const a = data.automation,
    flag = localStorage.getItem(flagKey(a.id));
  return (
    Boolean(data.definition?.onboarding) &&
    flag !== 'skip' &&
    a.reviewedRevision == null &&
    (flag === 'cv' || flag === 'manual' || automationProgress(data).fresh)
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
  const brand = el('b', null, 'onboarding-brand');
  brand.innerHTML = markIcon(32);
  brand.append(BRAND);
  head.append(brand, steps);
  for (const label of ['Upload CV', 'Check details', 'Start']) steps.append(el('li', label));
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
    reviewDirty = false,
    missingFocus = null,
    terminal = null;

  const showError = (message = '') => {
    error.textContent = message;
    error.hidden = !message;
    // The message sits under the card; bring it into view so it is never missed.
    if (message) requestAnimationFrame(() => error.scrollIntoView({block: 'center'}));
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
    // The app behind the onboarding is out of reach for keyboard and screen readers.
    for (const node of document.querySelectorAll('#jl-root, body > main')) node.inert = true;
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
    for (const node of document.querySelectorAll('#jl-root, body > main')) node.inert = false;
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
      closeTerminal();
      step = next;
      card.replaceChildren(
        ...(step === 'start' ? startStep() : step === 'reading' ? readingStep() : reviewStep()),
      );
      if (step === 'reading') openTerminal(card.querySelector('.onboarding-terminal'));
    }
    update();
  }

  function startStep() {
    const intro = [
      el('h1', 'Let’s find your next job'),
      el(
        'p',
        'Upload your CV. JobLoop reads it, you check the details, and it starts finding jobs that fit you.',
        'onboarding-lead',
      ),
    ];
    const pick = button('', () => attempt(pickCv), 'onboarding-cv onboarding-drop');
    pick.dataset.action = 'pick-cv';
    pick.innerHTML =
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><g class="onboarding-drop-arrow"><path d="M12 18v-6M9 15l3-3 3 3"/></g></svg><b>Choose your CV</b><small>PDF, DOCX or TXT · it stays on this computer</small>';
    // The assistant: one pill per assistant; ones not installed explain themselves.
    const agents = el('div', null, 'onboarding-agents');
    agents.setAttribute('role', 'group');
    agents.setAttribute('aria-labelledby', 'onboarding-ai-title');
    const agentsTitle = el('span', 'Your AI assistant', 'onboarding-agents-title');
    agentsTitle.id = 'onboarding-ai-title';
    agents.append(
      agentsTitle,
      el('div', null, 'onboarding-ai-pills'),
      el('div', null, 'onboarding-ai-note'),
    );
    const notesBox = el('details', null, 'onboarding-notes-box'),
      notes = el('label', 'Anything your CV does not say? (optional)', 'onboarding-notes'),
      input = el('textarea');
    notesBox.append(el('summary', 'Add a note (optional)'), notes);
    input.name = 'notes';
    input.maxLength = 12000;
    input.placeholder =
      'Where do you want to work, which roles, remote or on-site, salary, start date, anything your CV does not say.';
    notes.append(input);
    const foot = el('div', null, 'onboarding-start-foot'),
      manualLink = button('No CV? Fill in your details yourself', () => attempt(manual), 'link'),
      go = button('Choose CV and continue', () => attempt(pickCv), 'primary');
    manualLink.dataset.action = 'manual';
    go.dataset.action = 'continue';
    foot.append(manualLink, go);
    return [...intro, pick, agents, notesBox, foot, el('div', null, 'onboarding-links')];
  }
  // While the AI reads the CV the user sees a calm progress screen. The agent's
  // terminal stays mounted off screen: its choice prompts are shown as cards
  // here and answered with keystrokes, so nobody has to use a terminal.
  function readingStep() {
    const visual = el('div', null, 'onboarding-reading-mark');
    visual.append(docScan(72));
    const stages = el('ol', null, 'onboarding-stages');
    for (const label of readingStages) stages.append(el('li', label));
    const meta = el('p', null, 'onboarding-reading-meta');
    meta.append(
      el('span', 'Usually about a minute'),
      el('span', '·'),
      el('span', '0:00', 'onboarding-elapsed'),
    );
    const ask = el('div', null, 'onboarding-ask');
    ask.hidden = true;
    ask.setAttribute('role', 'group');
    ask.setAttribute('aria-live', 'polite');
    const screen = el('div', null, 'worker-terminal onboarding-terminal'),
      live = el('div', null, 'onboarding-live');
    screen.setAttribute('aria-label', 'Setup agent terminal');
    live.append(screen);
    const links = el('div', null, 'onboarding-links');
    const details = button('Show technical details', () => toggleDetails(), 'link');
    details.dataset.action = 'details';
    details.hidden = true;
    const agentLink = button('Open the agent screen', () => chat(id), 'link');
    agentLink.dataset.agentScreen = '';
    links.append(details, agentLink);
    const hero = el('div', null, 'onboarding-reading');
    hero.append(visual, el('h1', 'Reading your CV'), stages, meta);
    return [hero, ask, live, links];
  }
  function toggleDetails(force) {
    const live = card.querySelector('.onboarding-live'),
      open = force ?? !live.classList.contains('open');
    live.classList.toggle('open', open);
    const link = card.querySelector('[data-action=details]');
    if (link) link.textContent = open ? 'Hide technical details' : 'Show technical details';
  }
  // A choice the agent's terminal is waiting on, rendered as an app card.
  function renderAsk(run) {
    const ask = card.querySelector('.onboarding-ask'),
      prompt = terminal?.choice,
      kind = terminal?.prompt,
      key = JSON.stringify([
        kind,
        prompt?.question,
        prompt?.options.map((o) => o.label),
        run?.state,
        run?.usageLimit,
      ]);
    if (ask.dataset.key === key) return;
    ask.dataset.key = key;
    ask.replaceChildren();
    const waiting = run?.state === 'AwaitingInput';
    ask.hidden = !(prompt || waiting || run?.usageLimit);
    card.querySelector('.onboarding-reading')?.classList.toggle('paused', !ask.hidden);
    if (ask.hidden) return;
    if (run?.usageLimit) {
      ask.append(
        el('b', 'Your AI assistant hit its usage limit'),
        el('p', 'Wait until it resets, or switch to another assistant, then press Refill from CV.'),
      );
      return;
    }
    if (prompt) {
      const trust = kind === 'trust';
      ask.append(
        el('b', trust ? 'One quick permission' : 'The AI asks before it continues'),
        el(
          'p',
          trust
            ? `${providerNames[data?.automation?.agentSettings?.provider ?? provider] ?? 'Your AI'} asks once whether it may work in JobLoop’s folder for this profile. That is where your CV is kept.`
            : prompt.question || 'It needs your approval for its next step.',
        ),
      );
      if (!trust && prompt.context)
        ask.append(el('code', prompt.context, 'onboarding-ask-context'));
      const row = el('div', null, 'onboarding-ask-actions');
      // Lead with the option that lets the setup continue.
      const order = prompt.options
        .map((option, index) => ({...option, index, tone: choiceTone(option.label)}))
        .sort((x, y) => toneRank[x.tone] - toneRank[y.tone]);
      for (const option of order) {
        const b = button(
          choiceLabel(option.label, option.tone, trust),
          () => answerChoice(option.index),
          option === order[0] ? 'primary' : 'quiet',
        );
        b.title = option.label;
        row.append(b);
      }
      ask.append(row);
      return;
    }
    // Free-text question with no menu.
    const form = el('form', null, 'onboarding-ask-reply'),
      input = el('input');
    input.name = 'reply';
    input.placeholder = 'Type your answer';
    input.autocomplete = 'off';
    const send = el('button', 'Send', 'primary');
    send.type = 'submit';
    form.onsubmit = (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendKeys(text + '\r');
    };
    form.append(input, send);
    ask.append(
      el('b', 'The AI needs a quick answer'),
      el(
        'p',
        'It stopped to ask you something. Answer here, or open the details to see the full question.',
      ),
      form,
    );
    card.querySelector('[data-action=details]').hidden = false;
  }
  const sendKeys = (text) =>
    api
      .input(id, text, CONVERSATION_WORKER, conversationSession()?.sessionId)
      .catch((failure) => showError(failure.message));
  function answerChoice(index) {
    const prompt = terminal?.choice;
    if (!prompt) return;
    const buttons = [...card.querySelectorAll('.onboarding-ask button')];
    for (const node of buttons) node.disabled = true;
    sendKeys(choiceKeys(prompt, index));
    // If the prompt is still there a moment later, let the user try again.
    setTimeout(() => buttons.forEach((node) => (node.disabled = false)), 2500);
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
    // Any menu question at the bottom of the screen also waits for the user.
    const menu = readChoicePrompt(screen),
      prompt = ['trust', 'permission'].includes(found?.kind)
        ? found.kind
        : menu
          ? 'permission'
          : null,
      choice = prompt ? menu : null,
      // The profile is being written once the agent calls its save tool.
      // A tool call line ("⏺ jobloop - save_automation_plan (MCP)"), not the
      // request text that names the tool.
      saving = t.saving || /⏺[^\n]*(?:save_automation_plan|reply_to_user)/.test(screen);
    const key = JSON.stringify([prompt, choice, saving]);
    if (key === t.key) return;
    t.key = key;
    t.prompt = prompt;
    t.choice = choice;
    t.saving = saving;
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
      el('h1', 'Check your details'),
      el('section', null, 'onboarding-echo'),
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
      const pills = card.querySelector('.onboarding-ai-pills'),
        note = card.querySelector('.onboarding-ai-note');
      pills.replaceChildren();
      note.replaceChildren();
      const entries = [...providers],
        usable = entries.filter(([, p]) => ['ready', 'warning'].includes(p.state));
      for (const [value, p] of entries) {
        const pill = button(providerNames[value] ?? p.label, null, 'onboarding-ai-pill');
        pill.dataset.state = p.state;
        const chosen = value === provider && p.state !== 'error';
        pill.setAttribute('aria-pressed', String(chosen));
        if (p.state === 'checking') {
          pill.disabled = true;
          pill.title = 'Checking…';
        } else if (p.state === 'error') {
          pill.title = 'Not installed on this computer';
          pill.onclick = () => {
            missingFocus = missingFocus === value ? null : value;
            update();
          };
        } else
          pill.onclick = () => {
            provider = value;
            missingFocus = null;
            update();
          };
        if (chosen) {
          const tick = el('span', null, 'onboarding-ai-tick');
          tick.setAttribute('aria-hidden', 'true');
          pill.prepend(tick);
        }
        pills.append(pill);
      }
      if (!providers.size) note.append(el('span', 'Looking for AI assistants on this computer…'));
      else if (missingFocus && providers.get(missingFocus)?.state === 'error') {
        note.append(
          el('span', `${providerNames[missingFocus]} isn’t installed on this computer.`),
          button('How to install', () => api.openLink(installLinks[missingFocus]), 'link'),
          button('Check again', () => checkProviders(), 'link'),
        );
      } else if (
        providers.size &&
        !usable.length &&
        ![...providers.values()].some((p) => p.state === 'checking')
      ) {
        note.dataset.tone = 'warn';
        note.append(
          el(
            'span',
            'JobLoop needs Claude Code or ChatGPT’s Codex on this computer. Install one, sign in once, then check again.',
          ),
          button('How to install Claude Code', () => api.openLink(installLinks.claude), 'link'),
          button('Check again', () => checkProviders(), 'link'),
        );
      } else if (provider && providers.get(provider)) {
        const p = providers.get(provider);
        note.append(
          el(
            'span',
            p.state === 'warning'
              ? p.detail || 'Sign-in may be needed.'
              : `${providerNames[provider]} reads your CV and applies for you, with your own account.`,
          ),
        );
      }
      if (!note.dataset.tone || usable.length) delete note.dataset.tone;
      const blocked = !provider || ['checking', 'error'].includes(providers.get(provider)?.state),
        pick = card.querySelector('[data-action=pick-cv]');
      pick.disabled = busy || blocked;
      for (const action of ['continue', 'manual']) {
        const node = card.querySelector(`[data-action=${action}]`);
        if (node) node.disabled = busy || blocked;
      }
      pick.querySelector('b').textContent = busy ? 'Adding your CV…' : 'Choose your CV';
    } else if (step === 'reading') {
      renderAsk(interviewRun(data));
      tick();
    } else if (step === 'review') updateReview();
  }
  function tick() {
    if (step !== 'reading' || !data) return;
    // Run times are epoch milliseconds.
    const run = interviewRun(data),
      since = new Date(run?.lastMessageAt ?? run?.startedAt ?? NaN).getTime(),
      seconds = Number.isFinite(since) ? Math.max(0, Math.round((Date.now() - since) / 1000)) : 0;
    const label = card.querySelector('.onboarding-elapsed');
    if (label)
      label.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    // Stages: the CV is open once the run started; the profile is being
    // filled once the agent saves it (or, failing a visible signal, after a while).
    const stage = terminal?.saving || seconds > 50 ? 2 : seconds > 4 ? 1 : 0;
    [...card.querySelectorAll('.onboarding-stages li')].forEach((item, index) => {
      item.dataset.state = index < stage ? 'done' : index === stage ? 'current' : 'pending';
    });
    // A slow run gets a way to see what is going on.
    const details = card.querySelector('[data-action=details]');
    if (details && seconds > 150) details.hidden = false;
  }

  // "I read you": three facts from the CV come back, each ticked and typed in.
  // The animation plays once per profile in a session; afterwards it is static.
  function renderEcho(box, a) {
    const facts = cvFacts(a.criteria?.experience);
    box.hidden = !facts.length;
    const key = JSON.stringify(facts);
    if (!facts.length) return false;
    if (box.dataset.key === key) return true;
    box.dataset.key = key;
    const seen = sessionStorage.getItem('jl-echo:' + a.id) === key;
    sessionStorage.setItem('jl-echo:' + a.id, key);
    const list = el('ul');
    box.replaceChildren(el('h2', 'Here’s what I took from your CV'), list);
    facts.forEach((fact, i) => {
      const item = el('li'),
        check = checkmark(22, {play: false}),
        text = el('span'),
        lead = el('b'),
        rest = el('span', fact.rest, 'onboarding-echo-rest');
      text.append(lead, ' ', rest);
      item.append(check, text);
      list.append(item);
      const show = () => {
        check.play();
        typewrite(lead, fact.lead, {speed: seen ? 0 : 24, done: () => rest.classList.add('in')});
      };
      if (seen) {
        lead.textContent = fact.lead;
        rest.classList.add('in');
        check.play();
      } else setTimeout(show, 250 + i * 950);
    });
    return true;
  }
  function updateReview() {
    const a = data.automation,
      reply = [...data.messages]
        .reverse()
        .find((m) => m.role === 'assistant' && m.conversation && m.runId),
      latest = data.runs.find((r) => r.kind === 'interview'),
      failed = !interviewRun(data) && ['failed', 'timeout', 'interrupted'].includes(latest?.status);
    const manualMode = !latest && localStorage.getItem(flagKey(a.id)) === 'manual';
    card.querySelector('.onboarding-reply').textContent = manualMode
      ? 'Tell JobLoop what you’re looking for. You can add your CV later from Profile & CV.'
      : (reply?.text ?? 'Check the details the agent filled in and complete anything missing.');
    // With the CV echo shown, the AI's own (often technical) note gives way to one plain line.
    if (renderEcho(card.querySelector('.onboarding-echo'), a) && !manualMode)
      card.querySelector('.onboarding-reply').textContent =
        'Check the details below and add anything your CV doesn’t say, like salary or notice period.';
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
      text(
        'goal',
        'The job you are looking for',
        a.goal || sessionStorage.getItem('jl-manual-notes:' + a.id) || '',
        {
          placeholder: 'E.g. senior backend engineering in Berlin or remote',
          required: true,
        },
      ),
    );
    // The main fields stay open; the long free-text ones fold into "More details".
    const more = el('details', null, 'onboarding-more'),
      moreBody = el('div', null, 'onboarding-more-body');
    more.append(el('summary', 'More details: experience, requirements, form answers'), moreBody);
    for (const key of reviewFields) {
      const field = fields.get(key);
      if (!field) continue;
      (folded.has(key) ? moreBody : profile).append(
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
    if (experience)
      moreBody.prepend(
        text('experience', experience.label, a.criteria.experience, {
          placeholder: experience.question,
        }),
      );
    profile.append(more);
    // Answer once: the questions application forms ask most, saved for every application.
    const facts = a.criteria.application_facts ?? '',
      once = el('fieldset', null, 'onboarding-section onboarding-once');
    once.append(
      el('legend', 'Answer once, never again'),
      el(
        'p',
        'Employers ask these on almost every form. Answer them now and JobLoop fills them in for you.',
        'onboarding-section-lead',
      ),
    );
    const grid = el('div', null, 'onboarding-once-grid');
    for (const q of quickQuestions) {
      const current =
        factLine(facts, q.label) ||
        (q.id === 'languages' ? languagesFrom(a.criteria.experience) : '');
      if (q.choices) {
        const group = el('div', null, 'onboarding-once-choice'),
          pills = el('div', null, 'onboarding-pills');
        group.append(el('span', q.title, 'onboarding-once-title'), pills);
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', q.title);
        for (const [label, value] of q.choices) {
          const pill = el('label', null, 'onboarding-pill'),
            input = el('input');
          input.type = 'radio';
          input.name = 'once_' + q.id;
          input.value = value;
          input.checked = current.toLowerCase() === value.toLowerCase();
          pill.append(input, el('span', label));
          pills.append(pill);
        }
        grid.append(group);
      } else {
        const field = el('label', q.title),
          input = el('input');
        input.name = 'once_' + q.id;
        input.value = current;
        input.placeholder = q.placeholder;
        input.maxLength = 300;
        if (q.currency) {
          const row = el('span', null, 'onboarding-amount'),
            currency = el('select');
          currency.name = 'salary_currency';
          currency.setAttribute('aria-label', 'Currency');
          currency.append(new Option('Currency', ''));
          for (const code of currencies) currency.append(new Option(code, code));
          currency.value = guessCurrency(facts, current, a.criteria.country);
          row.append(input, currency);
          field.append(row);
        } else field.append(input);
        grid.append(field);
      }
    }
    once.append(grid);
    const never = el('label', 'Never apply to', 'onboarding-never'),
      neverInput = el('input');
    neverInput.name = 'never';
    neverInput.value = factLine(a.criteria.constraints, NEVER);
    neverInput.placeholder =
      'Companies or words, comma separated · e.g. Acme, gambling, internship';
    neverInput.maxLength = 1000;
    never.append(
      neverInput,
      el('small', 'JobLoop treats these as a hard no and never applies to them.'),
    );
    once.append(never);
    const mode = el('fieldset', null, 'onboarding-section'),
      choices = el('div', null, 'authorization');
    mode.append(el('legend', 'How far should JobLoop go?'), choices);
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
      value: a.criteria.score_threshold ?? '',
    });
    score.append(scoreInput);
    choices.append(score);
    const syncScore = () => {
      const auto = form.elements.mode.value === 'auto';
      scoreInput.required = auto;
      score.hidden = !auto;
    };
    choices.addEventListener('change', syncScore);
    const consent = el('label', null, 'onboarding-consent'),
      consentInput = el('input'),
      consentCopy = el('span');
    consentInput.type = 'checkbox';
    consentInput.name = 'consent';
    consentInput.checked = /^accept/i.test(factLine(a.criteria.application_policy, CONSENT));
    consentCopy.append(
      el('b', 'Accept privacy consent on application forms for me'),
      el(
        'small',
        'Ticks the privacy policy and data processing boxes a form needs before you can apply. Marketing, newsletters and talent pools stay unticked.',
      ),
    );
    consent.append(consentInput, consentCopy);
    mode.append(consent);
    // Most people keep the recommended sources, so the list stays folded.
    const sources = el('details', null, 'onboarding-section onboarding-sources'),
      sourceSummary = el('summary');
    sourceSummary.append(
      el('span', 'Where to search', 'onboarding-sources-title'),
      el('span', null, 'onboarding-sources-count'),
      el('span', 'Edit', 'onboarding-sources-edit'),
    );
    sources.append(sourceSummary, el('div', null, 'onboarding-checks'));
    sources.addEventListener('toggle', () => {
      sources.querySelector('.onboarding-sources-edit').textContent = sources.open
        ? 'Done'
        : 'Edit';
    });
    sources.addEventListener('change', () => countSources(form));
    const checks = el('section', null, 'onboarding-readiness');
    checks.setAttribute('aria-label', 'Before you start');
    const foot = el('div', null, 'onboarding-foot'),
      noCv = !data.runs.some((r) => r.kind === 'interview'),
      again = noCv
        ? button('Add my CV instead', () => attempt(pickCv))
        : button('Refill from CV', () => attempt(readAgain)),
      submit = el('button', 'Start finding jobs', 'primary');
    again.dataset.action = 'read-again';
    submit.type = 'submit';
    foot.append(again, submit);
    // Setup items that block the start come before the long source list.
    form.append(profile, once, mode, checks, sources, foot);
    syncScore();
    renderSources(form);
    renderReadiness(form);
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
          row(
            choice.url,
            choice.name,
            'Optional · ' +
              (choice.account ? 'needs your API key under Site accounts' : choice.label),
            false,
          );
        else if (choice.remote) row(choice.url, choice.name, 'Optional · ' + choice.label, false);
    countSources(form);
  }
  function countSources(form) {
    const all = [...form.querySelectorAll('input[name=source]')],
      on = all.filter((i) => i.checked).length,
      label = form.querySelector('.onboarding-sources-count');
    if (label)
      label.textContent =
        on === all.length ? `All ${all.length} job sites` : `${on} of ${all.length} job sites`;
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
    const blocking = open.some((c) => c.state === 'error');
    root.dataset.blocking = String(blocking);
    root.append(
      el('h2', blocking ? 'One more thing before you start' : 'Before you start'),
      el(
        'p',
        blocking
          ? 'JobLoop needs the items marked Required to find and apply to jobs.'
          : 'Recommended, so JobLoop can apply on job sites for you.',
        'onboarding-check-lead',
      ),
    );
    for (const check of open) {
      const item = el('div', null, 'onboarding-check'),
        copy = friendlyChecks[check.id],
        head = el('div', null, 'onboarding-check-head');
      item.dataset.state = check.state;
      head.append(
        el('b', copy?.title ?? check.label),
        el('span', check.state === 'error' ? 'Required' : 'Recommended', 'onboarding-check-tag'),
      );
      item.append(head, el('span', copy?.text ?? check.detail));
      if (copy?.link) item.append(button(copy.link[0], () => api.openLink(copy.link[1]), 'link'));
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
          // Without a key the worker agent can make the listing decisions.
          button(
            'Let the agent decide instead',
            () =>
              attempt(async () => {
                const agentSettings = {...data.automation.agentSettings, decisions: 'agent'};
                await api.automationSave(id, {agentSettings});
                data.automation.agentSettings = agentSettings;
                readiness = null;
                checkReadiness(form);
              }),
            'link',
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
      readiness = await api.readiness({
        provider: data.automation.agentSettings.provider,
        decisions: data.automation.agentSettings.decisions ?? 'jev',
      });
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
      const settings = withAgentDefaults({provider});
      await api.automationSave(id, {agentSettings: settings});
      await api.setupAgentSettings(id, withSetupAgentDefaults({provider}));
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
  // No CV: go straight to Check details and fill it in by hand.
  async function manual() {
    const notes = (card.querySelector('[name=notes]')?.value ?? '').trim(),
      owner = await prepare();
    localStorage.setItem(flagKey(owner), 'manual');
    if (notes) sessionStorage.setItem('jl-manual-notes:' + owner, notes);
    await load();
  }

  // Before the CV only an untouched workspace is removed; after it, leaving
  // discards the unfinished profile together with its setup agent.
  async function leaveOnboarding() {
    const owner = id,
      started = step !== 'start',
      empty = Boolean(data && automationProgress(data).fresh && !data.documents?.length);
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
    const jev = await api.jevSettingsStatus();
    if (!jev.configured) {
      const key = form.querySelector('[name=jevKey]');
      key?.scrollIntoView({block: 'center'});
      key?.focus();
      throw Error(jev.error ?? 'Add your TypeSafe key above to start the search.');
    }
    const chosen = new Set(
      [...form.querySelectorAll('input[name=source]')].filter((i) => i.checked).map((i) => i.value),
    );
    if (!chosen.size) {
      form.querySelector('.onboarding-sources').open = true;
      throw Error('Choose at least one job site to search.');
    }
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
    // Quick answers win over the same lines in the free text.
    for (const q of quickQuestions) {
      const input = f['once_' + q.id],
        value = (input?.value ?? '').trim();
      // An unanswered choice keeps whatever the CV reading wrote there.
      if (q.choices && !value) continue;
      criteria.application_facts = setFactLine(criteria.application_facts, q.label, value);
    }
    if (f.salary_currency)
      criteria.application_facts = setFactLine(
        criteria.application_facts,
        CURRENCY,
        f.once_salary?.value.trim() ? f.salary_currency.value : '',
      );
    if (f.consent)
      criteria.application_policy = setFactLine(
        criteria.application_policy,
        CONSENT,
        f.consent.checked ? CONSENT_TEXT : '',
      );
    criteria.constraints = setFactLine(criteria.constraints, NEVER, f.never.value.trim());
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
