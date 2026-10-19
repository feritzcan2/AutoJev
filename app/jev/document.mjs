import {readSiteExtension} from '../site-extensions/index.mjs';
import {jobPostingListing} from '../site-extensions/job-posting.mjs';
import {setTimeout as sleep} from 'node:timers/promises';
import {acquireTabRendering} from './rendering.mjs';

// Executed in the page. Read rendered DOM content without scrolling, clicking,
// form values or hidden application state. Unlike the action snapshot, reading
// is not limited to the viewport. The automation layer paginates this result.
export function renderedDocument() {
  const body = document.body;
  if (!body) return {url: location.href, text: '', links: []};
  const words = [],
    links = [],
    pagination = [],
    seenLinks = new Set(),
    range = document.createRange(),
    cards = new Map();
  const stack = [body];
  while (stack.length) {
    const node = stack.pop();
    if (node.cardEnd) {
      node.cardEnd.end = words.length;
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      range.selectNodeContents(node);
      if ([...range.getClientRects()].some((r) => r.width > 0 && r.height > 0)) words.push(text);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const e = node;
    if (
      e.matches(
        'script,style,noscript,template,input,textarea,select,[hidden],[aria-hidden="true"],[inert]',
      )
    )
      continue;
    const style = getComputedStyle(e);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      Number(style.opacity) === 0
    )
      continue;
    // Keep source offsets for semantic listing cards. The text still comes from
    // this visibility-aware walk, never innerText/hidden markup/form values.
    if (e.matches('article,li,[role="listitem"]')) {
      const card = {start: words.length, links: []};
      cards.set(e, card);
      stack.push({cardEnd: card});
    }
    // Closed details render only their summary. Do not include collapsed content.
    if (e.tagName === 'DETAILS' && !e.open) {
      const summary = [...e.children].find((c) => c.tagName === 'SUMMARY');
      if (summary) stack.push(summary);
      continue;
    }
    // Google and similar boards render the current page as plain text, not a
    // link. Only accept a visible numeric leaf in a named pagination region.
    if (
      (!e.children.length || e.getAttribute('aria-current') === 'page') &&
      !e.closest('a,button,[role="button"],[role="link"]')
    ) {
      const region = e.closest(
        'nav,[role="navigation"],[class*="pagination" i],[data-testid*="pagination" i]',
      );
      const regionLabel = region
        ? [
            region.getAttribute('aria-label'),
            region.className,
            region.getAttribute('data-testid'),
          ].join(' ')
        : '';
      if (
        (e.getAttribute('aria-current') === 'page' ||
          (region && /pagin|page|sayfa|seiten/i.test(regionLabel))) &&
        [...e.getClientRects()].some((r) => r.width > 0 && r.height > 0)
      ) {
        const label = (e.getAttribute('aria-label') || e.innerText || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (/^(?:page\s+|seite\s+|sayfa\s+)?\d+(?:\s*(?:of|von|\/|sur)\s*\d+)?$/i.test(label))
          pagination.push({text: label, url: null, current: true, disabled: false, kind: 'text'});
      }
    }
    if (
      e.matches('a,button,[role="button"],[role="link"]') &&
      [...e.getClientRects()].some((r) => r.width > 0 && r.height > 0)
    ) {
      const text = (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim(),
        rel = e.getAttribute('rel') ?? '';
      const region = e.closest(
        'nav,[role="navigation"],[class*="pagination" i],[data-testid*="pagination" i]',
      );
      const regionLabel = region
        ? [
            region.getAttribute('aria-label'),
            region.className,
            region.getAttribute('data-testid'),
          ].join(' ')
        : '';
      if (
        /\b(next|prev)\b/i.test(rel) ||
        (region &&
          (/pagin|sayfa|seiten/i.test(regionLabel) ||
            /^\d+$/.test(text) ||
            /^(next|previous|volgende|vorige|sonraki|önceki)\b/i.test(text)))
      ) {
        let url = null;
        try {
          const link = new URL(e.getAttribute('href'), location.href);
          if (
            e.hasAttribute('href') &&
            ['http:', 'https:'].includes(link.protocol) &&
            !link.username &&
            !link.password
          )
            url = link.href;
        } catch {}
        let scrollNode;
        for (let parent = e.parentElement; parent; parent = parent.parentElement) {
          if (
            parent.scrollHeight > parent.clientHeight + 2 &&
            /auto|scroll/.test(getComputedStyle(parent).overflowY)
          ) {
            scrollNode = window.__jevFast?.ids.get(parent);
            break;
          }
        }
        if (scrollNode === undefined)
          scrollNode = window.__jevFast?.ids.get(document.scrollingElement);
        pagination.push({
          text,
          url,
          rel,
          current: ['page', 'true'].includes(e.getAttribute('aria-current')),
          disabled: e.matches(':disabled,[aria-disabled="true"]'),
          kind: e.tagName === 'A' ? 'link' : 'button',
          node: window.__jevFast?.ids.get(e),
          scrollNode,
        });
      }
    }
    if (
      e.tagName === 'A' &&
      e.hasAttribute('href') &&
      [...e.getClientRects()].some((r) => r.width > 0 && r.height > 0)
    ) {
      let url;
      try {
        url = new URL(e.href, location.href);
      } catch {}
      if (url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
        const label = (e.getAttribute('aria-label') || e.innerText || '')
            .replace(/\s+/g, ' ')
            .trim(),
          key = JSON.stringify([url.href, label]);
        if (!seenLinks.has(key)) {
          seenLinks.add(key);
          const link = {text: label, url: url.href};
          links.push(link);
          cards.get(e.closest('article,li,[role="listitem"]'))?.links.push(link);
        }
        // Place the real link next to its card text as well as in the link index.
        words.push(`Link: ${label ? label + ' — ' : ''}${url.href}`);
      } else if (url?.protocol === 'mailto:') {
        // An email link opens the mail app, not a page; name its address.
        const label = (e.getAttribute('aria-label') || e.innerText || '')
          .replace(/\s+/g, ' ')
          .trim();
        words.push(`Email link: ${label ? label + ' — ' : ''}${decodeURIComponent(url.pathname)}`);
      }
    }
    const assigned = e.tagName === 'SLOT' ? e.assignedNodes({flatten: true}) : [];
    const children = assigned.length ? assigned : (e.shadowRoot?.childNodes ?? e.childNodes);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  // Streaming render fragments are not listings until the site reveals them.
  // Report only readiness metadata; never expose the hidden fragment contents.
  const pendingFragments = body.querySelectorAll('[hidden][id^="S:"]').length;
  const busyRegions = [...body.querySelectorAll('[aria-busy="true"]')].filter(
      (e) =>
        !e.closest('[hidden],[aria-hidden="true"],[inert]') &&
        e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}),
    ),
    busy = busyRegions.length > 0;
  const loading = document.readyState === 'loading' || pendingFragments > 0 || busy;
  const offsets = [0];
  for (const word of words) offsets.push(offsets.at(-1) + word.length + 1);
  for (const card of cards.values())
    for (const link of card.links)
      if (card.end > card.start)
        link.contextRange = {
          offset: offsets[card.start],
          length: offsets[card.end] - offsets[card.start] - 1,
        };
  let canonicalUrl;
  const canonicals = [...document.querySelectorAll('head link[rel~="canonical"][href]')];
  if (!loading && canonicals.length === 1)
    try {
      const u = new URL(canonicals[0].href, location.href);
      if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !location.hash)
        canonicalUrl = u.href;
    } catch {}
  // Structured listing data (schema.org JobPosting) and the shown headings it
  // must match; read only when present to keep the transfer small. Browser
  // translation rewrites headings but not the page's own title metadata, which
  // then stands in for them.
  const jobPostings = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => s.textContent ?? '')
    .filter((t) => t.includes('JobPosting'));
  const translated = /\btranslated-(?:ltr|rtl)\b/.test(document.documentElement.className);
  return {
    url: location.href,
    text: words.join('\n'),
    links,
    pagination,
    canonicalUrl,
    ...(jobPostings.length
      ? {
          jobPostings,
          title: document.title,
          headings: [
            ...[...body.querySelectorAll('h1')].map((h) => h.innerText.trim()).slice(0, 5),
            ...(translated
              ? [
                  ...document.querySelectorAll(
                    'meta[property="og:title"],meta[name="og:title"],meta[name="twitter:title"]',
                  ),
                ].map((m) => m.getAttribute('content') ?? '')
              : []),
          ],
        }
      : {}),
    readiness: {
      loading,
      reason: pendingFragments
        ? 'stream_pending'
        : busy
          ? 'aria_busy'
          : loading
            ? 'document_loading'
            : null,
      ...(busy && !pendingFragments && document.readyState !== 'loading'
        ? {
            busyKey: [
              busyRegions.length,
              body.textContent?.length ?? 0,
              document.links?.length ?? 0,
              globalThis.performance?.getEntriesByType?.('resource').length ?? 0,
            ].join(':'),
          }
        : {}),
    },
  };
}

// Keep the full viewport when it contains anything absent from document text
// (for example a form value or frame). Only whitespace-equivalent duplicates
// can be omitted; this is not a summary of the page.
export function documentViewportText(documentText, viewportText = '') {
  const normalized = documentText.replace(/\s+/g, ' ').trim();
  return viewportText
    .split('\n')
    .every((line) => normalized.includes(line.replace(/\s+/g, ' ').trim()))
    ? ''
    : viewportText;
}

export async function documentObservation(slot, value) {
  const readiness = settledBusy(slot, await slot.page.evaluate(documentReadiness));
  const {siteListing, ...document} = await readSiteExtension(
    slot,
    await slot.page.evaluate(renderedDocument),
  );
  if (document.readiness)
    document.readiness = settledBusy(slot, {url: document.url, ...document.readiness});
  if (document.url !== value.url || (readiness.url && readiness.url !== document.url))
    throw Error(
      'The page redirected while being read; read the current page again with browser_read.',
    );
  // The page's own structured listing; Jev's evidence uses it instead of the
  // rendered text with its site chrome. A loading page is not read from it.
  // A site's own posting reader (dom.listing) comes before the structured data.
  const listing =
    document.readiness?.loading || readiness.loading
      ? null
      : (siteListing ?? jobPostingListing(document));
  // Join by the observed DOM node, never a repeated label such as "Next".
  // Offscreen buttons may only have a reveal control; no target is invented.
  const targets = new Map(
    [...(slot.clickTargets ?? [])]
      .filter(([, t]) => t.owner === slot.owner)
      .map(([id, t]) => [t.action.node, id]),
  );
  const controls = new Map(
    [...(slot.controls ?? [])]
      .filter(([, c]) => c.owner === slot.owner && c.kind === 'control')
      .map(([id, c]) => [c.node, id]),
  );
  const scrolls = new Map(
    [...(slot.controls ?? [])]
      .filter(([, c]) => c.owner === slot.owner && c.kind === 'scroll')
      .map(([id, c]) => [c.node, id]),
  );
  const pagination = (document.pagination ?? []).map(({node, scrollNode, ...p}) => ({
    ...p,
    ...(targets.has(node) && value.clickTargets?.some((t) => t.targetId === targets.get(node))
      ? {targetId: targets.get(node)}
      : {}),
    ...(controls.has(node) && value.controls?.some((c) => c.controlId === controls.get(node))
      ? {controlId: controls.get(node)}
      : {}),
    ...(scrolls.has(scrollNode) &&
    value.scrollTargets?.some((c) => c.controlId === scrolls.get(scrollNode))
      ? {scrollControlId: scrolls.get(scrollNode)}
      : {}),
  }));
  let unreadFrames = 0;
  for (const frame of slot.page.frames().slice(1)) {
    let element;
    try {
      element = await frame.frameElement();
      if (
        await element.evaluate(
          (e) =>
            e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) &&
            e.getBoundingClientRect().width > 1 &&
            e.getBoundingClientRect().height > 1,
        )
      )
        unreadFrames++;
    } catch {
      unreadFrames++;
    } finally {
      await element?.dispose().catch(() => {});
    }
  }
  const result = {
    ...value,
    observationMode: 'document',
    controlMaps: 'replace',
    mapDeltas: false,
    viewportText: documentViewportText(document.text, value.text ?? slot.presented?.text ?? ''),
    text: document.text,
    links: document.links,
    pagination,
    canonicalUrl: document.canonicalUrl,
    ...(document.siteExtension ? {siteExtension: document.siteExtension} : {}),
    ...(document.paginationBy ? {paginationBy: document.paginationBy} : {}),
    ...(listing ? {listing} : {}),
    reading: {
      scope: 'rendered_document',
      truncated: false,
      readiness: document.readiness?.loading
        ? document.readiness
        : typeof readiness.loading === 'boolean'
          ? readiness
          : document.readiness,
      unreadFrames,
      guidance:
        'Includes currently rendered main-document text and actual links below the fold, including open shadow roots. Hidden content, form values and iframe contents are excluded. Lazy or virtualized listings may require browser_interact scroll with a current scrollTargets.controlId, then another read. No guessed URLs. Read details through observed links when list cards omit addresses. An absent address remains unknown.',
    },
  };
  delete result.textUnchanged;
  // These complete current maps already represent the actionable elements.
  // The browser retains its original snapshot for guarded next/act decisions.
  if (Array.isArray(result.controls) && Array.isArray(result.clickTargets)) delete result.elements;
  // Action IDs come from the current guarded viewport snapshot. Document links
  // are reading/navigation evidence, never a replacement click target map.
  return result;
}

// Transport/rendering signals are site-independent. A ready document can
// still be a shell: the detail task separately checks the requested content.
export function documentReadiness() {
  const visible = (e) =>
    !e.closest('[hidden],[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true});
  const url = location.href,
    body = document.body;
  const result = (reason) => ({
    url,
    loading: Boolean(reason),
    reason,
    hidden: document.visibilityState === 'hidden',
  });
  // A freshly loaded document can still add content (choices, buttons) after
  // its first render; its age and content size let the wait see it settle.
  const age = globalThis.performance?.now?.();
  if (!body || document.readyState === 'loading') return result('document_loading');
  if (body.querySelector('[hidden][id^="S:"]')) return result('stream_pending');
  const busy = [...body.querySelectorAll('[aria-busy="true"]')].filter(visible);
  // The key changes while text, links or network requests still change.
  if (busy.length)
    return {
      ...result('aria_busy'),
      busyKey: [
        busy.length,
        body.textContent?.length ?? 0,
        document.links?.length ?? 0,
        globalThis.performance?.getEntriesByType?.('resource').length ?? 0,
      ].join(':'),
    };
  if (age < 4000)
    return {
      ...result(null),
      age,
      contentKey: [body.getElementsByTagName?.('*').length, body.textContent?.length].join(':'),
    };
  return result(null);
}

// A document younger than 4 seconds is read once its content stayed unchanged
// for QUIET_DOCUMENT_MS; an older document is read right away.
export const QUIET_DOCUMENT_MS = 750;

// A busy marker that stays set while the page around it stops changing belongs
// to a stuck widget, not to content still loading. Only that exact unchanged
// state is read; any new text, link or request makes the page busy again.
export const SETTLED_BUSY_MS = 5000;
function settledBusy(slot, state) {
  const settled = slot.settledBusy;
  return state?.reason === 'aria_busy' &&
    state.busyKey &&
    settled?.url === state.url &&
    settled.key === state.busyKey
    ? {...state, loading: false, reason: null, settledBusy: true}
    : state;
}

export async function waitForDocument(
  slot,
  {
    signal,
    attempts = 81,
    delay = 250,
    wait = (ms) => sleep(ms, undefined, {signal}),
    now = Date.now,
  } = {},
) {
  let releaseRendering;
  try {
    let busy = null,
      quiet = null;
    for (let i = 0; i < attempts; i++) {
      signal?.throwIfAborted();
      const state = settledBusy(slot, await slot.page.evaluate(documentReadiness));
      signal?.throwIfAborted();
      if (!state.loading && state.contentKey !== undefined && i + 1 < attempts) {
        if (quiet?.url !== state.url || quiet.key !== state.contentKey)
          quiet = {url: state.url, key: state.contentKey, since: now()};
        if (now() - quiet.since < QUIET_DOCUMENT_MS) {
          await wait(delay);
          continue;
        }
      }
      if (!state.loading) {
        slot.documentWait = null;
        return state;
      }
      if (state.reason === 'aria_busy' && state.busyKey) {
        if (busy?.url !== state.url || busy.key !== state.busyKey)
          busy = {url: state.url, key: state.busyKey, since: now()};
        else if (now() - busy.since >= SETTLED_BUSY_MS) {
          slot.settledBusy = {url: busy.url, key: busy.key};
          slot.documentWait = null;
          return settledBusy(slot, state);
        }
      } else busy = null;
      if (slot.documentWait?.url === state.url && slot.documentWait.until > now())
        return {...state, timedOut: true};
      // Existing Chrome connections use noDefaults:true. A background tab can
      // otherwise pause requestAnimationFrame forever, leaving streamed content
      // hidden even after the response finishes. Enable Chrome's own rendering
      // only for this owned tab during the wait; never reveal DOM or focus a window.
      if (state.hidden && slot.cdp && !releaseRendering) {
        releaseRendering = await acquireTabRendering(slot, {signal, hidden: true});
      }
      // Open + document observation share one bounded wait; neither reloads the
      // page. A later independent read can try again in the same tab.
      if (i + 1 === attempts) {
        slot.documentWait = {url: state.url, until: now() + 1000};
        return {...state, timedOut: true};
      }
      await wait(delay);
    }
  } finally {
    await releaseRendering?.();
  }
}
