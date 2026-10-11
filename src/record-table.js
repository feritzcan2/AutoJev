// Shared table structure and typed values. Templates supply record-specific cells
// and actions, so existing application controls keep their behavior.
export function recordTable(
  columns,
  {className = 'jobs-table', header, scrollLeft = 0, onScroll = () => {}, onLayout = () => {}} = {},
) {
  const wrap = document.createElement('div');
  wrap.className = 'jobs-table-wrap';
  const table = document.createElement('table');
  table.className = className;
  const head = document.createElement('thead'),
    row = document.createElement('tr'),
    body = document.createElement('tbody');
  for (const column of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.dataset.column = column.key ?? 'actions';
    th.textContent = column.label;
    header?.(th, column);
    row.append(th);
  }
  head.append(row);
  table.append(head, body);
  wrap.append(table);
  const element = document.createElement('div'),
    controls = document.createElement('div'),
    hint = document.createElement('span'),
    navigation = document.createElement('div'),
    left = document.createElement('button'),
    right = document.createElement('button'),
    position = document.createElement('input'),
    frame = document.createElement('div');
  element.className = 'record-table-scroller';
  controls.className = 'record-table-scroll-controls';
  controls.hidden = true;
  hint.className = 'record-table-scroll-hint';
  navigation.className = 'record-table-scroll-navigation';
  frame.className = 'record-table-scroll-frame';
  left.type = right.type = 'button';
  left.className = right.className = 'quiet';
  left.textContent = '←';
  right.textContent = '→';
  left.setAttribute('aria-label', 'Scroll the table left');
  right.setAttribute('aria-label', 'Scroll the table right');
  position.type = 'range';
  position.min = '0';
  position.step = '1';
  position.setAttribute('aria-label', 'Horizontal scroll position of the table');
  navigation.append(left, position, right);
  controls.append(hint, navigation);
  frame.append(wrap);
  element.append(controls, frame);
  const update = () => {
    const max = Math.max(0, wrap.scrollWidth - wrap.clientWidth),
      overflow = wrap.clientWidth > 0 && max > 2,
      at = wrap.scrollLeft;
    controls.hidden = !overflow;
    wrap.tabIndex = overflow ? 0 : -1;
    wrap.setAttribute(
      'aria-label',
      'Tracking table' + (overflow ? ' · scroll horizontally for more columns' : ''),
    );
    element.dataset.left = String(overflow && at > 2);
    element.dataset.right = String(overflow && at < max - 2);
    left.disabled = at <= 2;
    right.disabled = at >= max - 2;
    position.max = String(max);
    position.value = String(at);
    position.setAttribute('aria-valuetext', `${Math.round(max ? (at / max) * 100 : 0)}%`);
    // A column pinned to the right edge covers the columns scrolled beneath it.
    const bounds = wrap.getBoundingClientRect(),
      pinned = new Set([...row.cells].filter((c) => getComputedStyle(c).position === 'sticky')),
      cells = [...row.cells].filter((c) => !pinned.has(c)),
      visibleRight = Math.min(
        bounds.right,
        ...[...pinned]
          .filter((c) => getComputedStyle(c).right !== 'auto')
          .map((c) => c.getBoundingClientRect().left),
      ),
      before = cells.filter((c) => c.getBoundingClientRect().left < bounds.left - 2).length,
      after = cells.filter((c) => c.getBoundingClientRect().right > visibleRight + 2).length;
    hint.textContent = [
      before ? `${before} column${before === 1 ? '' : 's'} to the left` : '',
      after ? `${after} column${after === 1 ? '' : 's'} to the right` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    hint.title = 'Use the arrows or the scroll bar to see all columns.';
    onLayout();
  };
  const move = (direction) =>
    wrap.scrollBy({
      left: direction * Math.max(240, wrap.clientWidth * 0.65),
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  left.onclick = () => move(-1);
  right.onclick = () => move(1);
  position.oninput = () => {
    wrap.scrollLeft = Number(position.value);
  };
  wrap.addEventListener(
    'scroll',
    () => {
      update();
      onScroll(wrap.scrollLeft);
    },
    {passive: true},
  );
  const observer = new ResizeObserver(update);
  observer.observe(wrap);
  observer.observe(table);
  const frameId = requestAnimationFrame(() => {
    wrap.scrollLeft = scrollLeft;
    update();
  });
  return {
    wrap,
    element,
    table,
    body,
    dispose: () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
    },
  };
}
export function recordCell(column, value, {openLink}) {
  const cell = document.createElement('td');
  cell.dataset.column = column.key;
  if (value == null || value === '') {
    cell.textContent = '—';
    return cell;
  }
  if (column.type === 'url') {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'quiet';
    link.textContent = 'Open ↗';
    link.onclick = () => openLink(value);
    cell.append(link);
  } else if (['number', 'money'].includes(column.type) && Number.isFinite(Number(value))) {
    cell.textContent = Number(value).toLocaleString('en-GB', {
      minimumFractionDigits: column.type === 'money' ? 2 : 0,
      maximumFractionDigits: 2,
    });
    cell.className = 'automation-number-cell';
  } else {
    const text = document.createElement('span');
    text.className = 'automation-cell-text';
    text.textContent = String(value);
    text.title = String(value);
    cell.append(text);
  }
  return cell;
}
export const recordState = (record, definition) => {
  const id = record.workflowState ?? record.status;
  return {id, label: definition?.records?.states.find((s) => s.id === id)?.label ?? id};
};
export function recordActions(container, record, definition, onAction) {
  for (const action of definition?.records?.actions ?? []) {
    if (!action.from.includes(record.workflowState ?? record.status)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet';
    button.textContent = action.label;
    button.dataset.recordAction = action.id;
    button.onclick = async () => {
      button.disabled = true;
      try {
        await onAction(action.id);
      } finally {
        button.disabled = false;
      }
    };
    container.append(button);
  }
}
