import './telegram.css';
const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

export function telegramPanel(api, root, {notice}) {
  let candidate = null,
    status = null,
    pair = null,
    busy = false,
    version = 0,
    autoScoreDirty = false;
  root.innerHTML = `<div class="telegram-card"><div class="telegram-heading"><div><h4>Telegram bot</h4><p data-bot-status role="status">Loading…</p></div><span class="telegram-badge"></span></div>
 <form class="telegram-token"><label>Bot token<input name="token" type="password" autocomplete="new-password" placeholder="Token from BotFather" aria-label="Telegram bot token"></label><button class="primary" type="submit">Save and turn on</button><button type="button" class="quiet" data-toggle hidden>Turn off</button></form>
 <p class="telegram-hint">In Telegram, use the /newbot command with <button class="telegram-link" type="button" data-botfather>@BotFather</button>. The token is stored on this computer, encrypted with the system keychain. The bot setting belongs only to the selected candidate. If you save a different bot, connect this candidate to the new bot again.</p><p class="telegram-error" data-error role="status" hidden></p>
 <div class="telegram-candidate"><h4 data-candidate-name>Candidate connection</h4><p data-candidate-state></p>
 <form class="telegram-batch" hidden><div class="telegram-batch-controls">
 <label>Minimum score<input name="minScore" type="number" min="0" max="100" step="1" placeholder="No limit" value="70" aria-label="Minimum score" aria-describedby="telegram-score-help"></label>
 <label>Sending scope<select name="scope" aria-label="Sending scope"><option value="unsent">Only unsent listings</option><option value="resend">Resend all</option></select></label>
 <button class="primary" type="submit">Send listings</button></div>
 <p id="telegram-score-help" class="telegram-hint">Only listings above the score you enter are sent: 70 → 71–100. Leave it empty to apply no score filter.</p>
 <p class="telegram-hint" data-batch-scope></p></form>
 <div data-candidate-actions></div><div data-pair hidden></div><div class="telegram-preferences" hidden><h4>Notification preferences</h4><p>Your choices are saved automatically for this candidate.</p>
 <label><span><b>Send new listings automatically</b><small data-auto-jobs-help>New listings are sent according to the score filter below.</small></span><input class="switch" type="checkbox" name="newJobs" aria-label="Send new listings automatically"></label>
 <label><span><b>Minimum score for automatic listings</b><small>Only listings above this score are sent. Unscored listings and listings below the limit wait. Empty: no score filter.</small></span><input class="telegram-auto-score" name="newJobsMinScore" type="number" min="0" max="100" step="1" placeholder="No limit" aria-label="Minimum score for automatic listings"></label>
 <label><span><b>Notify about submitted applications</b><small>Get a separate notification when an application is submitted.</small></span><input class="switch" type="checkbox" name="notifications" aria-label="Notify about submitted applications"></label>
 <label><span><b>Send pending questions</b><small>Answer the agent’s questions from Telegram and continue the application.</small></span><input class="switch" type="checkbox" name="questions" aria-label="Send pending questions and allow answering them from the bot"></label></div><p class="telegram-hint" data-deliveries></p></div>
 <p class="telegram-foot">JobLoop must be open and online for messaging to work. The status and score of sent cards are updated in the same message. Queued and active applications are pinned; the pin is removed once they finish.</p></div>`;
  const $ = (selector) => root.querySelector(selector),
    form = $('.telegram-token'),
    token = form.elements.token,
    batch = $('.telegram-batch'),
    autoScore = $('[name=newJobsMinScore]');
  const button = (label, fn, cls = 'quiet') => {
    const b = node('button', cls, label);
    b.type = 'button';
    b.disabled = busy;
    b.onclick = () => act(fn);
    return b;
  };
  function render() {
    if (!status) {
      $('[data-bot-status]').textContent = candidate
        ? 'Loading…'
        : 'Select a candidate to connect a bot.';
      $('.telegram-badge').textContent = '—';
      $('.telegram-badge').dataset.on = 'false';
      $('[data-toggle]').hidden = true;
      $('[data-error]').hidden = true;
      form.querySelector('[type=submit]').textContent = 'Save and turn on';
      token.placeholder = 'Token from BotFather';
      batch.hidden = true;
      for (const control of form.elements) control.disabled = true;
      return;
    }
    $('[data-bot-status]').textContent = status.configured
      ? `@${status.bot.username} · ${status.running ? 'Connected' : 'Off'}`
      : 'Connect a bot first.';
    $('.telegram-badge').textContent = status.error
      ? 'Connection problem'
      : status.running
        ? 'On'
        : 'Off';
    $('.telegram-badge').dataset.on = String(status.running && !status.error);
    $('[data-error]').hidden = !status.error;
    $('[data-error]').textContent = status.error ?? '';
    $('[data-toggle]').hidden = !status.configured;
    $('[data-toggle]').textContent = status.enabled ? 'Turn off' : 'Turn on';
    token.placeholder = status.configured
      ? 'Type here to enter a new token'
      : 'Token from BotFather';
    form.querySelector('[type=submit]').textContent = status.configured
      ? 'Update token'
      : 'Save and turn on';
    for (const control of form.elements) control.disabled = busy || !status.candidate;
    const c = status.candidate,
      actions = $('[data-candidate-actions]');
    actions.replaceChildren();
    $('[data-candidate-name]').textContent = c
      ? `${c.candidateName} · Telegram`
      : 'Candidate connection';
    $('[data-candidate-state]').textContent = !c
      ? 'Select a saved candidate on the left to connect.'
      : c.connected
        ? `${c.name}’s account is connected.`
        : 'This candidate is not connected to Telegram yet.';
    batch.hidden = !c?.connected;
    for (const control of batch.elements)
      control.disabled = busy || !c?.connected || !status.enabled || !status.configured;
    renderBatchScope();
    if (c?.connected) {
      pair = null;
      actions.append(
        button('Remove connection', () => api.telegramUnlink(c.candidateId), 'quiet danger'),
      );
    } else if (c) {
      const create = button(
        pair ? 'Create a new link' : 'Connect candidate to Telegram',
        async () => {
          const owner = candidate,
            next = await api.telegramPair(owner);
          if (owner === candidate) pair = next;
        },
      );
      create.disabled = busy || !status.enabled || !status.configured;
      actions.append(create);
    }
    const pairBox = $('[data-pair]');
    pairBox.replaceChildren();
    pairBox.hidden = !pair || !c || c.connected;
    if (!pairBox.hidden) {
      const expired = pair.expires <= Date.now();
      pairBox.append(
        node(
          'p',
          'telegram-hint',
          expired
            ? 'The link has expired. Create a new link.'
            : 'Send this link to the candidate. The candidate is connected after pressing Start in Telegram. The link is valid for 10 minutes.',
        ),
      );
      const input = node('input');
      input.readOnly = true;
      input.value = pair.url;
      input.setAttribute('aria-label', 'Candidate Telegram link');
      pairBox.append(input);
      const copy = button('Copy link', async () => {
        await navigator.clipboard.writeText(pair.url);
        notice('Telegram link copied.');
      });
      copy.disabled = expired || busy;
      const open = button('Open in Telegram', () => api.openLink(pair.url));
      open.disabled = expired || busy;
      pairBox.append(copy, open);
    }
    $('.telegram-preferences').hidden = !c?.connected;
    for (const key of ['newJobs', 'notifications', 'questions']) {
      const input = $(`[name=${key}]`);
      input.checked = c?.[key] ?? true;
      input.disabled = busy;
    }
    if (!autoScoreDirty) autoScore.value = c?.newJobsMinScore ?? '';
    autoScore.disabled = busy;
    $('[data-auto-jobs-help]').textContent =
      c?.newJobsMinScore == null
        ? 'New listings are sent regardless of their score.'
        : `Only new listings scoring above ${c.newJobsMinScore} are sent automatically (${c.newJobsMinScore} excluded).`;
    $('[data-deliveries]').textContent = c?.connected
      ? `${c.pending} messages / updates queued${c.waitingScore ? ` · ${c.waitingScore} listings waiting to pass the score limit` : ''}${c.failed ? ` · ${c.failed} operations could not be completed` : ''}${c.lastError ? ' · ' + c.lastError : ''}`
      : '';
    if (c?.connected && (c.failed || c.lastError))
      actions.append(button('Retry sending', () => api.telegramRetry(candidate)));
  }
  async function load() {
    const request = ++version,
      owner = candidate;
    try {
      const next = await api.telegramStatus(owner);
      if (request !== version || owner !== candidate) return;
      status = next;
      render();
    } catch (error) {
      if (request === version) notice(error.message);
    }
  }
  async function act(fn) {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
      await load();
    } catch (error) {
      notice(error.message);
    } finally {
      busy = false;
      render();
    }
  }
  function renderBatchScope() {
    const resend = batch.elements.scope.value === 'resend';
    batch.querySelector('[type=submit]').textContent = resend ? 'Resend listings' : 'Send listings';
    $('[data-batch-scope]').textContent = resend
      ? 'All listings matching the score filter are sent again, including deleted cards and completed applications. Each listing gets a new message.'
      : 'Listings without a completed application that were not sent to this bot before are sent. Deleted cards are not sent again.';
  }
  batch.elements.scope.onchange = renderBatchScope;
  batch.onsubmit = (event) => {
    event.preventDefault();
    if (!batch.reportValidity()) return;
    const owner = candidate,
      input = {
        minScore:
          batch.elements.minScore.value === '' ? null : batch.elements.minScore.valueAsNumber,
        resend: batch.elements.scope.value === 'resend',
      };
    act(async () => {
      const result = await api.telegramSendUnsentJobs(owner, input);
      if (candidate === owner)
        notice(
          `${result.queued} listings queued for Telegram.${result.alreadyQueued ? ` ${result.alreadyQueued} listings already queued.` : ''}${result.filtered ? ` ${result.filtered} listings do not match the score filter.` : ''}${result.queued || result.alreadyQueued ? ' Listings will be sent one by one.' : ' No listings to send with this selection.'}`,
        );
    });
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const owner = candidate,
      input = {token: token.value, enabled: true};
    act(async () => {
      await api.telegramConfigure(owner, input);
      if (candidate === owner) {
        token.value = '';
        notice('This candidate’s Telegram bot was saved.');
      }
    });
  };
  $('[data-toggle]').onclick = () => {
    const owner = candidate,
      input = {enabled: !status.enabled};
    act(() => api.telegramConfigure(owner, input));
  };
  $('[data-botfather]').onclick = () =>
    api.openLink('https://t.me/BotFather').catch((error) => notice(error.message));
  function savePreferences() {
    if (!autoScore.reportValidity()) {
      render();
      return;
    }
    const owner = candidate,
      input = {
        newJobs: $('[name=newJobs]').checked,
        newJobsMinScore: autoScore.value === '' ? null : autoScore.valueAsNumber,
        notifications: $('[name=notifications]').checked,
        questions: $('[name=questions]').checked,
      };
    act(async () => {
      await api.telegramPreferences(owner, input);
      if (candidate === owner) autoScoreDirty = false;
    });
  }
  autoScore.oninput = () => {
    autoScoreDirty = true;
  };
  autoScore.onchange = savePreferences;
  for (const key of ['newJobs', 'notifications', 'questions'])
    $(`[name=${key}]`).onchange = savePreferences;
  setInterval(() => {
    if (!root.closest('[hidden]') && !busy) load();
  }, 5000);
  render();
  return {
    select(id) {
      if (candidate !== id) {
        candidate = id;
        pair = null;
        status = null;
        token.value = '';
        autoScoreDirty = false;
        autoScore.value = '';
        batch.reset();
        version++;
        $('[data-pair]').hidden = true;
        $('.telegram-preferences').hidden = true;
        $('[data-candidate-name]').textContent = 'Candidate connection';
        $('[data-candidate-state]').textContent = 'Loading…';
        $('[data-deliveries]').textContent = '';
        $('[data-candidate-actions]').replaceChildren();
        render();
      }
      if (!root.closest('[hidden]')) load();
    },
    load,
  };
}
