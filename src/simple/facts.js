// "Label: value" lines inside the free-text profile fields. The app writes a
// few of its own lines (quick answers, never-apply list, what it learned from
// skips) and keeps everything else the user or the AI wrote untouched.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineRe = (label) => new RegExp('^\\s*' + escape(label) + '\\s*:\\s*(.*)$', 'im');

export const NEVER = 'Never apply to';
export const LESS = 'Less of';

export const factLine = (text, label) =>
  String(text ?? '')
    .match(lineRe(label))?.[1]
    .trim() ?? '';

export function setFactLine(text, label, value) {
  const lines = String(text ?? '')
    .split('\n')
    .filter((line) => !lineRe(label).test(line));
  if (value) lines.push(`${label}: ${value}`);
  return lines.join('\n').trim();
}

// A line as a list, and back. Learned items can hold commas (job titles), so
// that line is split on semicolons; the never-apply list uses commas.
const separator = (label) => (label === LESS ? ';' : ',');
export const listOf = (text, label) =>
  factLine(text, label)
    .split(separator(label))
    .map((item) => item.trim())
    .filter(Boolean);
export const withItem = (items, item, label) =>
  [...items.filter((x) => x.toLowerCase() !== item.toLowerCase()), item].join(
    separator(label) + ' ',
  );
export const withoutItem = (items, item, label) =>
  items.filter((x) => x.toLowerCase() !== item.toLowerCase()).join(separator(label) + ' ');

// Up to three short facts from the experience the AI saved, for the CV echo.
export function cvFacts(experience) {
  return String(experience ?? '')
    .split(/\n|;|·|\.\s/)
    .map((part) => part.trim().replace(/\.$/, ''))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .filter((part) => part.length > 3 && !/^languages?\s*:/i.test(part))
    .slice(0, 3)
    .map((part) => {
      const cut = part.search(/,|\s[–—-]\s/);
      if (cut <= 8 || cut >= part.length - 4) return {lead: part, rest: ''};
      return part[cut] === ','
        ? {lead: part.slice(0, cut + 1), rest: part.slice(cut + 1).trim()}
        : {lead: part.slice(0, cut), rest: part.slice(cut).replace(/^\s*[–—-]\s*/, '')};
    });
}
