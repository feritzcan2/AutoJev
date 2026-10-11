import {scanPageLabel} from '../app/sources/scan-page.mjs';
import {currentWork} from '../app/automation/current-work.mjs';
import {recipeSummary, recipePageCap, RECIPE_PAGINATION_KINDS} from '../app/sources/recipe.mjs';
import {
  searchFilterValues,
  withSearchFilters,
  searchFilterLabels,
} from '../app/site-extensions/search.mjs';
import {workspaceSourceTabs} from './workspace-tabs.js';

const modes = {
  observe: 'Only find',
  prepare: 'Find, apply when I say (older setting)',
  auto: 'Find and apply',
};
const paginationLabels = {
  auto: 'Detect automatically',
  url_param: 'Page parameter (page=2)',
  next_link: 'Next link',
  next_click: 'Next button',
  load_more: 'Load more',
  infinite_scroll: 'Infinite scroll',
  none: 'Single page',
};
const methodLabels = {
  none: 'None yet · learned in the trial round',
  url_template: 'URL template',
  search_form: 'Search form',
  discovery: 'Discovery · the agent searches itself every round',
};
const runOutcomes = {
  completed: 'Succeeded',
  failed: 'Failed',
  blocked: 'Blocked',
  timeout: 'Timed out',
  interrupted: 'Stopped',
  partial: 'Partially completed',
};
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
const time = (at) =>
  at
    ? new Date(at).toLocaleString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
function timeUntil(at) {
  const remaining = at - Date.now();
  if (remaining <= 0) return 'due now';
  if (remaining < 60000) return 'within 1 min';
  const minutes = Math.ceil(remaining / 60000),
    parts = [
      [Math.floor(minutes / 1440), 'd'],
      [Math.floor(minutes / 60) % 24, 'h'],
      [minutes % 60, 'min'],
    ];
  return (
    'in ' +
    parts
      .filter(([value]) => value)
      .slice(0, 2)
      .map(([value, unit]) => `${value} ${unit}`)
      .join(' ')
  );
}
const updateNextRun = (node) => {
  node.textContent =
    node.dataset.sourceNextLabel +
    ' ' +
    timeUntil(Number(node.dataset.sourceNextAt)) +
    (node.dataset.sourceNextSuffix ?? '');
};

// One row per source: who it is, what it is doing now, and the recipe that
// lets the next scan skip discovery. Everything else opens on demand.
export function automationSourcesPanel(host, api, {refresh, notice, ask}) {
  let data,
    owner,
    editing = null,
    memory = null,
    adding = false,
    saving = false,
    bulkSaving = false;
  host.innerHTML =
    '<div class="sources-head"><div><h2>Sources</h2><p></p></div><div class="sources-head-actions"></div></div><div data-add></div><ul class="source-list"></ul>';
  const head = host.querySelector('.sources-head'),
    headActions = head.querySelector('.sources-head-actions'),
    list = host.querySelector('.source-list'),
    addHost = host.querySelector('[data-add]');
  const rows = new Map(),
    otherHost = el('li', null, 'source-tabs-other'),
    empty = el('li', null, 'source-empty');
  empty.append(
    el('strong', 'No sources yet'),
    document.createTextNode(
      'Add a job site or ask the agent to find one. In the first round the agent works out the site once and saves its search recipe.',
    ),
  );
  list.append(otherHost);
  const countdown = setInterval(() => {
    if (!host.isConnected) {
      clearInterval(countdown);
      return;
    }
    if (host.getClientRects().length)
      for (const node of host.querySelectorAll('[data-source-next-at]')) updateNextRun(node);
  }, 30000);
  const tabsControl = workspaceSourceTabs(api, {notice});
  const action = (fn) => async (event) => {
    event?.preventDefault();
    if (saving) return;
    saving = true;
    notice('');
    try {
      await fn();
    } catch (error) {
      notice(error.message);
    } finally {
      saving = false;
    }
  };
  const button = (label, fn, cls = 'quiet') => {
    const b = el('button', label, cls);
    b.type = 'button';
    b.onclick = action(fn);
    return b;
  };
  const busySource = (url) =>
    (data.activeRuns ?? []).some(
      (run) =>
        run.kind !== 'interview' &&
        (run.sourceUrl
          ? run.sourceUrl === url
          : (run.sources ?? data.automation.sources).includes(url)),
    );

  // Header actions: add a source or ask the agent to find one.
  const add = button(
    '＋ Add source',
    () => {
      adding = !adding;
      render();
    },
    'primary',
  );
  headActions.append(add);
  if (ask) {
    const discover = button('Find with the agent', ask);
    discover.dataset.sourceDiscover = '';
    headActions.append(discover);
  }

  // Bulk settings fold away; a single form applies mode and interval to every source.
  const bulk = el('details', null, 'source-bulk');
  bulk.innerHTML = '<summary>Apply to all sources</summary>';
  const bulkForm = el('form', null, 'source-bulk-form');
  bulkForm.innerHTML =
    '<label>Action mode<select name="mode"><option value="">Do not change</option></select></label><label for="automation-sources-interval">Scan interval (min)<input id="automation-sources-interval" name="intervalMinutes" type="number" min="1" max="10080" step="1" placeholder="Do not change"></label><button type="submit" class="quiet">Apply to all</button><small role="status"></small>';
  for (const [mode, label] of Object.entries(modes))
    bulkForm.elements.mode.append(new Option(label, mode));
  bulk.append(bulkForm);
  host.append(bulk);
  bulkForm.onsubmit = action(async () => {
    if (!owner || !data?.sources?.length || !bulkForm.reportValidity()) return;
    const scope = owner,
      mode = bulkForm.elements.mode.value,
      interval = bulkForm.elements.intervalMinutes.value;
    if (!mode && !interval) {
      notice('Choose a setting to change.');
      return;
    }
    bulkSaving = true;
    render();
    try {
      if (mode) await api.automationSourceModes(scope, mode);
      if (interval) await api.automationSourcesInterval(scope, Number(interval));
      if (owner === scope && host.isConnected) {
        bulkForm.reset();
        await refresh();
        if (owner === scope && host.isConnected) notice('Setting applied to all sources.');
      }
    } finally {
      bulkSaving = false;
      render();
    }
  });

  const proposal = el('section', null, 'source-proposal');
  proposal.setAttribute('aria-label', 'Agent’s source suggestions');
  proposal.hidden = true;
  head.after(proposal);
  function renderProposal() {
    const draft = data.automation.sourceDraft;
    proposal.hidden = !draft;
    proposal.replaceChildren();
    if (!draft) return;
    const scope = owner,
      current = data.automation.sources,
      added = draft.sources.filter((url) => !current.includes(url)),
      removed = current.filter((url) => !draft.sources.includes(url)),
      searches = Object.entries(draft.searches ?? {});
    proposal.append(
      el('h3', 'Agent’s source suggestions'),
      el('p', 'Review and apply the changes. The first round of a new source is a trial.'),
    );
    const changes = el('ul');
    for (const [label, urls] of [
      ['To add', added],
      ['To remove', removed],
    ])
      for (const url of urls) {
        const item = el('li');
        item.append(el('b', label + ': '), el('span', url));
        changes.append(item);
      }
    for (const [url, choice] of searches) {
      const item = el('li');
      item.append(
        el('b', 'Search: '),
        el('span', url),
        el(
          'small',
          [
            ...(choice.terms ? ['Terms: ' + choice.terms.join(', ')] : []),
            ...choice.filters.map((f) => f.label),
          ].join(' · '),
        ),
      );
      changes.append(item);
    }
    proposal.append(changes);
    const actions = el('div', null, 'actions'),
      apply = button(
        'Apply suggestions',
        async () => {
          await api.automationSourceDraft(scope, draft.id, true);
          await refresh();
          notice('Source suggestions applied.');
        },
        'primary',
      );
    const busy = [...removed, ...searches.map(([url]) => url)].some(busySource);
    apply.disabled = busy || bulkSaving;
    const discard = button('Discard suggestions', async () => {
      await api.automationSourceDraft(scope, draft.id, false);
      await refresh();
      notice('Source suggestions discarded.');
    });
    discard.disabled = bulkSaving;
    actions.append(apply, discard);
    proposal.append(actions);
    if (busy)
      proposal.append(
        el('small', 'To apply, stop the running tasks of the sources to be removed or changed.'),
      );
  }

  function sourceRow(url) {
    const view = {
      row: el('li', null, 'source-row'),
      toggle: el('input', null, 'switch'),
      main: el('div', null, 'source-main'),
      actions: el('div', null, 'source-actions'),
      tabHost: el('div', null, 'source-tabs-control'),
      run: button('', () => {}),
      restart: button('Start over', () => {}, 'quiet source-restart'),
      edit: button('', () => {}, 'quiet source-edit'),
      memoryButton: button('', () => {}, 'quiet source-memory-toggle'),
      pending: null,
    };
    view.toggle.type = 'checkbox';
    view.row.dataset.sourceId = url;
    view.actions.append(view.run, view.restart, view.edit, view.memoryButton, view.tabHost);
    view.row.append(view.toggle, view.main, view.actions);
    rows.set(url, view);
    return view;
  }
  async function scanAction(view, scope, url, stop, fresh = false) {
    if (view.pending) return;
    const current = () => owner === scope && rows.get(url) === view && host.isConnected;
    view.pending = stop ? 'stop' : 'start';
    notice('');
    render();
    try {
      await (stop
        ? api.automationSourceStop(scope, url)
        : api.automationSourceRun(scope, url, {fresh}));
      if (current()) {
        await refresh();
        if (current())
          notice(
            stop
              ? 'Scan stopped. Saved progress was kept.'
              : fresh
                ? 'The scan will start from the first page. Saved listings are not read again.'
                : 'Scan request received. It starts when the source is ready.',
          );
      }
    } catch (error) {
      if (current()) notice(error.message);
    } finally {
      view.pending = null;
      if (current()) render();
    }
  }

  // Status: one bold state, one supporting line. The recipe chip stands alone.
  function statusLine(source) {
    const status = el('div', null, 'source-status');
    const state = source.blocker?.stop?.retryExhausted
      ? 'Access problem persists'
      : source.siteWait?.exhausted
        ? 'Automatic retries stopped'
        : source.siteWait
          ? 'Access wait · continues automatically'
          : source.scanning
            ? source.trialRunning
              ? 'Trial in progress'
              : source.scanIssue
                ? 'Page could not load'
                : 'Scanning'
            : source.recovery && data.automation.status === 'enabled'
              ? 'Waiting to continue automatically'
              : source.blocked
                ? source.lastStatus === 'failed' || source.blocker?.stop?.kind === 'technical'
                  ? 'Scan could not finish'
                  : 'Source blocked'
                : source.lastStatus === 'partial'
                  ? `Partial scan · ${source.scan?.pendingUrls.length ?? 0} address(es) left`
                  : (source.lastRun?.finishedAt ?? source.lastRunAt)
                    ? `${source.resultCount ?? source.lastFound ?? 0} record(s) in total`
                    : 'Not scanned yet';
    if (source.siteWait && !source.siteWait.exhausted) status.dataset.state = 'waiting';
    status.append(el('b', state));
    const outcome = source.lastRun ?? {
      status: source.lastStatus,
      summary: source.lastResult,
      finishedAt: source.lastRunAt,
    };
    const detail = source.scanning
      ? source.scanIssue
        ? `${source.scanIssue.url} · attempt ${source.scanIssue.attempts}`
        : (currentWork(data).find((row) => row.stop?.sourceUrl === source.url)?.progress ??
          (scanPageLabel(source.pageProgress)
            ? 'Last verified: ' + scanPageLabel(source.pageProgress)
            : null))
      : (source.siteWait?.message ?? outcome.summary ?? null);
    if (detail) {
      const small = el('small', detail);
      small.title = source.scanIssue?.evidence ?? detail;
      status.append(small);
    }
    return {status, outcome};
  }
  function metaLine(source, outcome) {
    const meta = el('div', null, 'source-meta');
    const plan = el('span', null, 'source-plan');
    plan.append(
      el('b', `Every ${source.intervalMinutes} min`),
      document.createTextNode(' · ' + modes[source.mode]),
    );
    meta.append(plan);
    const timing = el('span', null, 'source-timing'),
      nextRun = el(
        'b',
        !source.enabled
          ? 'Off'
          : source.scanning
            ? 'Scanning now'
            : source.blocked
              ? 'Waiting for a restart'
              : data.automation.status !== 'enabled'
                ? 'Tracking paused'
                : 'Next scan',
      );
    const nextAt = source.enabled
      ? (source.siteWait?.retryAt ??
        (!source.scanning && !source.blocked && data.automation.status === 'enabled'
          ? source.nextRunAt
          : null))
      : null;
    if (nextAt) {
      nextRun.dataset.sourceNextAt = String(nextAt);
      nextRun.dataset.sourceNextLabel = source.siteWait ? 'Access check' : 'Next scan';
      nextRun.title = nextRun.dataset.sourceNextLabel + ' ' + time(nextAt);
      updateNextRun(nextRun);
    }
    timing.append(nextRun);
    meta.append(timing);
    const outcomeLabel = runOutcomes[outcome.status],
      lastRun = el(
        'span',
        outcomeLabel
          ? `Last round: ${outcomeLabel}`
          : source.scanning
            ? 'Last round: first scan in progress'
            : 'Last round: not run yet',
        'source-last-run',
      );
    lastRun.dataset.status = outcomeLabel ? outcome.status : 'none';
    if (outcomeLabel)
      lastRun.title = [outcome.finishedAt ? time(outcome.finishedAt) : null, outcome.summary]
        .filter(Boolean)
        .join(' · ');
    meta.append(lastRun);
    if (!source.trial || source.trial.status === 'failed') {
      const trial = el(
        'small',
        source.trialRunning
          ? 'Nothing is submitted during the trial'
          : source.trial?.status === 'failed'
            ? 'Trial could not finish'
            : 'Will be tried in the first round',
        'source-trial-status',
      );
      trial.dataset.status = source.trialRunning ? 'running' : (source.trial?.status ?? 'pending');
      meta.append(trial);
    }
    return meta;
  }
  // Sources a site extension reads carry its kind; the rest use the generic reader.
  const extensionKinds = {
    api: [
      'API',
      "Site extension: listings come in full text from the site's API; no browser is opened.",
    ],
    http: ['HTTP', 'Site extension: pages are read over HTTP without opening a browser.'],
    browser: [
      'Automation',
      'Site extension: listings and pagination are read directly from the page opened in Chrome.',
    ],
  };
  // A source row carries {kind}; a catalog group carries the kind itself.
  function extensionChip(source) {
    const kind = source.extension?.kind ?? source.extension;
    const [label, detail] = extensionKinds[kind] ?? [];
    if (!label) return null;
    const chip = el('span', label, 'source-extension');
    chip.dataset.kind = kind;
    chip.title = detail;
    return chip;
  }
  function recipeChip(source) {
    const summary = recipeSummary(source.recipe ?? null, source.recipeState ?? null);
    const chip = button(
      summary.label,
      () => {
        editing = source.url;
        render();
        list
          .querySelector('.source-editor .source-recipe-editor')
          ?.scrollIntoView({block: 'nearest'});
      },
      'source-recipe',
    );
    chip.dataset.status = summary.status;
    chip.title =
      summary.detail +
      (source.recipeState?.verifiedAt ? ` · Verified ${time(source.recipeState.verifiedAt)}` : '');
    return chip;
  }

  // Memory: scan facts, recipe history and the pending queue. Rules fold away.
  const exclusionLabels = {
    hard_constraint: 'Hard constraint',
    qualification: 'Qualification conflict',
    unrelated_role: 'Unrelated role',
    not_listing: 'Not a listing',
  };
  function progressDetails(source) {
    const section = el('section', null, 'source-progress-details source-memory'),
      page = source.pageProgress,
      scan = source.scan,
      state = source.scanState,
      cycle = state?.active ?? state?.lastCompleted,
      pending = scan?.complete === false ? (scan.pendingUrls ?? []) : [];
    section.dataset.sourceId = source.url;
    section.setAttribute('aria-label', 'Scan memory');
    section.append(el('h3', 'Scan memory'));
    const facts = el('dl', null, 'source-progress-facts');
    for (const [label, value] of [
      [
        'Scan type',
        cycle?.mode === 'incremental'
          ? 'New record check'
          : cycle
            ? 'Full scan'
            : source.trial?.status === 'passed'
              ? 'All pages in the first scan'
              : 'Source trial in the first round',
      ],
      ['Last full scan', time(state?.lastFullScanAt)],
      ['Start of this round', time(cycle?.startedAt)],
      [
        'Date cutoff for new records',
        cycle?.mode === 'incremental' ? time(cycle.cutoffAt) : 'Up to the last page',
      ],
      ['Total records', source.resultCount ?? 0],
      [
        'Last reported page',
        page
          ? `Page ${page.currentPage}${page.totalPages ? ` / ${page.totalPages}` : ''}`
          : 'Not reported yet',
      ],
    ]) {
      const fact = el('div');
      fact.append(el('dt', label), el('dd', String(value)));
      facts.append(fact);
    }
    section.append(facts);
    const note = (label, text) => {
      const group = el('div', null, 'source-progress-note');
      group.append(el('b', label), el('p', text));
      section.append(group);
    };
    const address = (url) => button(url, () => api.openLink(url), 'source-progress-url');
    const recipe = el('div', null, 'source-progress-note source-progress-recipe'),
      summary = recipeSummary(source.recipe ?? null, source.recipeState ?? null),
      rs = source.recipeState;
    recipe.append(el('b', 'Search recipe'));
    const lines = [summary.label + ' · ' + summary.detail];
    if (source.recipe?.entry.kind === 'url_template') {
      lines.push('Template: ' + source.recipe.entry.template);
      const filters = source.extension?.search
        ? searchFilterLabels(source.extension.search, source.recipe.entry.template)
        : [];
      if (filters.length) lines.push('Site filters: ' + filters.join(' · '));
    }
    if (source.recipe?.entry.kind === 'search_form')
      lines.push(
        'Form: ' +
          source.recipe.entry.url +
          ' · ' +
          source.recipe.entry.fields.map((f) => `${f.key}=“${f.label}”`).join(', '),
      );
    if (source.recipe?.terms?.length) lines.push('Search terms: ' + source.recipe.terms.join(', '));
    if (source.recipe && source.recipe.entry.kind !== 'discovery')
      lines.push(
        'Pagination: ' +
          paginationLabels[source.recipe.pagination ?? 'auto'] +
          (source.recipe.ordering === 'newest_first'
            ? ' · Newest first; repeat scans stop at known listings'
            : '') +
          ` · Each search reads the first ${recipePageCap(source.recipe)} pages (at most 30 pages per scan in total)`,
      );
    if (rs?.verifiedAt)
      lines.push(
        `Last verification ${time(rs.verifiedAt)} · ${rs.successCount} succeeded, ${rs.failCount} failed`,
      );
    if (rs?.lastFailure)
      lines.push(
        `Last error ${time(rs.lastFailure.at)}: ${rs.lastFailure.reason}${rs.lastFailure.url ? ' · ' + rs.lastFailure.url : ''}`,
      );
    recipe.append(el('p', lines.join('\n')));
    section.append(recipe);
    const reasons = {
      initial: 'The first successful full scan has not happened yet.',
      periodic: 'A regular full scan is due.',
      ordering_unverified:
        'Newest-first ordering could not be verified; all pages will be scanned.',
      start_unverified:
        'It could not be verified that the scan started on the first page; all pages will be scanned.',
      dates_unverified: 'Listing dates are missing or unclear; all pages will be scanned.',
      ordering_changed:
        'The date order of the listings is inconsistent; all pages will be scanned.',
    };
    if (reasons[cycle?.reason]) note('Reason for the scope', reasons[cycle.reason]);
    if (page?.url) {
      const group = el('div', null, 'source-progress-note');
      group.append(el('b', 'Last reported results page'), address(page.url));
      section.append(group);
    } else if (cycle?.checkpoint?.url) {
      const group = el('div', null, 'source-progress-note');
      group.append(el('b', 'Resume page'), address(cycle.checkpoint.url));
      section.append(group);
    }
    if (cycle?.checkpoint?.cursor) note('Saved resume marker', cycle.checkpoint.cursor);
    if (source.recovery)
      note(
        'Automatic resume',
        `${time(source.recovery.readyAt)} · The agent session was interrupted; the same source and resume point will be picked up again.`,
      );
    if (cycle?.boundary)
      note(
        'Date cutoff',
        'All records on this page were reported and verified as older than the date cutoff.',
      );
    if (scan?.reason) note(scan.complete ? 'Completion note' : 'Resume note', scan.reason);
    if (source.observedPage && page && source.observedPage.currentPage !== page.currentPage)
      note(
        'Last opened results page',
        `Page ${source.observedPage.currentPage}. Saved progress and remaining addresses are kept.`,
      );
    if (scan?.work?.searches.length > 1) {
      const searches = el('div', null, 'source-progress-note');
      searches.append(el('b', 'Searches'));
      for (const search of scan.work.searches)
        searches.append(
          el(
            'p',
            `${search.label} · ${search.status === 'completed' ? 'Completed' : `${search.pendingUrls.length} address(es) waiting`}${search.pageProgress ? ` · page ${search.pageProgress.currentPage}` : ''}${search.id === scan.work.activeSearchId ? ' · Selected search' : ''}`,
          ),
        );
      section.append(searches);
    }
    // Waiting addresses first, then what Jev eliminated (card or detail) in red.
    const excluded = (scan?.work?.searches ?? []).flatMap((s) => s.excluded ?? []).reverse();
    const cards = Object.assign({}, ...(scan?.work?.searches ?? []).map((s) => s.cards ?? {})),
      pct = (p) => `${Math.round(p * 100)}%`;
    if (pending.length || excluded.length) {
      const details = el('details', null, 'source-progress-pending'),
        urls = el('ol');
      details.open = pending.length === 1;
      details.append(
        el(
          'summary',
          `Addresses to continue with (${pending.length}${excluded.length ? ` · ${excluded.length} excluded` : ''})`,
        ),
      );
      const rows = [...pending.map((url) => ({url})), ...excluded];
      let shown = 0;
      const more = button('Show the next 100 addresses', () => append());
      const append = () => {
        for (const row of rows.slice(shown, shown + 100)) {
          const item = el('li');
          if (row.stage) {
            item.className = 'source-progress-excluded';
            item.append(
              el(
                'b',
                `Excluded · ${row.stage === 'detail' ? 'On detail' : 'On card'} · ${exclusionLabels[row.reason] ?? row.reason}${row.confidence != null ? ` · Jev ${pct(row.confidence)}` : ''}`,
              ),
            );
            if (row.title) item.append(el('span', row.title));
          } else if (cards[row.url]) {
            const card = cards[row.url];
            item.className = 'source-progress-card';
            if (card.title) item.append(el('span', card.title));
            if (card.keep != null)
              item.append(
                el(
                  'small',
                  `Jev card: keep ${pct(card.keep)}${card.risk?.p >= 0.1 ? ` · closest exclusion ${exclusionLabels[card.risk.reason]} ${pct(card.risk.p)}` : ''}`,
                ),
              );
          }
          item.append(address(row.url));
          urls.append(item);
        }
        shown = Math.min(shown + 100, rows.length);
        more.hidden = shown >= rows.length;
      };
      append();
      details.append(urls, more);
      section.append(details);
    }
    if (source.lastResult) note('Last run result', source.lastResult);
    const rules = el('details', null, 'source-progress-rules');
    rules.append(
      el('summary', 'Tracking rule'),
      el(
        'p',
        'In the first round the source is tried, the recipe is saved and nothing is submitted. All pages are scanned in the next first scan and every 7 days. In other rounds, if the date ordering is reliable, listings are checked back to 24 hours before the start of the last successful round. If the recipe gives no results in two consecutive rounds, the source is learned again.',
      ),
    );
    section.append(rules);
    return section;
  }

  // Editor: the source itself, then its search recipe. Skill text is no longer edited here.
  function recipeFields(form, recipe) {
    const f = form.elements;
    f.method.value = recipe ? recipe.entry.kind : 'none';
    f.template.value = recipe?.entry.kind === 'url_template' ? recipe.entry.template : '';
    f.formUrl.value = recipe?.entry.kind === 'search_form' ? recipe.entry.url : '';
    f.queryLabel.value =
      recipe?.entry.kind === 'search_form'
        ? (recipe.entry.fields.find((x) => x.key === 'query')?.label ?? '')
        : '';
    f.locationLabel.value =
      recipe?.entry.kind === 'search_form'
        ? (recipe.entry.fields.find((x) => x.key === 'location')?.label ?? '')
        : '';
    f.terms.value = recipe?.terms?.join(', ') ?? '';
    f.pagination.value = recipe?.pagination ?? 'auto';
    f.ordering.value = recipe?.ordering ?? 'unknown';
    f.notes.value = recipe?.notes ?? '';
    syncRecipeFields(form);
  }
  function syncRecipeFields(form) {
    const method = form.elements.method.value;
    form.querySelector('[data-recipe-template]').hidden = method !== 'url_template';
    form.querySelector('[data-recipe-form]').hidden = method !== 'search_form';
    form.querySelector('[data-recipe-terms]').hidden =
      form.querySelector('[data-recipe-pagination]').hidden =
      form.querySelector('[data-recipe-ordering]').hidden =
        !['url_template', 'search_form'].includes(method);
    form.querySelector('[data-recipe-notes]').hidden = method === 'none';
    form.querySelector('[data-recipe-site]').hidden = method !== 'url_template' || !form.siteSearch;
    form.elements.template.required = method === 'url_template';
    form.elements.formUrl.required = form.elements.queryLabel.required = method === 'search_form';
  }
  function readRecipe(form, existing) {
    const f = form.elements,
      method = f.method.value;
    if (method === 'none') return null;
    const keep =
      existing && existing.entry.kind === method && existing.loginRequired !== undefined
        ? {loginRequired: existing.loginRequired}
        : {};
    if (method === 'discovery')
      return {
        entry: {kind: 'discovery'},
        pagination: 'auto',
        ...keep,
        ...(f.notes.value.trim() ? {notes: f.notes.value.trim()} : {}),
      };
    const terms = f.terms.value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const base = {
      pagination: f.pagination.value,
      ...keep,
      ...(f.ordering.value === 'newest_first' ? {ordering: 'newest_first'} : {}),
      ...(terms.length ? {terms} : {}),
      ...(f.notes.value.trim() ? {notes: f.notes.value.trim()} : {}),
    };
    if (method === 'url_template')
      return {...base, entry: {kind: 'url_template', template: f.template.value.trim()}};
    return {
      ...base,
      entry: {
        kind: 'search_form',
        url: f.formUrl.value.trim(),
        fields: [
          {key: 'query', label: f.queryLabel.value.trim()},
          ...(f.locationLabel.value.trim()
            ? [{key: 'location', label: f.locationLabel.value.trim()}]
            : []),
        ],
      },
    };
  }
  // A site extension's known results address: its filters become controls
  // that rewrite the template, so nobody guesses parameters.
  function siteSearchFields(form, search) {
    form.siteSearch = search;
    if (!search) return;
    const f = form.elements,
      block = form.querySelector('[data-recipe-site]'),
      list = block.querySelector('.source-site-filters');
    const controls = search.filters.map((filter) => {
      const label = el('label', filter.label);
      let control;
      if (filter.values) {
        control = el('select');
        control.append(new Option('—', ''));
        for (const [value, text] of Object.entries(filter.values))
          control.append(new Option(text, value));
      } else {
        control = el('input');
        control.maxLength = 80;
      }
      control.dataset.param = filter.param;
      control.onchange = () => {
        f.template.value = withSearchFilters(f.template.value, {[filter.param]: control.value});
      };
      label.append(control);
      list.append(label);
      return control;
    });
    const sync = () => {
      const values = searchFilterValues(search, f.template.value);
      for (const control of controls) control.value = values[control.dataset.param] ?? '';
    };
    f.template.addEventListener('input', sync);
    const use = button('Use the site template', () => {
      f.template.value = search.template;
      f.ordering.value = search.ordering ?? 'unknown';
      f.pagination.value = search.pagination ?? 'auto';
      sync();
    });
    block
      .querySelector('small')
      .append(
        search.ordering === 'newest_first'
          ? 'The site template sorts newest first. '
          : 'The site’s known search address. ',
        use,
      );
    sync();
  }
  function editor(source) {
    const form = el('form', null, source ? 'source-editor' : 'source-add');
    form.dataset.sourceId = source?.url ?? '';
    form.innerHTML = `<fieldset class="source-editor-section"><legend>Source</legend>
<label>Source name<input name="name" required maxlength="120"></label><label>Start address<input name="url" type="url" required></label>
<label class="source-editor-wide">Search scope<textarea name="query" required maxlength="2000"></textarea><small>If the recipe has no search terms, this text fills the {query} placeholder.</small></label>
<label>Scan interval (min)<input name="intervalMinutes" type="number" min="1" max="10080" required></label><label>Action mode<select name="mode"></select></label></fieldset>
<fieldset class="source-editor-section source-recipe-editor"><legend>Search recipe <small class="source-recipe-legend"></small></legend>
<label class="source-editor-wide">Search method<select name="method"></select><small>In the trial round the agent works out the site and saves the recipe itself. If you know it, you can also write it by hand; the app verifies it in the first scan.</small></label>
<label class="source-editor-wide" data-recipe-template>URL template<input name="template" maxlength="2000" placeholder="https://site/jobs?q={query}&l={location}&sort=date" spellcheck="false"><small>{query} takes the search term or the scope. Other placeholders such as {location} are filled from the criteria field of the same name. A fixed address without placeholders also works.</small></label>
<div class="source-editor-wide source-site-search" data-recipe-site><b>Site filters</b><small></small><div class="source-recipe-form source-site-filters"></div></div>
<div class="source-editor-wide source-recipe-form" data-recipe-form><label>Search form page<input name="formUrl" type="url" placeholder="https://site/jobs"></label><label>Search field label<input name="queryLabel" maxlength="120" placeholder="Stichwort"></label><label>Location field label (optional)<input name="locationLabel" maxlength="120" placeholder="Ort"></label></div>
<label class="source-editor-wide" data-recipe-terms>Search terms<input name="terms" maxlength="500" placeholder="Compliance, AI Governance, Data Protection" spellcheck="false"><small>If the search scope is not a keyword, write up to 5 comma-separated terms; each term becomes a separate search.</small></label>
<label data-recipe-pagination>Pagination<select name="pagination"></select></label>
<label data-recipe-ordering>Ordering<select name="ordering"><option value="unknown">Unknown</option><option value="newest_first">Newest first · stops at known listings</option></select></label>
<label class="source-editor-wide" data-recipe-notes>Note to the agent<textarea name="notes" maxlength="1000" placeholder="Filters, ordering, things to watch out for…"></textarea></label>
<label class="source-editor-wide">Working instructions<textarea name="instructions" maxlength="6000" placeholder="Extra rules for this source (optional)"></textarea></label></fieldset>
<div class="source-editor-foot"></div>`;
    const f = form.elements,
      footer = form.querySelector('.source-editor-foot'),
      scope = owner;
    for (const [mode, label] of Object.entries(modes)) {
      const option = new Option(label, mode);
      option.disabled =
        Object.keys(modes).indexOf(mode) > Object.keys(modes).indexOf(data.automation.mode);
      f.mode.append(option);
    }
    for (const [value, label] of Object.entries(methodLabels))
      f.method.append(new Option(label, value));
    for (const value of RECIPE_PAGINATION_KINDS)
      f.pagination.append(new Option(paginationLabels[value], value));
    f.name.value = source?.name ?? '';
    f.url.value = source?.url ?? '';
    f.url.disabled = Boolean(source);
    f.query.value = source?.query ?? data.automation.goal;
    f.intervalMinutes.value = source?.intervalMinutes ?? data.automation.intervalMinutes;
    f.mode.value = source?.mode ?? data.automation.mode;
    f.instructions.value = source?.instructions ?? '';
    siteSearchFields(form, source?.extension?.search ?? null);
    recipeFields(form, source?.recipe ?? null);
    f.method.onchange = f.ordering.onchange = () => syncRecipeFields(form);
    if (source) {
      const relearn = button('Relearn', async () => {
        await api.automationSourceRelearn(scope, source.url);
        editing = null;
        await refresh();
        notice(
          'The source’s next round will be a trial; the agent will work out the recipe again.',
        );
      });
      relearn.title = 'Runs the trial round again and relearns the recipe with the strong agent.';
      relearn.dataset.sourceRelearn = '';
      const remove = button(
        'Delete source',
        async () => {
          await api.automationSourceRemove(scope, source.url);
          if (owner === scope) {
            if (editing === source.url) editing = null;
            if (memory === source.url) memory = null;
            await refresh();
            notice('Source deleted. Found records were kept.');
          }
        },
        'quiet source-remove',
      );
      remove.title = 'Delete the source and its recipe; found records are kept.';
      footer.append(relearn, remove);
    }
    const cancel = button('Cancel', () => {
      editing = null;
      adding = false;
      render();
    });
    cancel.dataset.cancel = '';
    footer.append(cancel);
    const submit = el('button', source ? 'Save' : 'Add source', 'primary');
    submit.type = 'submit';
    footer.append(submit);
    form.onsubmit = action(async () => {
      const input = {
        name: f.name.value,
        url: f.url.value,
        query: f.query.value,
        instructions: f.instructions.value,
        recipe: readRecipe(form, source?.recipe ?? null),
        intervalMinutes: Number(f.intervalMinutes.value),
        mode: f.mode.value,
      };
      submit.disabled = true;
      try {
        if (source) await api.automationSourceSave(scope, source.url, input);
        else await api.automationSourceAdd(scope, input);
        editing = null;
        adding = false;
        await refresh();
        notice(
          source ? 'Source saved.' : 'Source added. It is tried automatically in its first round.',
        );
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }
  // The sites the app already knows (template starting sources, most with a
  // site extension), each added in one click with its ready recipe and
  // instructions.
  function renderCatalog(section) {
    const groups = data.sourceCatalog ?? [],
      key = groups.flatMap((group) => group.choices.map((choice) => choice.url)).join(' ');
    if (section.dataset.key === key) return;
    section.dataset.key = key;
    section.hidden = !groups.length;
    const rows = el('ul');
    for (const group of groups) {
      const row = el('li'),
        about = el('div'),
        [first] = group.choices,
        many = group.choices.length > 1;
      about.append(
        el('b', many ? group.name : first.name),
        el(
          'small',
          many
            ? `${group.choices.length} countries`
            : `${new URL(first.url).hostname.replace(/^www\./, '')} · ${first.label}`,
        ),
      );
      row.append(about);
      // The workspace country, when the board serves it, is the first choice.
      const country = el('select');
      country.setAttribute('aria-label', `${group.name} country`);
      for (const choice of group.choices) country.append(new Option(choice.label, choice.url));
      if (many) row.append(country);
      row.append(extensionChip(group) ?? '');
      const add = button('Add', async () => {
        const scope = owner,
          choice = group.choices.find((c) => c.url === country.value) ?? first;
        await api.automationSourceAdd(scope, {url: choice.url});
        if (owner !== scope) return;
        await refresh();
        notice(`${choice.name} added. It is tried automatically in its first round.`);
      });
      add.dataset.catalogAdd = group.name;
      row.append(add);
      rows.append(row);
    }
    section.replaceChildren(
      el('h3', 'Ready-made sources'),
      el('small', 'Sites the app knows; the name, search recipe and instructions come ready.'),
      rows,
    );
  }
  function updateEditor(form, source) {
    const locked = Boolean(source.scanning);
    for (const field of form.querySelectorAll('input,textarea,select,button'))
      if (field.type !== 'button')
        field.disabled =
          (locked && field.type === 'submit') ||
          field.name === 'url' ||
          (locked && field.tagName !== 'TEXTAREA');
    for (const field of form.querySelectorAll('textarea')) field.readOnly = locked;
    for (const b of form.querySelectorAll('[data-source-relearn],.source-remove'))
      b.disabled = locked || busySource(source.url);
    const summary = recipeSummary(source.recipe ?? null, source.recipeState ?? null),
      legend = form.querySelector('.source-recipe-legend');
    legend.textContent =
      summary.label +
      (source.recipeState?.verifiedAt ? ` · ${time(source.recipeState.verifiedAt)}` : '');
    legend.dataset.status = summary.status;
    form.querySelector('.source-editor-foot').title = locked
      ? 'The source is running. Stop the scan first to change it.'
      : '';
  }

  function render() {
    if (!data) return;
    const sources = data.sources ?? [],
      active = Boolean(data.activeRuns?.length),
      enabled = sources.filter((s) => s.enabled),
      blocked = enabled.filter((s) => s.blocked),
      upcoming = enabled
        .filter((s) => !s.scanning && !s.blocked && s.nextRunAt)
        .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
    const verified = sources.filter((s) => s.recipeState?.status === 'verified').length;
    const overview = head.querySelector('p');
    overview.textContent = `${enabled.length} active source(s)${sources.length - enabled.length ? `, ${sources.length - enabled.length} off` : ''}${blocked.length ? `, ${blocked.length} blocked` : ''}${sources.length ? ` · ${verified} recipe(s) verified` : ''}. `;
    if (data.automation.status === 'enabled' && upcoming) {
      const next = el('span');
      next.dataset.sourceNextAt = String(upcoming.nextRunAt);
      next.dataset.sourceNextLabel = 'Next scan';
      next.dataset.sourceNextSuffix = `: ${upcoming.name}.`;
      next.title = time(upcoming.nextRunAt);
      updateNextRun(next);
      overview.append(next);
    } else overview.append(document.createTextNode('Each source is tracked at its own interval.'));
    for (const control of bulkForm.querySelectorAll('input,select,button'))
      control.disabled = bulkSaving || (active && control.name === 'mode') || !sources.length;
    bulkForm.setAttribute('aria-busy', String(bulkSaving));
    bulkForm.querySelector('[role=status]').textContent = bulkSaving
      ? 'Saving…'
      : active && sources.length
        ? 'The action mode can be changed when the running round ends.'
        : '';
    bulk.hidden = !sources.length;
    list.inert = bulkSaving;
    addHost.inert = bulkSaving;
    renderProposal();
    add.disabled = bulkSaving;
    add.setAttribute('aria-expanded', String(adding));
    if (adding) {
      if (!addHost.firstChild) addHost.append(el('section', null, 'source-catalog'), editor(null));
      renderCatalog(addHost.querySelector('.source-catalog'));
    } else addHost.replaceChildren();
    const kept = list.querySelector('.source-editor'),
      keptMemory = list.querySelector('.source-memory'),
      tabHosts = new Map(),
      urls = new Set(sources.map((source) => source.url));
    for (const [url, view] of rows)
      if (!urls.has(url)) {
        view.row.remove();
        rows.delete(url);
      }
    let previous = null;
    for (const source of sources) {
      const view = rows.get(source.url) ?? sourceRow(source.url),
        {row, toggle, main, run, restart, edit, memoryButton, tabHost} = view,
        open = editing === source.url,
        memoryOpen = memory === source.url,
        scope = owner;
      const next = previous ? previous.nextElementSibling : list.firstElementChild;
      if (next !== row) list.insertBefore(row, next);
      previous = row;
      row.dataset.open = String(open || memoryOpen);
      row.dataset.tone = source.scanning
        ? 'scanning'
        : !source.enabled
          ? 'off'
          : source.blocked
            ? 'blocked'
            : source.lastFound
              ? 'found'
              : 'none';
      toggle.checked = source.enabled;
      toggle.disabled = Boolean(source.stopping || view.pending);
      toggle.setAttribute('aria-label', source.name + ' active');
      toggle.onchange = action(async () => {
        const enabled = toggle.checked;
        toggle.disabled = true;
        let saved = false;
        try {
          await api.automationSourceSave(scope, source.url, {enabled});
          saved = true;
          await refresh();
        } catch (error) {
          if (!saved) toggle.checked = source.enabled;
          throw error;
        } finally {
          toggle.disabled = false;
        }
      });
      const name = el('div', source.name, 'source-name'),
        link = button(
          new URL(source.url).hostname.replace(/^www\./, ''),
          () => api.openLink(source.url),
          'source-url',
        );
      link.title = source.url;
      name.append(link);
      const query = el('p', source.query, 'source-scope');
      query.title = source.query;
      const {status, outcome} = statusLine(source),
        meta = metaLine(source, outcome);
      meta.append(recipeChip(source));
      const extension = extensionChip(source);
      if (extension) meta.append(extension);
      main.replaceChildren(name, query, status, meta);
      const closing =
        (data.activeRuns ?? []).some(
          (r) => r.sourceUrl === source.url && !r.recordId && !r.recordOperation,
        ) && !source.scanning;
      let runLabel = closing
          ? 'Session closing…'
          : source.blocked || source.siteWait?.exhausted
            ? 'Retry'
            : 'Scan now',
        runDisabled =
          closing ||
          (source.siteWait?.waiting && !source.siteWait?.exhausted) ||
          !source.enabled ||
          !data.progress?.reviewed;
      run.title =
        source.trial?.status === 'passed'
          ? ''
          : 'The first round is a trial: the agent works out the site and saves the search recipe.';
      if (source.scanning || source.stopping) {
        runLabel = source.stopping ? 'Stopping…' : 'Stop scan';
        runDisabled = source.stopping;
        run.dataset.sourceStop = source.url;
      } else delete run.dataset.sourceStop;
      if (view.pending) {
        runLabel = view.pending === 'stop' ? 'Stopping…' : 'Starting…';
        runDisabled = true;
      }
      if (run.textContent !== runLabel) run.textContent = runLabel;
      run.disabled = Boolean(runDisabled);
      run.setAttribute('aria-busy', String(Boolean(view.pending || source.stopping)));
      run.onclick = (event) => {
        event.preventDefault();
        if (!run.disabled) void scanAction(view, scope, source.url, Boolean(source.scanning));
      };
      // A scan left unfinished resumes where it stopped; this starts it over.
      const resumable =
        !source.scanning &&
        !source.stopping &&
        (source.scan?.complete === false || Boolean(source.scanState?.active));
      if (resumable)
        run.title = 'Continues from the page where it stopped and the remaining addresses.';
      restart.hidden = !resumable || runDisabled || Boolean(source.siteWait);
      restart.disabled = Boolean(view.pending);
      restart.title =
        'Clears the saved page position and remaining addresses and starts the scan from the first results page. Saved listings are not read again.';
      restart.onclick = (event) => {
        event.preventDefault();
        if (!restart.disabled) void scanAction(view, scope, source.url, false, true);
      };
      edit.textContent = open ? 'Close' : 'Edit';
      edit.onclick = action(() => {
        editing = open ? null : source.url;
        render();
      });
      edit.setAttribute('aria-expanded', String(open));
      memoryButton.textContent = memoryOpen ? 'Close details' : 'Details';
      memoryButton.onclick = action(() => {
        memory = memoryOpen ? null : source.url;
        render();
      });
      memoryButton.setAttribute('aria-expanded', String(memoryOpen));
      tabHosts.set(source.url, tabHost);
      row.querySelector(':scope > .source-memory')?.remove();
      if (!open) row.querySelector(':scope > .source-editor')?.remove();
      if (open) {
        const form = kept?.dataset.sourceId === source.url ? kept : editor(source);
        updateEditor(form, source);
        if (form.parentElement !== row) row.append(form);
      }
      if (memoryOpen) {
        const details = progressDetails(source),
          previousPending =
            keptMemory?.dataset.sourceId === source.url
              ? keptMemory.querySelector('.source-progress-pending')
              : null,
          pending = details.querySelector('.source-progress-pending');
        if (previousPending && pending) pending.open = previousPending.open;
        row.append(details);
      }
    }
    if (!sources.length) {
      if (!empty.isConnected) list.insertBefore(empty, otherHost);
    } else empty.remove();
    tabsControl.update(
      owner,
      sources.map((source) => ({id: source.url, url: source.url})),
      tabHosts,
      otherHost,
      list,
    );
  }
  return {
    update(snapshot, id) {
      if (owner !== id) {
        editing = null;
        memory = null;
        adding = false;
        addHost.replaceChildren();
        bulkForm.reset();
        for (const view of rows.values()) view.row.remove();
        rows.clear();
      }
      owner = id;
      data = snapshot;
      render();
    },
  };
}
