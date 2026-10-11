import {boundedText, webUrl} from '../app/templates/catalog.mjs';

// An interview can start with an incomplete plan. Source requests are conversation
// context; only actual web addresses become runnable automation sources.
export function prepareAutomationChat(message, draft) {
  const text = boundedText(message, 'Message', 12000);
  if (!draft) return {message: text, draft: null};
  if (!Object.hasOwn(draft, 'sources')) return {message: text, draft};
  const sources = [],
    notes = [];
  for (const source of draft.sources) {
    try {
      new URL(source);
    } catch {
      notes.push(source);
      continue;
    }
    sources.push(webUrl(source));
  }
  const context = notes.length
    ? '\n\nMy source request (not yet a verified web address):\n' + notes.join('\n')
    : '';
  return {
    message: boundedText(text + context, 'Message and source notes', 12000),
    draft: {...draft, sources},
  };
}
