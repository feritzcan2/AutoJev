// Small DOM helpers for the simple view.
export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
export function button(label, onclick, cls = 'jl-btn') {
  const node = el('button', cls, label);
  node.type = 'button';
  node.onclick = onclick;
  return node;
}
const paths = {
  jobs: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/>',
  question:
    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.2-2.5 3.9M12 17.2v.3"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  settings:
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
};
export function icon(name, size = 18) {
  const span = el('span');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ''}</svg>`;
  return span;
}
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function scoreOf(record) {
  const value = record?.assessment?.score ?? record?.cells?.score;
  const n = value === '' || value == null ? NaN : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}
export function relative(value) {
  const at = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((at - Date.now()) / 60000),
    abs = Math.abs(minutes),
    text =
      abs < 1
        ? 'now'
        : abs < 60
          ? `${abs} min`
          : abs < 1440
            ? `${Math.round(abs / 60)} h`
            : `${Math.round(abs / 1440)} d`;
  if (text === 'now') return 'just now';
  return minutes > 0 ? 'in ' + text : text + ' ago';
}
export function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
