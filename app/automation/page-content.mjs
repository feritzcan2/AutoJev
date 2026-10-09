// @ts-check
import {webUrl} from '../templates/catalog.mjs';

export function pageObservation(result) {
  if (result?.isError) return null;
  const text = (result?.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const match = text.match(/(?:Page URL:|URL:)\s*(https?:\/\/[^\s\n<>]+)/i);
  return match ? {url: match[1], evidence: text.slice(-6000)} : null;
}
export function researchUrl(value) {
  const normalized = webUrl(value),
    host = new URL(normalized).hostname;
  if (
    !host.includes('.') ||
    /^[\d.]+$/.test(host) ||
    host.startsWith('[') ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
  )
    throw Error('Kaynak araştırmasında herkese açık bir web alan adı gerekli');
  return normalized;
}
// Compare the rendered page text (and links) with the previous snapshot. Jev
// control IDs change on every observation, so only the document text counts.
const parsePage = (text) => {
  const prefix = text.match(/^Page URL: [^\n]+\n/)?.[0] ?? '';
  try {
    return {prefix, page: JSON.parse(text.slice(prefix.length))};
  } catch {
    return null;
  }
};
export function unchangedPageContent(content, previous) {
  const parts = content.filter((p) => p.type === 'text');
  if (parts.length !== 1) return null;
  const current = parsePage(parts[0].text),
    before = parsePage(previous.text);
  if (!current || !before) {
    return parts[0].text === previous.text ? [{type: 'text', text: 'Page text unchanged.'}] : null;
  }
  if (
    typeof current.page.text !== 'string' ||
    current.page.text !== before.page.text ||
    JSON.stringify(current.page.links ?? null) !== JSON.stringify(before.page.links ?? null)
  )
    return null;
  const {text, links, ...rest} = current.page;
  return [
    {type: 'text', text: current.prefix + JSON.stringify({...rest, textUnchanged: true})},
    ...content.filter((p) => p.type !== 'text'),
  ];
}
