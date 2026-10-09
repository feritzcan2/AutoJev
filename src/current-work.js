import {currentWork} from '../app/automation/current-work.mjs';
import {elapsedLabel} from './activity.js';

const clock = (value) =>
  new Date(value).toLocaleTimeString('tr-TR', {hour: '2-digit', minute: '2-digit'});
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};

// "Şu anki işler": every running or waiting piece of work in one list.
export function renderCurrentWork(root, view, {stop}) {
  const rows = currentWork(view),
    list = el('div', null, 'run-list current-work-list');
  for (const row of rows) {
    const item = el('div', null, 'run-row');
    item.dataset.status = row.tone;
    const head = el('div', null, 'run-head');
    head.append(el('b', row.subject ? `${row.title} · ${row.subject}` : row.title));
    const when = row.startedAt
      ? elapsedLabel(new Date(row.startedAt).toISOString())
      : row.resumesAt
        ? `Devam: ${clock(row.resumesAt)}`
        : row.queuedAt
          ? `Eklendi: ${clock(row.queuedAt)}`
          : null;
    if (when) head.append(el('time', when));
    item.append(head);
    const meta = [row.worker, row.state].filter(Boolean).join(' · ');
    if (meta || row.stop) {
      const line = el('div', null, 'run-results');
      if (meta) line.append(el('span', meta));
      if (row.updatedAt) line.append(el('span', `Son sayfa ${clock(row.updatedAt)}`, 'run-tokens'));
      if (row.stop) {
        const button = el('button', 'Durdur', 'quiet current-work-stop');
        button.type = 'button';
        button.onclick = async () => {
          button.disabled = true;
          try {
            await stop(row.stop);
          } finally {
            button.disabled = false;
          }
        };
        line.append(button);
      }
      item.append(line);
    }
    if (row.progress) item.append(el('span', row.progress, 'run-summary'));
    list.append(item);
  }
  const title = el('div', null, 'section-title');
  title.append(el('h2', 'Şu anki işler'));
  root.replaceChildren(
    title,
    rows.length
      ? list
      : el('p', 'Şu anda çalışan veya bekleyen iş yok.', 'run-history-empty current-work-empty'),
  );
}
