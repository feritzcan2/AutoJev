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
      'Development build. Reads the address the way this workspace’s scans do — no agent, no Jev model calls, no records.',
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
        if (tip) c.title = tip;
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
