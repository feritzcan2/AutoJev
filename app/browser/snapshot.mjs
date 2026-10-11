import {randomUUID} from 'node:crypto';

// Bound the serialized response, not just the visible character count: JSON
// escaping and multi-byte text also contribute to provider tool output limits.
export const BROWSER_RESPONSE_BYTES = 16000;
export const BROWSER_PART_CHARACTERS = 8000;
const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const schema = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !['offset', 'limit'].includes(k)),
  additionalProperties: false,
});
const snapshotId = {type: 'string', minLength: 1, maxLength: 64};
const offset = {type: 'integer', minimum: 0};
export const browserSnapshotTools = [
  {
    name: 'browser_read_part',
    description:
      'Read another part of a saved snapshot by snapshotId and nextOffset; no navigation or step budget. Cached text is historical and lives in RAM while the app is open; after a restart read the page again. Actions still need a fresh snapshot. Fragments may end inside a line or JSON value.',
    inputSchema: schema({
      snapshotId,
      offset,
      limit: {type: 'integer', minimum: 1, maximum: BROWSER_PART_CHARACTERS},
    }),
  },
  {
    name: 'browser_search',
    description:
      'Search a saved snapshot for a literal phrase, case-insensitively; returns offsets and surrounding text for browser_read_part. Does not touch the browser; no match is not proof of no results.',
    inputSchema: schema({
      snapshotId,
      query: {type: 'string', minLength: 1, maxLength: 200},
      offset,
      limit: {type: 'integer', minimum: 1, maximum: 5},
    }),
  },
];

// A structured page observation ("Page URL: …\n{json}") puts the rendered text
// first and the action maps last, so a plain character slice of a long form
// page hides every targetId and controlId from the model. The first part of a
// large structured observation is an overview instead: all identifiers the
// model can act on, compact control entries and the beginning of the text.
// The complete text stays in the snapshot for browser_read_part/browser_search.
const PAGE_PREFIX = /^Page URL: [^\n]*\n/;
const OVERVIEW_NOTICE =
  'Large page: this overview carries the current clickTargets/controls ids and the start of the text. Use browser_search(snapshotId, phrase) or browser_read_part(snapshotId, offset: 0) for the full text and full lists. Reading parts costs no browser step.';
const CONTROL_KEYS = [
  'controlId',
  'label',
  'role',
  'required',
  'visible',
  'fieldId',
  'recommendedTool',
  'nativeSelect',
  'autocomplete',
  'choice',
  'checked',
];
const compactControl = (control) => {
  const out = {};
  for (const key of CONTROL_KEYS) if (control[key] !== undefined) out[key] = control[key];
  if (typeof control.value === 'string' && control.value) out.value = control.value.slice(0, 60);
  return out;
};
// Option entries (radio, checkbox, listbox options) are plentiful and already
// grouped by browser_jev_inspect_form; buttons, links and text controls stay
// first when a list must be cut.
const OPTION_ROLES = new Set(['radio', 'checkbox', 'option', 'menuitemradio', 'menuitemcheckbox']);
const isOption = (item) => Boolean(item?.choice) || OPTION_ROLES.has(item?.role);
const capped = (items, limit) => {
  if (!Array.isArray(items) || items.length <= limit) return {items, omitted: 0};
  const kept = [...items.filter((i) => !isOption(i)), ...items.filter(isOption)].slice(0, limit);
  return {items: kept, omitted: items.length - limit};
};
function overviewPart(result, text, snapshot) {
  const prefix = text.match(PAGE_PREFIX)?.[0] ?? '';
  let page;
  try {
    page = JSON.parse(text.slice(prefix.length));
  } catch {
    return null;
  }
  if (!page || typeof page !== 'object' || Array.isArray(page)) return null;
  if (!Array.isArray(page.clickTargets) && !Array.isArray(page.controls)) return null;
  // Start from the small scalar state, then add the heavy sections greedily in
  // priority order: action ids first, the text head last. viewportText and the
  // elements duplicate are never repeated here; the raw snapshot keeps them.
  const {
    text: pageText,
    viewportText,
    links,
    clickTargets,
    controls,
    elements,
    history,
    embeddedForms,
    reading,
    verificationDiagnostics,
    fillFields,
    listing,
    ...base
  } = page;
  void viewportText;
  void elements;
  const wrap = (overview) => ({
    ...result,
    content: [{type: 'text', text: prefix + JSON.stringify({...overview, overview: true})}],
    snapshot: {...snapshot, endOffset: 0, nextOffset: 0, complete: false},
    notice: OVERVIEW_NOTICE,
  });
  const fits = (overview) => size(wrap(overview)) <= BROWSER_RESPONSE_BYTES;
  let overview = base;
  if (!fits(overview)) return null;
  const tryAdd = (extra) => {
    if (fits({...overview, ...extra})) overview = {...overview, ...extra};
  };
  const addCapped = (key, items, limits, map = (i) => i) => {
    if (!Array.isArray(items)) return;
    for (const limit of limits) {
      const {items: kept, omitted} = capped(items.map(map), limit);
      const extra = {[key]: kept, ...(omitted ? {[key + 'Omitted']: omitted} : {})};
      if (fits({...overview, ...extra})) {
        overview = {...overview, ...extra};
        return;
      }
    }
  };
  const addText = (lengths) => {
    if (typeof pageText !== 'string') return;
    for (const length of lengths) {
      if ((overview.text?.length ?? -1) >= length) return;
      const extra = {
        text: pageText.slice(0, length),
        ...(pageText.length > length ? {textTruncated: true} : {}),
      };
      if (fits({...overview, ...extra})) {
        overview = {...overview, ...extra};
        return;
      }
    }
  };
  addCapped('fillFields', fillFields, [Infinity, 60, 30, 15]);
  addCapped('clickTargets', clickTargets, [Infinity, 120, 80, 60, 30, 15]);
  // A short text head always travels with the ids: the model must be able to
  // see a confirmation or error line without a second read.
  addText([600, 300, 120]);
  addCapped('controls', controls, [Infinity, 120, 80, 40, 20, 10], compactControl);
  if (reading) tryAdd({reading});
  if (Array.isArray(history)) tryAdd({history: history.slice(-4)});
  if (Array.isArray(embeddedForms)) tryAdd({embeddedForms: embeddedForms.slice(0, 5)});
  if (verificationDiagnostics) tryAdd({verificationDiagnostics});
  addText([2500, 1200]);
  addCapped('links', links, [20, 10, 5], ({text: label, url}) => ({text: label, url}));
  if (listing !== undefined) tryAdd({listing});
  return wrap(overview);
}

// Each workflow owns its own cache. IDs cannot read another run's pages; a new
// observation, navigation or attempted interaction invalidates the old one.
export class BrowserSnapshot {
  invalidate() {
    this.current = null;
  }
  capture(result) {
    const content = result.content ?? [],
      text = content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
    const snapshotId = randomUUID();
    this.current = {
      id: snapshotId,
      url: result.url,
      text,
      ...(result.readiness ? {readiness: result.readiness} : {}),
      ...(result.pageNavigation ? {pageNavigation: result.pageNavigation} : {}),
    };
    const snapshot = {
      id: snapshotId,
      totalCharacters: text.length,
      offset: 0,
      endOffset: text.length,
      nextOffset: null,
      complete: true,
    };
    const full = {...result, snapshot};
    if (size(full) <= BROWSER_RESPONSE_BYTES) return full;
    const omitted = content.filter((p) => p.type !== 'text').map((p) => p.type);
    const page = overviewPart(result, text, snapshot) ?? this.read({snapshotId});
    if (omitted.length) page.omittedContentTypes = [...new Set(omitted)];
    return page;
  }
  get(id) {
    if (!this.current || this.current.id !== id)
      throw Error(
        'The page observation is stale or does not belong to this run. Continue with snapshot.id from the last response; if needed, read the current page with browser_read.',
      );
    return this.current;
  }
  read({snapshotId, offset = 0, limit = BROWSER_PART_CHARACTERS}) {
    const page = this.get(snapshotId);
    if (!integer(offset, 0, page.text.length) || !integer(limit, 1, BROWSER_PART_CHARACTERS))
      throw Error('Invalid page range. Use the returned nextOffset value.');
    const build = (end) => ({
      url: page.url,
      ...(page.readiness ? {readiness: page.readiness} : {}),
      ...(page.pageNavigation ? {pageNavigation: page.pageNavigation} : {}),
      content: [{type: 'text', text: page.text.slice(offset, end)}],
      snapshot: {
        id: page.id,
        totalCharacters: page.text.length,
        offset,
        endOffset: end,
        nextOffset: end < page.text.length ? end : null,
        complete: offset === 0 && end === page.text.length,
      },
      ...(offset > 0 || end < page.text.length
        ? {
            notice:
              'This is one part of the saved page. Use browser_read_part(snapshotId, offset: nextOffset) for the rest and browser_search for specific content. Reading parts does not use a browser step; you have not read the whole page yet.',
          }
        : {}),
    });
    let end = Math.min(page.text.length, offset + limit);
    // Preserve readable lines when possible, while retaining an exact cursor for
    // single enormous lines and snapshots containing serialized JSON.
    const line = page.text.lastIndexOf('\n', end - 1);
    if (end < page.text.length && line >= offset + Math.floor(limit / 2)) end = line + 1;
    while (size(build(end)) > BROWSER_RESPONSE_BYTES && end > offset + 1)
      end = offset + Math.max(1, Math.floor((end - offset) * 0.75));
    if (
      end < page.text.length &&
      end > offset + 1 &&
      /[\uD800-\uDBFF]/.test(page.text[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(page.text[end])
    )
      end--;
    return build(end);
  }
  search({snapshotId, query, offset = 0, limit = 5}) {
    const page = this.get(snapshotId);
    if (
      typeof query !== 'string' ||
      !query.trim() ||
      query.length > 200 ||
      !integer(offset, 0, page.text.length) ||
      !integer(limit, 1, 5)
    )
      throw Error('Invalid page search. Use a short text and a valid offset.');
    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    pattern.lastIndex = offset;
    const matches = [];
    let match,
      nextOffset = null;
    while ((match = pattern.exec(page.text))) {
      if (matches.length === limit) {
        nextOffset = match.index;
        break;
      }
      const start = Math.max(0, match.index - 200),
        end = Math.min(page.text.length, match.index + match[0].length + 400);
      matches.push({
        offset: match.index,
        endOffset: match.index + match[0].length,
        contextOffset: start,
        text: page.text.slice(start, end),
      });
    }
    const result = {
      url: page.url,
      snapshotId: page.id,
      totalCharacters: page.text.length,
      query,
      matches,
      nextOffset,
      cached: true,
    };
    while (size(result) > BROWSER_RESPONSE_BYTES && matches.length > 1) {
      result.nextOffset = matches.pop().offset;
    }
    return result;
  }
}
