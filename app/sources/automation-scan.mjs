// @ts-check
import {webUrl, boundedText} from '../templates/catalog.mjs';

// URLs come from the browser response, never from an agent-created page number.
export function observedLinks(response, pageUrl) {
  const text = (response.content ?? [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n'),
    links = new Set();
  const add = (value) => {
    try {
      links.add(webUrl(new URL(value, pageUrl).href));
    } catch {}
  };
  try {
    const page = JSON.parse(text.slice(text.indexOf('\n') + 1));
    for (const link of page.links ?? []) if (link.url) add(link.url);
  } catch {}
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\\]\)]+/g)) add(match[0]);
  for (const match of text.matchAll(/\/url:\s*["']?([^\s"']+)/g)) add(match[1]);
  return [...links];
}

export function scanCheckpoint(run, input, {checkpoint = false} = {}) {
  if (run.kind !== 'run' || !run.sourceUrl || run.recordId)
    throw Error('Scan coverage belongs only to a source task');
  if (!input || typeof input.complete !== 'boolean' || !Array.isArray(input.pendingUrls))
    throw Error('Scan coverage required: complete, pendingUrls, reason, evidenceUrl');
  const pendingUrls = [...new Set(input.pendingUrls.map(webUrl))];
  // A source can discover an employer board on another host. Ownership is the
  // assigned run, not the marketing site's origin; guessed URLs remain invalid.
  const known = new Set([
    run.sourceUrl,
    ...(run.observedLinks ?? []),
    ...(run.navigation ?? []).map((n) => n.url),
    ...(run.scan?.pendingUrls ?? []),
  ]);
  if (pendingUrls.some((url) => !known.has(url)))
    throw Error(
      'Continuation addresses must be links actually observed in this task; do not guess URLs',
    );
  const evidenceUrl = webUrl(input.evidenceUrl),
    reason = boundedText(input.reason, 'Coverage reason', 2000);
  if (!(run.navigation ?? run.observations ?? []).some((o) => o.url === evidenceUrl))
    throw Error(
      'Open the evidence page (evidenceUrl) in this turn before reporting scan coverage.',
    );
  if (input.complete && pendingUrls.length)
    throw Error('A scan cannot be called complete while pages or listings are pending');
  if (!checkpoint && !input.complete && !pendingUrls.length)
    throw Error(
      'In a partial scan, save the remaining page/listing links; if you cannot proceed, report the blocker',
    );
  if (
    !checkpoint &&
    !input.complete &&
    JSON.stringify([...pendingUrls].sort()) ===
      JSON.stringify([...(run.scan?.pendingUrls ?? [])].sort())
  )
    throw Error(
      'The continuation point did not advance. Process the remaining pages or report the actual blocker; do not queue the same work again',
    );
  return {
    ...run.scan,
    complete: input.complete,
    pendingUrls,
    reason,
    evidenceUrl,
    ...(input.completion ? {completion: input.completion} : {}),
  };
}
