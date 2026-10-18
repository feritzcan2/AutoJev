// Extension test bench (development builds only): reads an address the way a
// scan of this workspace would and shows what the site extension made of it.
// No agent, no Jev model call, no records. Follow the pagination, read single
// listings and reload the extensions from disk after an edit.
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
// An explanation box on hover or keyboard focus. The window does not show
// native title tooltips, so the bench draws its own; a click keeps it open
// so its text can be selected, and Escape or a click elsewhere closes it.
let tip = null,
  pinned = null,
  anchor = null;
function tipBox() {
  if (tip?.isConnected) return tip;
  tip = el('div', null, 'extension-bench-tip');
  tip.id = 'extension-bench-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTip(true);
  });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (pinned && !pinned.contains(event.target) && !tip.contains(event.target)) hideTip(true);
    },
    true,
  );
  // The box follows its chip while the page scrolls.
  document.addEventListener(
    'scroll',
    () => (anchor?.isConnected && !tip.hidden ? place(anchor) : hideTip(true)),
    true,
  );
  return tip;
}
function place(node) {
  const box = tipBox(),
    r = node.getBoundingClientRect(),
    width = Math.min(560, innerWidth - 32);
  box.style.maxWidth = width + 'px';
  box.style.left = Math.max(16, Math.min(r.left, innerWidth - width - 16)) + 'px';
  const height = box.offsetHeight;
  box.style.top =
    (r.bottom + 8 + height <= innerHeight ? r.bottom + 8 : Math.max(8, r.top - 8 - height)) + 'px';
}
function showTip(node) {
  const box = tipBox();
  anchor = node;
  box.textContent = node.dataset.tip;
  box.hidden = false;
  box.dataset.pinned = String(pinned === node);
  place(node);
}
function hideTip(force = false) {
  if (pinned && !force) return;
  pinned = null;
  anchor = null;
  if (tip) tip.hidden = true;
}
function explain(node, text) {
  node.dataset.tip = text;
  node.dataset.explained = 'true';
  node.tabIndex = 0;
  node.setAttribute('aria-describedby', 'extension-bench-tip');
  node.addEventListener('mouseenter', () => !pinned && showTip(node));
  node.addEventListener('mouseleave', () => hideTip());
  node.addEventListener('focus', () => !pinned && showTip(node));
  node.addEventListener('blur', () => hideTip());
  node.addEventListener('click', () => {
    pinned = pinned === node ? null : node;
    showTip(node);
  });
}
const transports = {
  api: 'API collector',
  http: 'HTTP reader',
  browser: 'Browser tab',
};
const RECENT_KEY = 'extension-bench-recent',
  RECENT_LIMIT = 15;
const recent = () => {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((url) => typeof url === 'string') : [];
  } catch {
    return [];
  }
};
const remember = (url) => {
  try {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([url, ...recent().filter((u) => u !== url)].slice(0, RECENT_LIMIT)),
    );
  } catch {}
};
const clock = (at) =>
  new Date(at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', second: '2-digit'});

let status = null;
// Whether this build has the bench; packaged builds answer {available:false}.
export async function extensionBenchAvailable(api) {
  status ??= api.extensionBenchStatus?.().catch(() => ({available: false})) ?? {available: false};
  return (await status).available === true;
}

// One bench panel. `scope()` is the current workspace id; `url` prefills the address.
export function extensionBenchPanel(api, {scope, url = '', onClose}) {
  const panel = el('section', null, 'extension-bench');
  panel.setAttribute('aria-label', 'Extension test bench');
  let busy = false,
    opened = false,
    current = null,
    history = [],
    seen = new Map();
  const listId = 'extension-bench-recent-' + Math.random().toString(36).slice(2);

  const head = el('div', null, 'extension-bench-head'),
    title = el('div');
  title.append(
    el('h3', 'Extension test bench'),
    el(
      'p',
      'Development build. Reads the address the way this workspace’s scans do — no agent and no records; Jev is asked only by “Jev triage”.',
    ),
  );
  const reloadInfo = el('small', null, 'extension-bench-reload-info'),
    headActions = el('div', null, 'extension-bench-actions');
  head.append(title, headActions);

  const form = el('form', null, 'extension-bench-form'),
    input = el('input');
  input.type = 'url';
  input.required = true;
  input.placeholder = 'https://… results page or listing';
  input.value = url;
  input.setAttribute('list', listId);
  input.setAttribute('aria-label', 'Address to read');
  const datalist = el('datalist');
  datalist.id = listId;
  const readButton = el('button', 'Read page', 'primary'),
    listingButton = el('button', 'Read as listing', 'quiet');
  readButton.type = 'submit';
  listingButton.type = 'button';
  form.append(input, datalist, readButton, listingButton);
  const output = el('div', null, 'extension-bench-output'),
    state = el('p', null, 'extension-bench-state');
  state.setAttribute('role', 'status');
  // A source's bench reads the addresses its scans open: the recipe's searches.
  const picker = el('label', null, 'extension-bench-picker'),
    select = el('select');
  picker.append(el('span', 'Scan address'), select);
  picker.hidden = true;
  panel.append(head, picker, form, reloadInfo, state, output);

  const button = (label, fn, cls = 'quiet') => {
    const b = el('button', label, cls);
    b.type = 'button';
    b.onclick = () => run(fn);
    return b;
  };
  const link = (address, text = address) => {
    const b = el('button', text, 'source-progress-url');
    b.type = 'button';
    b.title = address;
    b.onclick = () => api.openLink(address).catch(() => {});
    return b;
  };
  async function run(fn, label = 'Reading…') {
    if (busy) return;
    busy = true;
    for (const control of panel.querySelectorAll('button,input,select')) control.disabled = true;
    state.dataset.tone = '';
    state.textContent = label;
    try {
      await fn();
      if (state.textContent === label) state.textContent = '';
    } catch (error) {
      state.dataset.tone = 'error';
      state.textContent = error.message;
    } finally {
      busy = false;
      for (const control of panel.querySelectorAll('button,input,select')) control.disabled = false;
    }
  }
  function fillRecent() {
    datalist.replaceChildren(
      ...recent().map((u) => {
        const option = el('option');
        option.value = u;
        return option;
      }),
    );
  }

  const reload = button('Reload extensions', async () => {
    const result = await api.extensionBenchReload();
    reloadInfo.textContent = `Reloaded from disk at ${clock(result.at)} · ${result.extensions.length} extensions · version ${result.version}`;
    if (current) await read(current.url, current.mode, {keepHistory: true});
  });
  reload.title =
    'Loads every module in app/site-extensions/ again, so an edited reader is used without restarting. Running scans use it from their next page.';
  const closeTab = button('Close bench tab', async () => {
    await api.extensionBenchClose(scope());
    closeTab.hidden = true;
  });
  closeTab.hidden = true;
  headActions.append(reload, closeTab);
  if (onClose) headActions.append(button('Close', onClose));

  async function read(address, mode = 'page', {keepHistory = false, push = false} = {}) {
    const result =
      mode === 'listing'
        ? await api.extensionBenchListing(scope(), address)
        : await api.extensionBenchRead(scope(), address);
    remember(address);
    fillRecent();
    if (push && current) history.push(current);
    if (!push && !keepHistory) {
      history = [];
      seen = new Map();
    }
    current = {url: address, mode, result};
    input.value = address;
    render();
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    if (form.reportValidity()) run(() => read(input.value.trim()));
  };
  select.onchange = () => {
    input.value = select.value;
    run(() => read(select.value));
  };
  listingButton.onclick = () => {
    if (form.reportValidity()) run(() => read(input.value.trim(), 'listing'));
  };

  // Chips: which reader, whether the extension read the page, load state.
  // `listing`: the chips of a listing read, where a DOM reader (results pages
  // only) is not expected and the structured listing is what counts.
  function summary(result, {listing = false} = {}) {
    const line = el('div', null, 'extension-bench-chips'),
      chip = (text, tone, tip) => {
        const c = el('span', text, 'extension-bench-chip');
        if (tone) c.dataset.tone = tone;
        if (tip) explain(c, tip);
        line.append(c);
      };
    chip(
      result.extension ? `${result.extension.id} · ${result.extension.kind}` : 'No site extension',
      result.extension ? 'accent' : null,
    );
    chip('Read with: ' + transports[result.transport]);
    if (listing) {
      if (result.listing)
        chip(
          result.transport === 'browser'
            ? 'Listing read from the page’s JobPosting'
            : 'Listing read by the site reader',
          'success',
        );
      else if (!result.readiness?.loading) chip('No structured listing', 'warning');
    } else if (result.extension && result.transport === 'browser')
      result.applied
        ? chip('DOM reader applied', 'success')
        : chip('DOM reader not applied · generic reader', 'warning');
    else if (!result.extension)
      chip('Generic reader · a scan’s card triage picks the listings', null, 'Not run here.');
    if (result.readiness?.loading)
      chip(
        'Still loading' + (result.readiness.reason ? ': ' + result.readiness.reason : ''),
        'warning',
      );
    else if (result.transport === 'browser') chip('Loaded', 'success');
    chip('Read ' + clock(result.at) + (result.version ? ` · reload ${result.version}` : ''));
    return line;
  }
  function notes(result) {
    const lines = [...(result.notes ?? []), ...(result.diagnostics ?? [])];
    if (!lines.length) return null;
    const list = el('ul', null, 'extension-bench-notes');
    for (const line of lines) list.append(el('li', line));
    return list;
  }
  function pagination(result) {
    const box = el('div', null, 'extension-bench-pagination');
    box.append(el('b', 'Pagination'));
    const entries = result.pagination ?? [];
    if (!entries.length) {
      box.append(el('span', 'None found on this page.'));
      return box;
    }
    const currentEntry = entries.find((e) => e.current),
      next = entries.find((e) => !e.current && !e.disabled && e.url);
    box.append(
      el(
        'span',
        entries
          .map(
            (e) => (e.current ? `[${e.text}]` : e.text) + (e.url ? '' : ' (control, no address)'),
          )
          .join('  ·  '),
      ),
    );
    const controls = el('div', null, 'extension-bench-page-actions');
    if (history.length)
      controls.append(
        button('← Back', async () => {
          const previous = history.pop();
          current = previous;
          input.value = previous.url;
          render();
        }),
      );
    if (next)
      controls.append(
        button('Next page →', () => read(next.url, 'page', {push: true}), 'primary'),
        link(next.url),
      );
    else if (currentEntry)
      controls.append(el('small', 'No next page address: the last page, or a click-only control.'));
    box.append(controls);
    return box;
  }
  // Listings of this page; across followed pages, repeats are flagged.
  function listings(result) {
    const box = el('div', null, 'extension-bench-listings'),
      list = result.listings ?? [],
      page = result.url,
      repeats = list.filter((l) => seen.has(l.url) && seen.get(l.url) !== page).length;
    for (const l of list) if (!seen.has(l.url)) seen.set(l.url, page);
    // The generic reader marks nothing: zero here is not an empty result.
    const unmarked = !list.length && !result.applied;
    box.append(
      el(
        'b',
        unmarked
          ? 'Listings not marked · generic reader'
          : `${list.length} ${list.length === 1 ? 'listing' : 'listings'}` +
              (repeats ? ` · ${repeats} already seen on an earlier page` : '') +
              (result.unavailable?.length ? ` · ${result.unavailable.length} unavailable` : ''),
      ),
    );
    if (!list.length) {
      box.append(
        el(
          'small',
          result.readiness?.loading
            ? 'The page is still loading; this is not an empty result.'
            : !unmarked
              ? 'The extension marked no listings on this page.'
              : (result.extension
                  ? 'The DOM reader was not applied (see the notes above). '
                  : 'No site extension marks listings on this site. ') +
                `A scan’s card triage (Jev, not run here) picks the listings from the ${result.otherLinks} links below.`,
        ),
      );
      return box;
    }
    const ol = el('ol');
    for (const l of list) {
      const item = el('li'),
        row = el('div', null, 'extension-bench-listing-row'),
        info = el('div');
      info.append(el('span', l.title || '(no title)'));
      if (l.card && l.card !== l.title) info.append(el('small', l.card));
      info.append(link(l.url));
      if (seen.get(l.url) !== page) item.dataset.repeat = 'true';
      const detail = el('div', null, 'extension-bench-detail-host');
      row.append(
        info,
        button('Read', async () => {
          const result = await api.extensionBenchListing(scope(), l.url);
          detail.replaceChildren(listingView(result));
          if (result.tabId) closeTab.hidden = false;
        }),
      );
      item.append(row, detail);
      ol.append(item);
    }
    box.append(ol);
    return box;
  }
  function fold(label, content) {
    const details = el('details', null, 'extension-bench-fold');
    details.append(el('summary', label), content);
    return details;
  }
  // One listing as detail evidence: its facts and own description, or why there is none.
  function listingView(result) {
    const box = el('div', null, 'extension-bench-listing');
    box.append(summary(result, {listing: true}));
    // DOM readers only read results pages; on a listing their null is expected.
    const n = notes({...result, diagnostics: []});
    if (n) box.append(n);
    if (result.title) box.append(el('strong', result.title));
    if (!result.listing) {
      box.append(
        el(
          'p',
          result.readiness?.loading
            ? 'The page is still loading; read it again.'
            : 'No structured listing (no site reader description and no usable JobPosting). A scan would filter this page’s text with Jev, which is not run here.',
          'extension-bench-warning',
        ),
        fold(`Page text (${result.text.length} characters)`, el('pre', result.text.text)),
        jevSection(result),
      );
      return box;
    }
    const facts = el('dl', null, 'extension-bench-facts');
    const fields = Object.entries(result.listing.fields ?? {});
    for (const [key, value] of fields) {
      const fact = el('div');
      fact.append(el('dt', key), el('dd', String(value)));
      facts.append(fact);
    }
    if (!fields.length) facts.append(el('small', 'No fields stated.'));
    box.append(facts);
    if (result.cells && Object.keys(result.cells).length)
      box.append(
        el(
          'small',
          'Record cells: ' +
            Object.entries(result.cells)
              .map(([k, v]) => `${k}: ${v ?? '—'}`)
              .join(' · '),
        ),
      );
    const description = result.listing.description;
    box.append(
      description.length
        ? fold(
            `Description (${description.length} characters${description.length > description.text.length ? ', shortened' : ''})`,
            el('pre', description.text),
          )
        : el('p', 'Empty description.', 'extension-bench-warning'),
    );
    if (result.fromCache)
      box.append(el('small', 'From the last API page read, not fetched again.'));
    box.append(jevSection(result));
    return box;
  }

  // Jev triage of this listing with the workspace's criteria: the card and
  // detail decisions a scan would take, each answer, and what Jev was asked.
  const percent = (x) => (Number.isFinite(x) ? Math.round(x * 100) + '%' : '—');
  const answerText = (a) =>
    `${a.choice} ${percent(a.confidence)}` +
    (a.probabilities
      ? ' (' +
        Object.entries(a.probabilities)
          .sort((x, y) => y[1] - x[1])
          .map(([k, v]) => `${k} ${percent(v)}`)
          .join(', ') +
        ')'
      : '');
  const decisionText = {
    possible: 'Kept for the agent to assess',
    uncertain: 'Uncertain · left to the agent',
    mismatch: 'Excluded (proven mismatch)',
    incomplete: 'Incomplete · a scan waits and reads again',
    results_page: 'A results page, not a listing',
    no_text: 'No text to classify',
  };
  const reasonText = {
    hard_constraint: 'an explicit hard rule in your criteria (only / must / no) is contradicted',
    qualification: 'a requirement of the listing contradicts a known fact about you',
    unrelated_role: 'what the listing offers is clearly outside your goal and field',
    not_listing: 'the page is not an individual listing (or the listing is gone)',
    none: 'no exclusion reason is supported',
  };
  const probabilities = (a) =>
    a.probabilities
      ? Object.entries(a.probabilities)
          .sort((x, y) => y[1] - x[1])
          .map(([k, v]) => `${k} ${percent(v)}`)
          .join(', ')
      : 'not given';
  // Hover text of the card chip: what was judged, the answer and the rule applied.
  function cardTip(j) {
    const c = j.card,
      t = j.thresholds,
      lines = [
        'CARD STAGE — the first, cheap filter.',
        `Jev judged only the card: the title and the facts the site states, not the description.`,
        `Card: ${c.text.split('\n').slice(0, 4).join(' · ')}`,
        '',
        `Jev's answer: ${c.answer.choice} (its confidence ${percent(c.answer.confidence)}).`,
        `Probabilities: ${probabilities(c.answer)}.`,
        `Keep: ${percent(c.keep)}. Most likely exclusion: ${c.reason} — ${reasonText[c.reason] ?? c.reason}.`,
        '',
        c.rule === 'results_page'
          ? `Rule for cards on a results page: eliminated when Jev names an exclusion with at least ${percent(t.confidence)} confidence, or keep falls below ${percent(t.keepFloor)}.`
          : `Rule for listings a site reader or API delivers whole: eliminated when the exclusion likelihood (the named exclusion's confidence, or 100% − keep) reaches ${percent(t.confidence)}.`,
        `Here the exclusion likelihood is ${percent(c.confidence)}.`,
        '',
        c.eliminated
          ? `→ ELIMINATED at the card. In a scan the detail is never read and the agent never sees this listing; Scan memory lists it as "Excluded · On card · ${c.reason}".`
          : `→ KEPT: ${percent(c.confidence)} is below the threshold, so the full text goes to the detail stage.`,
      ];
    return lines.join('\n');
  }
  // Hover text of the detail chip: each fragment's answer, the proof and the outcome.
  function detailTip(j) {
    const d = j.detail,
      t = j.thresholds,
      lines = [
        'DETAIL STAGE — Jev reads the listing’s full text.',
        `${d.characters} characters, asked in ${d.fragments.length} fragment(s) of up to 30,000 characters.`,
      ];
    for (const f of d.fragments)
      lines.push(
        `• Text ${f.offset}–${f.end}: ${f.answer.choice} ${percent(f.answer.confidence)} (${probabilities(f.answer)}) → counted as ${f.decision}.`,
      );
    lines.push(
      `A mismatch counts only at ${percent(t.confidence)} or more; below that it becomes uncertain. Every fragment must agree, otherwise the result is uncertain.`,
      '',
    );
    if (d.proof) {
      const {support, exclusion} = d.proof.answers;
      lines.push(
        'EXCLUSION PROOF — a mismatch only removes a listing when a separate question confirms it.',
        `Is an exclusion supported? ${support.choice} ${percent(support.confidence)} (${probabilities(support)}).`,
        `Which reason? ${exclusion.choice} ${percent(exclusion.confidence)} — ${reasonText[exclusion.choice] ?? exclusion.choice}.`,
        `Needed: "supported" with at least ${percent(t.confidence)} and a reason other than none.`,
        '',
      );
    }
    const raw = d.fragments.some(
        (f) => f.answer.choice === 'mismatch' && f.answer.confidence < t.confidence,
      ),
      split =
        new Set(d.fragments.map((f) => f.decision).filter((x) => x !== 'incomplete')).size > 1;
    lines.push(
      {
        mismatch: `→ EXCLUDED. In a scan the listing is closed here without the agent: it is not scored or saved, and Scan memory lists it as "Excluded · Detail · ${d.proof?.answers.exclusion.choice ?? ''}". Check "Profile and rules Jev was given" for the rule it broke.`,
        possible:
          '→ KEPT as potentially relevant. In a scan the agent reads Jev’s brief of the listing and scores it.',
        uncertain: `→ UNCERTAIN, so it goes to the agent, who reads the brief and decides. Why: ${
          d.proof && !d.proof.supported
            ? 'Jev said mismatch, but the proof did not confirm it.'
            : raw
              ? `Jev leaned to mismatch but below ${percent(t.confidence)}.`
              : split
                ? 'the fragments disagreed.'
                : 'Jev found facts missing, ambiguous or conflicting.'
        }`,
        incomplete:
          '→ INCOMPLETE: Jev saw only a page shell or loading content. A scan waits and reads the page again before deciding.',
        results_page:
          '→ A RESULTS PAGE with several listings, not one listing. A scan defers it to be scanned as a results page.',
        no_text: '→ The page had no text, so nothing was asked.',
      }[d.decision] ?? d.decision,
    );
    if (j.why) lines.push('', ...whyLines(j.why));
    if (j.notes.length) lines.push('', ...j.notes);
    return lines.join('\n');
  }
  // The bench-only "why" question: the saved rule or fact and the listing
  // passage Jev picks for the exclusion, with the runners-up.
  const whyChoice = (top) =>
    top.key === 'none'
      ? `none of the offered options (${percent(top.probability)})`
      : `${percent(top.probability)} · ${top.source ? top.source + ': ' : ''}${top.text}`;
  function whyLines(why) {
    return [
      `WHY (bench-only question, not asked in scans; Jev chose among ${why.offered.rules} rule/fact options and ${why.offered.passages} ${why.basis === 'card' ? 'card' : 'listing'} passages):`,
      `Rule or fact contradicted: ${whyChoice(why.rule.top[0])}`,
      `Listing passage: ${whyChoice(why.passage.top[0])}`,
    ];
  }
  function whyView(why) {
    const box = el('div', null, 'extension-bench-why');
    box.append(
      el(
        'b',
        `Why: ${why.reason} · bench-only question (${why.basis === 'card' ? 'card' : 'detail'}), not asked in scans`,
      ),
    );
    for (const [label, part] of [
      ['Rule or fact it contradicts', why.rule],
      ['Passage of the listing', why.passage],
    ]) {
      const [first, ...rest] = part.top,
        line = el('div', null, 'extension-bench-why-line');
      line.append(el('small', label), el('p', whyChoice(first)));
      if (rest.length)
        line.append(
          el('small', 'Next: ' + rest.map(whyChoice).join(' | '), 'extension-bench-muted'),
        );
      box.append(line);
    }
    return box;
  }
  function jevSection(result) {
    const box = el('div', null, 'extension-bench-jev'),
      host = el('div');
    const run = button('Jev triage', async () => {
      const read = await api.extensionBenchJev(scope(), result.url);
      if (read.tabId) closeTab.hidden = false;
      host.replaceChildren(jevView(read.jev));
    });
    run.title =
      'Asks Jev the card and detail questions of a scan with this workspace’s profile and criteria. Uses Jev tokens; no agent, no records.';
    box.append(run, host);
    return box;
  }
  function jevView(j) {
    const box = el('div', null, 'extension-bench-jev-result'),
      chips = el('div', null, 'extension-bench-chips'),
      chip = (text, tone, tip) => {
        const c = el('span', text, 'extension-bench-chip');
        if (tone) c.dataset.tone = tone;
        explain(c, tip);
        chips.append(c);
      };
    chip(
      j.card.eliminated ? `Card: eliminated · ${j.card.reason}` : 'Card: kept',
      j.card.eliminated ? 'warning' : 'success',
      cardTip(j),
    );
    chip(
      'Detail: ' + (decisionText[j.detail.decision] ?? j.detail.decision),
      j.detail.decision === 'mismatch'
        ? 'warning'
        : j.detail.decision === 'possible'
          ? 'success'
          : null,
      detailTip(j),
    );
    box.append(chips);
    const rows = el('dl', null, 'extension-bench-facts');
    const row = (label, value) => {
      const fact = el('div');
      fact.append(el('dt', label), el('dd', value));
      rows.append(fact);
    };
    row(
      'Card answer',
      `${answerText(j.card.answer)} · keep ${percent(j.card.keep)} · most likely exclusion ${j.card.reason}`,
    );
    row(
      'Card rule',
      j.card.rule === 'results_page'
        ? `Results page: eliminated when an exclusion reaches ${percent(j.thresholds.confidence)} or keep falls below ${percent(j.thresholds.keepFloor)}`
        : `Extension card: eliminated when exclusion confidence reaches ${percent(j.thresholds.confidence)} (here ${percent(j.card.confidence)})`,
    );
    for (const f of j.detail.fragments)
      row(`Detail ${f.offset}–${f.end}`, `${answerText(f.answer)} → ${f.decision}`);
    if (j.detail.proof)
      row(
        'Exclusion proof',
        `${j.detail.proof.supported ? 'supported' : 'not proven'} · support ${answerText(j.detail.proof.answers.support)} · reason ${answerText(j.detail.proof.answers.exclusion)}`,
      );
    box.append(rows);
    if (j.why) box.append(whyView(j.why));
    if (j.notes.length) {
      const list = el('ul', null, 'extension-bench-notes');
      for (const note of j.notes) list.append(el('li', note));
      box.append(list);
    }
    const asked = el('div');
    for (const q of j.asked)
      asked.append(
        fold(
          `${q.step} · ${q.ms} ms · ${(q.usage?.input_tokens ?? 0) + (q.usage?.output_tokens ?? 0)} tokens`,
          el(
            'pre',
            JSON.stringify({state: q.state, questions: q.questions, answers: q.answers}, null, 2),
          ),
        ),
      );
    box.append(
      fold('Profile and rules Jev was given', el('pre', JSON.stringify(j.criteria, null, 2))),
      fold(`Every Jev request (${j.asked.length})`, asked),
    );
    return box;
  }

  function render() {
    const result = current?.result;
    output.replaceChildren();
    if (!result) return;
    closeTab.hidden = !result.tabId;
    if (current.mode === 'listing') {
      output.append(listingView(result));
      return;
    }
    output.append(summary(result));
    const n = notes(result);
    if (n) output.append(n);
    if (result.readiness?.loading && result.tabId)
      output.append(
        button('Read again without reloading', () =>
          api.extensionBenchObserve(scope(), current.url, result.tabId).then((next) => {
            current = {...current, result: next};
            render();
          }),
        ),
      );
    if (result.apiUrl && result.apiUrl !== result.url)
      output.append(el('small', 'API address: ' + result.apiUrl, 'extension-bench-muted'));
    output.append(pagination(result), listings(result));
    if (result.listing) output.append(fold('This page is itself a listing', listingView(result)));
    if (result.otherLinks) {
      const ol = el('ol', null, 'extension-bench-links');
      for (const l of result.otherLinkSample) {
        const li = el('li');
        li.append(el('span', l.text || '(no text)'), link(l.url));
        ol.append(li);
      }
      const label =
        (result.extension && result.applied
          ? `${result.otherLinks} links marked as not a listing`
          : `${result.otherLinks} links`) +
        (result.otherLinks > result.otherLinkSample.length
          ? ` (first ${result.otherLinkSample.length})`
          : '');
      const links = fold(label, ol);
      // Without marked listings the links are what a scan works from.
      links.open = !result.applied;
      output.append(links);
    }
    if (result.text.length)
      output.append(
        fold(`Page text (${result.text.length} characters)`, el('pre', result.text.text)),
      );
  }

  fillRecent();
  return {
    element: panel,
    // Opens on a source: offers its recipe searches and reads the first one,
    // or the source address when it has no URL recipe.
    open(address) {
      if (!address || opened) return;
      opened = true;
      run(async () => {
        const searches = api.extensionBenchSearches
          ? await api.extensionBenchSearches(scope(), address).catch(() => [])
          : [];
        const option = (value, label) => {
          const o = el('option', label);
          o.value = value;
          return o;
        };
        select.replaceChildren(
          ...searches.map((search) =>
            option(search.url, `Recipe search · ${search.term ?? 'source query'}`),
          ),
          option(address, 'Source address · ' + address),
        );
        picker.hidden = !searches.length;
        const first = searches[0]?.url ?? address;
        select.value = first;
        input.value = first;
        await read(first);
      });
    },
    focus: () => input.focus(),
  };
}
