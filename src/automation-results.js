import {eligibilityLabels, assessmentEligibility, oldScoringMethod} from './scoring-state.js';
import {recordTable, recordCell, recordState, recordActions} from './record-table.js';
import {
  recordOperationStatus,
  recordActivityAt,
  recordIsWorking,
  recordNeedsAnswer,
} from './record-operation-status.js';
import {recordTabs} from './workspace-tabs.js';
import {scoreBreakdown} from './score-breakdown.js';
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});
const source = (result) => {
  try {
    return new URL(result.url).hostname.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
};
const tabIdentity = (tabs) =>
  JSON.stringify(
    tabs
      .map(({tabId, recordId, runId}) => [tabId, recordId, runId])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
const menuControlKey = (control) => {
  for (const key of [
    'recordMenuAction',
    'recordOperation',
    'recordDirect',
    'recordDismiss',
    'recordAction',
  ])
    if (control?.dataset[key]) return key + ':' + control.dataset[key];
};
const positionMenu = (panel, toggle) => {
  const trigger = toggle.getBoundingClientRect(),
    width = panel.offsetWidth,
    height = panel.offsetHeight;
  panel.style.left = Math.max(8, Math.min(trigger.right - width, innerWidth - width - 8)) + 'px';
  panel.style.top =
    (trigger.bottom + height + 8 <= innerHeight
      ? trigger.bottom + 4
      : Math.max(8, trigger.top - height - 4)) + 'px';
};

export function automationResultsTable(
  root,
  {button, badge, time, api, refresh, statusNames, onQuestion = () => {}},
) {
  let data,
    busy = false,
    page = 1,
    sort = 'updatedAt',
    direction = -1,
    scrollLeft = 0,
    disposeTable = () => {};
  let batchSubmitting = null,
    selectionOwner = null;
  let tabOwner = null,
    liveTabs = [],
    liveTabIdentity = '[]',
    tabVersion = 0;
  // Frequent change notifications must not replace controls under the pointer:
  // the table stays mounted and only parts whose inputs changed are rebuilt.
  let mounted = null;
  const renderKeys = new WeakMap(),
    changed = (node, key) => renderKeys.get(node) !== key && (renderKeys.set(node, key), true),
    rows = new Map();
  const selectedIds = new Set(),
    expanded = new Set(),
    requests = new Set(),
    visibleTabButtons = new Map(),
    pageSize = 10;
  const review = el('dialog', null, 'automation-record-review'),
    reviewTitle = el('h2'),
    reviewSummary = el('p'),
    proposal = el('pre'),
    changes = el('textarea'),
    reviewError = el('p'),
    reviewActions = el('div', null, 'actions');
  const cancel = button('Cancel', () => review.close()),
    requestChanges = button('Request changes', () => {}),
    confirm = button('Approve and apply', () => {}, 'primary');
  changes.placeholder = 'What should change in the draft? (optional)';
  changes.maxLength = 2000;
  reviewError.setAttribute('role', 'alert');
  reviewActions.append(cancel, requestChanges, confirm);
  review.append(reviewTitle, reviewSummary, proposal, changes, reviewError, reviewActions);
  root.append(review);
  let reviewed = null,
    submitting = false;
  const sendOperation = async (result, kind, input = {}) => {
    const workspace = data.automation.id,
      key = workspace + ':' + result.id;
    if (requests.has(key)) return;
    requests.add(key);
    render();
    try {
      await api.automationRecordRun(workspace, result.id, kind, input);
      await refresh();
    } finally {
      requests.delete(key);
      render();
    }
  };
  const submitReview = async (kind, input) => {
    if (!reviewed || submitting) return;
    submitting = true;
    confirm.disabled = requestChanges.disabled = true;
    reviewError.textContent = '';
    try {
      await api.automationRecordRun(reviewed.workspace, reviewed.id, kind, input);
      review.close();
      await refresh();
    } catch (error) {
      reviewError.textContent = error.message;
    } finally {
      submitting = false;
      confirm.disabled = requestChanges.disabled = false;
    }
  };
  confirm.onclick = () => submitReview('execute', {digest: reviewed?.digest});
  // The draft goes back to preparation with the note; it needs approval again.
  requestChanges.onclick = () => {
    if (!changes.value.trim()) {
      reviewError.textContent = 'First write what you want changed.';
      return changes.focus();
    }
    submitReview('prepare', {changes: changes.value.trim()});
  };
  const toolbar = el('div', null, 'automation-results-toolbar'),
    search = el('input'),
    filter = el('select'),
    pagination = el('div', null, 'jobs-pagination'),
    content = el('div'),
    activity = el('div', null, 'record-activity-summary');
  activity.setAttribute('role', 'status');
  search.type = 'search';
  search.id = 'automation-result-search';
  search.placeholder = 'Search results…';
  search.setAttribute('aria-label', 'Search results');
  filter.id = 'automation-result-filter';
  filter.setAttribute('aria-label', 'Filter result status');
  const scoreFilter = el('div', null, 'record-score-filter'),
    scoreComparison = el('select'),
    scoreMinimum = el('input');
  scoreComparison.id = 'automation-result-score-comparison';
  scoreComparison.setAttribute('aria-label', 'Score comparison');
  scoreComparison.append(new Option('>', 'gt'), new Option('<', 'lt'));
  scoreMinimum.type = 'number';
  scoreMinimum.id = 'automation-result-score-minimum';
  scoreMinimum.min = '0';
  scoreMinimum.max = '100';
  scoreMinimum.step = 'any';
  scoreMinimum.placeholder = 'All';
  scoreMinimum.setAttribute('aria-label', 'Score limit');
  scoreFilter.append(el('span', 'Score'), scoreComparison, scoreMinimum);
  for (const [value, label] of [
    ['all', 'All records'],
    ['starred', '★ Starred'],
    ['found', 'Found'],
    ['prepared', 'Ready to apply'],
    ['completed', 'Completed'],
    ['uncertain', 'Awaiting verification'],
    ['dismissed', 'Skipped'],
    ['trial', 'Research and trial samples'],
  ])
    filter.add(new Option(label, value));
  toolbar.append(search, filter, scoreFilter);
  root.previousElementSibling.append(toolbar);
  root.replaceChildren(activity, pagination, content, review);
  search.oninput =
    scoreMinimum.oninput =
    scoreComparison.onchange =
    filter.onchange =
      () => {
        page = 1;
        render();
      };
  const selection = el('div', null, 'record-selection-toolbar'),
    selectionCount = el('span'),
    selectionError = el('span', null, 'record-selection-error');
  selectionCount.setAttribute('role', 'status');
  selectionError.setAttribute('role', 'alert');
  const eligible = (result) =>
    Boolean(
      result.recordAction?.scoreOperation &&
        !result.recordAction.scoreOperation.disabled &&
        !requests.has(data.automation.id + ':' + result.id),
    );
  const deletable = (result) =>
    Boolean(
      api.automationRecordsDelete &&
        !result.recordAction?.task &&
        result.status !== 'executing' &&
        !requests.has(data.automation.id + ':' + result.id),
    );
  const selectableRecord = (result) => eligible(result) || deletable(result);
  const clearSelection = button('Clear selection', () => {
    selectedIds.clear();
    selectionError.textContent = '';
    render();
  });
  const scoreSelected = button(
    'Score selected',
    async () => {
      if (
        batchSubmitting ||
        busy ||
        !selectedIds.size ||
        selectedIds.size > 100 ||
        data.results.some((result) => selectedIds.has(result.id) && !eligible(result))
      )
        return;
      const workspace = data.automation.id,
        ids = [...selectedIds];
      batchSubmitting = 'score';
      selectionError.textContent = '';
      for (const id of ids) requests.add(workspace + ':' + id);
      render();
      try {
        await api.automationRecordsScore(workspace, ids);
        if (selectionOwner === workspace) for (const id of ids) selectedIds.delete(id);
        await refresh();
      } catch (error) {
        if (selectionOwner === workspace) selectionError.textContent = error.message;
      } finally {
        for (const id of ids) requests.delete(workspace + ':' + id);
        batchSubmitting = null;
        render();
      }
    },
    'primary',
  );
  scoreSelected.dataset.recordsScore = '';
  const deleteSelected = button(
    'Delete selected',
    async () => {
      if (
        batchSubmitting ||
        busy ||
        !selectedIds.size ||
        data.results.some((result) => selectedIds.has(result.id) && !deletable(result))
      )
        return;
      const workspace = data.automation.id,
        ids = [...selectedIds];
      if (!window.confirm(`Permanently delete ${ids.length} selected record(s)?`)) return;
      batchSubmitting = 'delete';
      selectionError.textContent = '';
      for (const id of ids) requests.add(workspace + ':' + id);
      render();
      try {
        await api.automationRecordsDelete(workspace, ids);
        if (selectionOwner === workspace) {
          for (const id of ids) {
            selectedIds.delete(id);
            expanded.delete(id);
          }
          if (ids.includes(reviewed?.id)) {
            review.close();
            reviewed = null;
          }
        }
        await refresh();
      } catch (error) {
        if (selectionOwner === workspace) selectionError.textContent = error.message;
      } finally {
        for (const id of ids) requests.delete(workspace + ':' + id);
        batchSubmitting = null;
        render();
      }
    },
    'danger',
  );
  deleteSelected.dataset.recordsDelete = '';
  selection.append(selectionCount, scoreSelected, deleteSelected, clearSelection, selectionError);
  root.insertBefore(selection, pagination);

  function syncTabButtons() {
    for (const {result, control, actions, open} of visibleTabButtons.values()) {
      if (recordTabs(result, liveTabs, data).length) {
        if (!control.isConnected) actions.insertBefore(control, open);
      } else control.remove();
    }
  }
  async function refreshTabs() {
    if (!tabOwner) return;
    const id = tabOwner,
      version = ++tabVersion;
    const next = await api.workspaceTabs(id).catch(() => []);
    if (tabOwner !== id || version !== tabVersion) return;
    const identity = tabIdentity(next),
      changed = identity !== liveTabIdentity;
    liveTabs = next;
    liveTabIdentity = identity;
    if (changed) render();
    else syncTabButtons();
  }
  const tabTimer = setInterval(() => {
    if (root.isConnected && root.getClientRects().length) void refreshTabs();
  }, 1000);
  function positionOpenMenu() {
    const panel = content.querySelector('.record-row-actions:popover-open');
    if (panel)
      positionMenu(panel, panel.closest('[data-result-id]').querySelector('.record-row-menu'));
  }

  function render() {
    if (!data) return;
    const openMenu = content.querySelector('.record-row-actions:popover-open'),
      openRow = openMenu?.closest('[data-result-id]'),
      focused = document.activeElement;
    const focusedAction = openMenu?.contains(focused) ? menuControlKey(focused) : null,
      focusedToggle = openRow?.querySelector('.record-row-menu') === focused,
      menuScroll = openMenu?.scrollTop;
    const active = data.results.filter((r) => recordOperationStatus(r)?.active),
      queued = active.filter((r) => r.recordAction?.task?.state === 'pending').length,
      waiting = data.results.filter(recordNeedsAnswer).length;
    if (
      changed(activity, JSON.stringify([active.length, queued, waiting, filter.value === 'active']))
    ) {
      activity.replaceChildren();
      activity.hidden = !active.length;
    }
    if (active.length && !activity.childElementCount) {
      activity.append(
        el(
          'span',
          `${active.length} record(s) in progress · ${queued} queued${waiting ? ` · ${waiting} awaiting an answer` : ''}`,
        ),
        button(filter.value === 'active' ? 'Show all records' : 'Show records in progress', () => {
          filter.value = filter.value === 'active' ? 'all' : 'active';
          page = 1;
          render();
        }),
      );
    }
    const query = search.value.trim().toLocaleLowerCase('en-GB').split(/\s+/).filter(Boolean);
    const hasScore = Boolean(
      data.definition.recordOperations?.score ||
        data.automation.table?.columns?.some((column) => column.key === 'score'),
    );
    scoreFilter.hidden = !hasScore;
    const threshold =
      hasScore && Number.isFinite(scoreMinimum.valueAsNumber) ? scoreMinimum.valueAsNumber : null;
    const matchesScore = (result) => {
      const score = result.assessment ? result.assessment.score : result.cells?.score;
      return (
        threshold === null ||
        (score != null &&
          String(score).trim() !== '' &&
          Number.isFinite(Number(score)) &&
          (scoreComparison.value === 'lt' ? Number(score) < threshold : Number(score) > threshold))
      );
    };
    const results = data.results.filter(
      (r) =>
        matchesScore(r) &&
        (filter.value === 'all' ||
          (filter.value === 'waiting'
            ? recordNeedsAnswer(r)
            : filter.value === 'active'
              ? recordOperationStatus(r)?.active
              : filter.value === 'trial'
                ? r.trial
                : filter.value === 'starred'
                  ? r.starred
                  : !r.trial && recordState(r, data.definition).id === filter.value)) &&
        query.every((q) =>
          [
            r.title,
            r.summary,
            r.url,
            ...Object.values(r.cells ?? {}),
            recordState(r, data.definition).label,
            recordOperationStatus(r)?.label ?? '',
          ]
            .join(' ')
            .toLocaleLowerCase('en-GB')
            .includes(q),
        ),
    );
    const openIds = new Set(
      liveTabs.length
        ? results
            .filter((result) => recordTabs(result, liveTabs, data).length)
            .map((result) => result.id)
        : [],
    );
    const columns = data.automation.table?.columns ?? [
      {key: 'source', label: 'Source', type: 'text'},
      {key: 'title', label: 'Record', type: 'text'},
    ];
    if (!['status', 'updatedAt', ...columns.map((c) => c.key)].includes(sort)) {
      sort = 'updatedAt';
      direction = -1;
    }
    const value = (r) =>
      sort === 'source'
        ? source(r)
        : sort === 'status'
          ? (recordOperationStatus(r)?.label ?? recordState(r, data.definition).label ?? r.status)
          : sort === 'updatedAt'
            ? recordActivityAt(r)
            : sort === 'title'
              ? r[sort]
              : (r.cells?.[sort] ?? '');
    const numeric =
      sort === 'updatedAt' ||
      ['number', 'money'].includes(columns.find((c) => c.key === sort)?.type);
    const priority = (result) =>
      recordNeedsAnswer(result) ? 0 : openIds.has(result.id) ? 1 : recordIsWorking(result) ? 2 : 3;
    results.sort((a, b) => {
      const rank = priority(a) - priority(b);
      if (rank) return rank;
      const av = value(a),
        bv = value(b);
      if (av === '' || bv === '') return av === bv ? 0 : av === '' ? 1 : -1;
      return (
        direction * (numeric ? Number(av) - Number(bv) : collator.compare(av, bv)) ||
        collator.compare(a.id, b.id)
      );
    });
    const pages = Math.max(1, Math.ceil(results.length / pageSize));
    page = Math.min(page, pages);
    const start = (page - 1) * pageSize,
      visible = results.slice(start, start + pageSize);
    const selectable = Boolean(
        data.definition.recordOperations?.score || api.automationRecordsDelete,
      ),
      visibleEligible = visible.filter(selectableRecord);
    selection.hidden = !selectable || !selectedIds.size;
    selectionCount.textContent = selectedIds.size + ' record(s) selected';
    const selectedResults = data.results.filter((result) => selectedIds.has(result.id)),
      allScorable = selectedResults.every(eligible),
      allDeletable = selectedResults.every(deletable);
    scoreSelected.hidden = !data.definition.recordOperations?.score;
    deleteSelected.hidden = !api.automationRecordsDelete;
    scoreSelected.textContent =
      batchSubmitting === 'score' ? 'Queueing…' : `Score selected (${selectedIds.size})`;
    scoreSelected.disabled =
      busy ||
      Boolean(batchSubmitting) ||
      !selectedIds.size ||
      selectedIds.size > 100 ||
      !allScorable;
    scoreSelected.title =
      selectedIds.size > 100
        ? 'At most 100 records can be scored at once.'
        : !allScorable
          ? 'Some selected records cannot be scored right now.'
          : '';
    deleteSelected.textContent =
      batchSubmitting === 'delete' ? 'Deleting…' : `Delete selected (${selectedIds.size})`;
    deleteSelected.disabled =
      busy || Boolean(batchSubmitting) || !selectedIds.size || !allDeletable;
    deleteSelected.title = !allDeletable
      ? 'Stop the queued or running operations of the selected records before deleting.'
      : '';
    clearSelection.disabled = Boolean(batchSubmitting);
    const selectCheckbox = (label, checked, change) => {
      const input = el('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.setAttribute('aria-label', label);
      input.disabled = busy || batchSubmitting;
      input.onchange = change;
      return input;
    };

    const paginationChanged = changed(
      pagination,
      JSON.stringify([start, visible.length, results.length, page, pages]),
    );
    if (paginationChanged)
      pagination.replaceChildren(
        el(
          'span',
          results.length
            ? `${start + 1}–${start + visible.length} / ${results.length} records`
            : '0 records',
          'pagination-count',
        ),
      );
    if (paginationChanged && pages > 1) {
      const previous = button('Previous', () => {
          page--;
          render();
        }),
        next = button('Next', () => {
          page++;
          render();
        });
      previous.disabled = page === 1;
      next.disabled = page === pages;
      pagination.append(previous, el('span', `${page} / ${pages}`), next);
    }
    visibleTabButtons.clear();
    const tableColumns = [
      ...(selectable ? [{key: 'selection', label: 'Select'}] : []),
      {key: 'updatedAt', label: 'Last activity'},
      ...columns,
      {key: 'status', label: 'Status'},
    ];
    const tableKey = JSON.stringify([data.automation.id, tableColumns]),
      previousTable = mounted && renderKeys.get(mounted.table) !== tableKey ? mounted : null;
    if (!mounted || previousTable) {
      disposeTable();
      rows.clear();
      mounted = recordTable(tableColumns, {
        className: 'jobs-table automation-results-table',
        scrollLeft,
        onScroll: (value) => {
          scrollLeft = value;
        },
        onLayout: positionOpenMenu,
      });
      renderKeys.set(mounted.table, tableKey);
      disposeTable = mounted.dispose;
      mounted.table.setAttribute('aria-label', 'Tracked records and results');
      mounted.table.style.minWidth =
        (columns.length > 5 ? 820 + (columns.length - 5) * 110 : columns.length > 2 ? 720 : 560) +
        'px';
      content.append(mounted.element);
    }
    const {element, table, body} = mounted,
      headRow = table.tHead.rows[0];
    if (
      changed(
        headRow,
        JSON.stringify([
          sort,
          direction,
          visibleEligible.map((result) => [result.id, selectedIds.has(result.id)]),
          busy,
          Boolean(batchSubmitting),
        ]),
      )
    )
      tableColumns.forEach(({key, label}, index) => {
        const th = headRow.cells[index];
        if (key === 'selection') {
          const count = visibleEligible.filter((result) => selectedIds.has(result.id)).length;
          const selectPage = selectCheckbox(
            'Select records on this page',
            visibleEligible.length > 0 && count === visibleEligible.length,
            () => {
              for (const result of visibleEligible)
                selectPage.checked ? selectedIds.add(result.id) : selectedIds.delete(result.id);
              selectionError.textContent = '';
              render();
            },
          );
          selectPage.indeterminate = count > 0 && count < visibleEligible.length;
          selectPage.disabled ||= !visibleEligible.length;
          selectPage.dataset.recordsSelectPage = '';
          th.replaceChildren(selectPage);
        } else {
          th.setAttribute(
            'aria-sort',
            sort === key ? (direction === 1 ? 'ascending' : 'descending') : 'none',
          );
          const control = button(
            label + (sort === key ? (direction === 1 ? ' ↑' : ' ↓') : ''),
            () => {
              direction = sort === key ? -direction : key === 'updatedAt' ? -1 : 1;
              sort = key;
              page = 1;
              render();
            },
            'sort-button',
          );
          control.dataset.resultSort = key;
          th.replaceChildren(control);
        }
      });
    // Rows keep their nodes while their inputs are unchanged. Changed rows are
    // inserted around the kept ones, so a kept row is not moved under the pointer.
    const rowKeys = new Map(
      visible.length
        ? visible.map((result) => [
            result.id,
            JSON.stringify([
              result,
              requests.has(data.automation.id + ':' + result.id),
              busy,
              batchSubmitting,
              selectedIds.has(result.id),
              expanded.has(result.id),
              openIds.has(result.id),
              data.workers?.find((w) => w.id === result.recordAction?.task?.workerId)?.name,
              data.automation.revision,
            ]),
          ])
        : [['', JSON.stringify([Boolean(data.results.length)])]],
    );
    const kept = new Set(),
      placed = new Set();
    for (const [id, key] of rowKeys) {
      const cached = rows.get(id);
      if (cached?.key === key) kept.add(cached.row).add(cached.detailRow);
      else rows.delete(id);
    }
    for (const id of rows.keys()) if (!rowKeys.has(id)) rows.delete(id);
    let cursor = body.firstChild;
    const place = (node) => {
      while (cursor && !kept.has(cursor)) cursor = cursor.nextSibling;
      placed.add(node);
      if (node === cursor) cursor = node.nextSibling;
      else if (node.parentNode === body) body.moveBefore(node, cursor);
      else body.insertBefore(node, cursor);
    };
    const reuse = (id) => {
      const cached = rows.get(id);
      if (!cached) return false;
      place(cached.row);
      if (cached.detailRow) place(cached.detailRow);
      if (cached.tab) visibleTabButtons.set(id, cached.tab);
      return true;
    };
    if (!visible.length) {
      if (!reuse('')) {
        const row = el('tr'),
          cell = el('td', null, 'empty');
        cell.colSpan = columns.length + 2 + Number(selectable);
        cell.append(
          el(
            'strong',
            data.results.length ? 'No results match this search or filter.' : 'No records yet',
          ),
          el(
            'p',
            data.results.length
              ? 'Try a different search or filter.'
              : 'Records the agent finds, application notes and action results will appear here.',
          ),
        );
        row.append(cell);
        place(row);
        rows.set('', {key: rowKeys.get(''), row});
      }
    }
    for (const result of visible) {
      if (reuse(result.id)) continue;
      const progress = recordOperationStatus(result),
        requesting = requests.has(data.automation.id + ':' + result.id);
      const keepMenu = openRow?.dataset.resultId === result.id;
      const row = el('tr'),
        state = el('td'),
        updated = el('td', null, 'automation-result-time'),
        actionsPanel = keepMenu ? openMenu : el('div', null, 'record-row-actions'),
        actions = el('div', null, 'table-actions'),
        actionsToggle = keepMenu
          ? openRow.querySelector('.record-row-menu')
          : button(
              '⋯',
              () => {
                if (actionsPanel.matches(':popover-open')) {
                  actionsPanel.hidePopover();
                  return;
                }
                actionsPanel.showPopover();
                positionMenu(actionsPanel, actionsToggle);
              },
              'record-row-menu',
            );
      row.dataset.resultId = result.id;
      row.dataset.needsAnswer = String(recordNeedsAnswer(result));
      row.dataset.working = String(recordIsWorking(result));
      row.dataset.openTab = String(openIds.has(result.id));
      row.dataset.outcome = !progress && !requesting ? result.status : '';
      actionsPanel.popover = 'auto';
      actionsPanel.id = 'record-row-actions-' + result.id;
      actionsToggle.setAttribute('aria-controls', actionsPanel.id);
      actionsToggle.setAttribute('aria-expanded', String(keepMenu));
      actionsToggle.setAttribute('aria-label', result.title + ' · Actions');
      actionsToggle.title = 'Actions';
      actionsPanel.ontoggle = () =>
        actionsToggle.setAttribute('aria-expanded', String(actionsPanel.matches(':popover-open')));
      row.dataset.selected = String(selectedIds.has(result.id));
      if (selectable) {
        const cell = el('td');
        cell.dataset.column = 'selection';
        const checkbox = selectCheckbox(
          result.title + ' · Select',
          selectedIds.has(result.id),
          () => {
            checkbox.checked ? selectedIds.add(result.id) : selectedIds.delete(result.id);
            selectionError.textContent = '';
            render();
            root.querySelector(`[data-record-select="${result.id}"]`)?.focus();
          },
        );
        checkbox.dataset.recordSelect = result.id;
        checkbox.disabled ||= !selectableRecord(result);
        checkbox.title = !selectableRecord(result)
          ? 'An operation for this record is queued or running'
          : '';
        cell.append(checkbox);
        row.append(cell);
      }
      row.append(updated);
      for (const column of columns) {
        const cell = el('td');
        cell.dataset.column = column.key;
        if (column.key === 'source') {
          cell.className = 'company-cell';
          const heading = el('div', null, 'company-heading'),
            star = button(
              result.starred ? '★' : '☆',
              async () => {
                await api.automationStar(data.automation.id, result.id, !result.starred);
                await refresh();
              },
              'job-star',
            );
          star.setAttribute('aria-label', result.starred ? 'Remove star' : 'Star');
          star.setAttribute('aria-pressed', String(Boolean(result.starred)));
          const name = el('span', source(result));
          name.title = source(result);
          heading.append(star, name);
          cell.append(heading);
        } else if (column.key === 'title') {
          cell.className = 'role-cell';
          const heading = el('strong', result.title);
          heading.title = result.title;
          cell.append(heading);
          if (recordIsWorking(result)) {
            const worker = data.workers?.find((w) => w.id === result.recordAction.task.workerId),
              mark = el(
                'span',
                'Agent working' + (worker?.name ? ' · ' + worker.name : ''),
                'record-working-badge',
              );
            cell.prepend(mark);
          }
          if (recordNeedsAnswer(result)) {
            const question = result.recordAction.question,
              mark = el('span', 'Awaiting answer', 'record-question-badge'),
              preview = el('span', question.text, 'record-question-preview'),
              reply = button(
                'Answer question',
                () => onQuestion(question.id),
                'record-question-link',
              );
            preview.title = question.text;
            reply.dataset.recordQuestion = question.id;
            reply.setAttribute('aria-label', result.title + ' · Answer question');
            cell.append(mark, preview, reply);
          }
        } else if (column.key === 'score' && result.assessment) {
          const assessment = result.assessment,
            score = button(
              assessment.score === null ? 'Could not be assessed' : `${assessment.score}/100`,
              () => {
                expanded.has(result.id) ? expanded.delete(result.id) : expanded.add(result.id);
                render();
              },
              'sort-button',
            );
          score.title = assessment.summary;
          score.setAttribute('aria-expanded', String(expanded.has(result.id)));
          score.setAttribute('aria-label', result.title + ' · Scoring rationale');
          score.dataset.recordScore = result.id;
          cell.append(
            score,
            el(
              'small',
              eligibilityLabels[assessmentEligibility(assessment)],
              'record-score-eligibility',
            ),
          );
          if (oldScoringMethod(assessment))
            cell.append(el('small', 'Old method · rescore', 'record-score-stale'));
          if (assessment.revision !== data.automation.revision)
            cell.append(el('small', 'Outdated assessment', 'record-score-stale'));
        } else {
          row.append(
            recordCell(column, result.cells?.[column.key], {openLink: (url) => api.openLink(url)}),
          );
          continue;
        }
        row.append(cell);
      }
      state.dataset.column = 'status';
      updated.dataset.column = 'updatedAt';
      state.append(
        el(
          'span',
          requesting
            ? batchSubmitting === 'delete'
              ? 'Deleting'
              : 'Queueing'
            : (progress?.label ?? recordState(result, data.definition).label),
          'automation-badge ' + (requesting ? 'queued' : (progress?.tone ?? result.status)),
        ),
      );
      if (progress?.detail) {
        const detail = el('span', progress.detail, 'record-operation-detail');
        detail.title = progress.detail;
        state.append(detail);
      }
      if (result.workflowState && result.workflowState !== result.status)
        state.append(badge(result.status));
      if (result.trial)
        state.append(
          el(
            'span',
            result.sampleKind === 'interview' ? 'Research sample' : 'Trial sample',
            'automation-trial-label',
          ),
        );
      const activityDate = new Date(recordActivityAt(result)),
        date = el('time');
      date.dateTime = activityDate.toISOString();
      date.title = time(recordActivityAt(result));
      date.append(
        el('span', activityDate.toLocaleDateString('en-GB')),
        el('span', activityDate.toLocaleTimeString('en-GB'), 'automation-result-clock'),
      );
      updated.append(date);
      const detailsId = 'automation-result-detail-' + result.id,
        detail = button(expanded.has(result.id) ? 'Close' : 'Details', () => {
          expanded.has(result.id) ? expanded.delete(result.id) : expanded.add(result.id);
          render();
          root.querySelector(`[data-result-detail="${result.id}"]`)?.focus();
        });
      detail.dataset.resultDetail = result.id;
      detail.dataset.recordMenuAction = 'detail';
      detail.setAttribute('aria-expanded', String(expanded.has(result.id)));
      detail.setAttribute('aria-controls', detailsId);
      const open = button('Open ↗', () => {
        if (actionsPanel.matches(':popover-open')) actionsPanel.hidePopover();
        api.openLink(result.url);
      });
      open.dataset.recordMenuAction = 'open';
      open.setAttribute('aria-label', result.title + ' · Open source');
      const tabWorkspace = data.automation.id,
        tabFeedback = keepMenu
          ? actionsPanel.querySelector('.record-tab-feedback')
          : el('span', null, 'record-tab-feedback'),
        tabChoices = keepMenu
          ? actionsPanel.querySelector('.record-tab-choices')
          : el('div', null, 'record-tab-choices');
      tabFeedback.setAttribute('role', 'status');
      const focusTab = async (tab) => {
        try {
          await api.focusWorkspaceTab(tabWorkspace, tab.tabId);
          tabChoices.replaceChildren();
          tabFeedback.textContent = '';
          if (actionsPanel.matches(':popover-open')) actionsPanel.hidePopover();
        } catch (error) {
          tabFeedback.textContent = error.message;
          void refreshTabs();
        }
      };
      const goToTab = button('Go to tab', async () => {
        tabFeedback.textContent = '';
        tabChoices.replaceChildren();
        try {
          const version = ++tabVersion,
            openTabs = await api.workspaceTabs(tabWorkspace);
          if (tabOwner !== tabWorkspace) return;
          if (version === tabVersion) {
            const identity = tabIdentity(openTabs),
              changed = identity !== liveTabIdentity;
            liveTabs = openTabs;
            liveTabIdentity = identity;
            if (changed) render();
            else syncTabButtons();
          }
          const current = data.results.find((item) => item.id === result.id),
            tabs = current ? recordTabs(current, openTabs, data) : [];
          if (!tabs.length) {
            tabFeedback.textContent = 'No open tab was found for this record.';
            return;
          }
          if (tabs.length === 1) {
            await focusTab(tabs[0]);
            return;
          }
          tabFeedback.textContent = 'Choose the open tab:';
          for (const tab of tabs) tabChoices.append(button(tab.url, () => focusTab(tab)));
        } catch (error) {
          tabFeedback.textContent = error.message;
          void refreshTabs();
        }
      });
      goToTab.dataset.recordTab = result.id;
      goToTab.dataset.recordMenuAction = 'tab';
      actions.append(open, detail);
      const tab = {result, control: goToTab, actions, open};
      visibleTabButtons.set(result.id, tab);
      if (openIds.has(result.id)) actions.insertBefore(goToTab, open);
      recordActions(actions, result, data.definition, async (action) => {
        try {
          await api.workspaceTransition(data.automation.id, result.id, action);
          await refresh();
        } catch (error) {
          window.alert(error.message);
        }
      });
      const recordAction = result.recordAction;
      if (recordAction?.scoreOperation) {
        const op = recordAction.scoreOperation,
          score = button(
            requesting
              ? 'Queueing…'
              : recordAction.task?.kind === 'score'
                ? progress.label
                : op.label,
            async () => {
              try {
                await sendOperation(result, 'score');
              } catch (error) {
                window.alert(error.message);
              }
            },
          );
        score.dataset.recordOperation = 'score';
        score.disabled = busy || requesting || op.disabled;
        score.title =
          op.reason ?? 'Assess the listing against the saved scoring criteria, profile and CV.';
        actions.append(score);
      }
      if (recordAction?.retryOperation) {
        const op = recordAction.retryOperation,
          retry = button(
            requesting ? 'Queueing…' : 'Retry',
            async () => {
              try {
                await sendOperation(result, op.kind, op.direct ? {direct: true} : {});
              } catch (error) {
                window.alert(error.message);
              }
            },
            'record-retry',
          );
        retry.dataset.recordRetry = result.id;
        retry.disabled = busy || requesting || op.disabled;
        retry.title =
          op.reason ??
          (op.kind === 'verify'
            ? 'Verify the outcome of the action before resending it.'
            : 'Retry the last unfinished action.');
        state.append(retry);
      }
      if (recordAction?.directOperation && !recordAction.task) {
        const op = recordAction.directOperation,
          apply = button(
            requesting ? 'Queueing…' : op.label,
            async () => {
              try {
                await sendOperation(result, 'execute', {direct: true});
              } catch (error) {
                window.alert(error.message);
              }
            },
            'primary',
          );
        apply.dataset.recordDirect = 'execute';
        apply.disabled = busy || requesting || op.disabled;
        apply.title =
          op.reason ??
          'The agent checks the required information and completes the action for this record. If anything is missing, it asks you.';
        actions.append(apply);
      }
      if (recordAction?.operation) {
        const op = recordAction.operation,
          action = button(
            requesting ? 'Queueing…' : recordAction.task ? progress.label : op.label,
            async () => {
              // "Apply" applies directly: there is no draft review step.
              if (op.kind === 'execute' && actionsPanel.matches(':popover-open'))
                actionsPanel.hidePopover();
              try {
                await sendOperation(result, op.kind, op.kind === 'execute' ? {direct: true} : {});
              } catch (error) {
                window.alert(error.message);
              }
            },
            recordAction.directOperation && !recordAction.task ? '' : 'primary',
          );
        action.dataset.recordOperation = op.kind;
        action.disabled = busy || requesting || op.disabled;
        action.title =
          op.reason ??
          (op.kind === 'execute'
            ? 'The agent fills the form with the saved information and submits the application. If anything is missing, it asks all at once.'
            : '');
        actions.append(action);
      }
      if (['found', 'prepared', 'uncertain'].includes(result.status)) {
        const submitted = button('Applied', async () => {
          if (
            !window.confirm(
              'Did you verify that this application was submitted (e.g. a confirmation email)? The record counts as completed and will not be submitted again.',
            )
          )
            return;
          try {
            await api.automationMarkSubmitted(data.automation.id, result.id);
          } catch (error) {
            window.alert(error.message);
          }
          await refresh();
        });
        submitted.dataset.recordSubmitted = result.id;
        submitted.disabled = busy || requesting;
        submitted.title =
          'If you verified that the application was submitted, mark the record as completed';
        actions.append(submitted);
      }
      if (['found', 'prepared'].includes(result.status)) {
        const dismiss = button('Skip', async () => {
          await api.automationDismiss(data.automation.id, result.id);
          await refresh();
        });
        dismiss.dataset.recordDismiss = result.id;
        dismiss.disabled = busy || requesting;
        dismiss.title = 'Skip this record and close its pending questions';
        actions.append(dismiss);
      }
      for (const control of actions.querySelectorAll('[data-idle]'))
        control.disabled = busy || requesting || Boolean(recordAction?.task);
      if (!keepMenu) state.append(actionsToggle);
      row.append(state);
      place(row);
      if (keepMenu) {
        // Keep the connected native popover in the top layer while rebuilding the table.
        state.moveBefore(actionsToggle, null);
        state.moveBefore(actionsPanel, null);
        actionsPanel.querySelector('.table-actions').replaceWith(actions);
        if (focusedAction) {
          const control = [...actions.children].find(
            (control) => menuControlKey(control) === focusedAction && !control.disabled,
          );
          (control ?? actionsToggle).focus({preventScroll: true});
        } else if (focusedToggle) actionsToggle.focus({preventScroll: true});
        actionsPanel.scrollTop = menuScroll;
      } else {
        actionsPanel.append(actions, tabChoices, tabFeedback);
        state.append(actionsPanel);
      }
      const detailRow = el('tr', null, 'automation-result-detail'),
        cell = el('td');
      detailRow.id = detailsId;
      detailRow.hidden = !expanded.has(result.id);
      cell.colSpan = columns.length + 2 + Number(selectable);
      cell.append(el('p', result.summary));
      if (result.assessment) {
        const assessment = result.assessment;
        cell.append(
          el(
            'h3',
            assessment.score === null
              ? 'Scoring · Could not be assessed'
              : `Fit score · ${assessment.score}/100`,
          ),
          scoreBreakdown(assessment),
          el('p', assessment.summary),
        );
        if (oldScoringMethod(assessment))
          cell.append(
            el(
              'p',
              'This score was saved with the previous method; a fixed cap may have been applied. Rescore for a current fit score.',
              'record-score-stale',
            ),
          );
        if (assessment.revision !== data.automation.revision)
          cell.append(
            el(
              'p',
              'The profile or criteria changed. This assessment is based on outdated information.',
              'record-score-stale',
            ),
          );
        for (const [key, label] of [
          ['strengths', 'Matches'],
          ['gaps', 'Gaps'],
          ['uncertainties', 'Uncertainties'],
        ])
          if (assessment[key]?.length) {
            const list = el('ul');
            for (const note of assessment[key]) list.append(el('li', note));
            cell.append(el('h4', label), list);
          }
        if (assessment.rubric)
          cell.append(el('h4', 'Scoring criteria used'), el('p', assessment.rubric));
        cell.append(
          el('blockquote', assessment.evidence),
          button('Assessed listing ↗', () => api.openLink(assessment.evidenceUrl)),
          el('small', `Assessed: ${time(assessment.scoredAt)} · Not a probability of success.`),
        );
      }
      if (result.proposal) cell.append(el('h3', 'Last work note'), el('pre', result.proposal));
      if (recordAction?.lastTask?.summary)
        cell.append(el('h3', 'Last record operation'), el('p', recordAction.lastTask.summary));
      if (result.evidence)
        cell.append(el('h3', 'Outcome evidence'), el('blockquote', result.evidence));
      detailRow.append(cell);
      place(detailRow);
      rows.set(result.id, {key: rowKeys.get(result.id), row, detailRow, tab});
    }
    for (const node of [...body.children]) if (!placed.has(node)) node.remove();
    previousTable?.element.remove();
    if (openMenu?.isConnected) {
      element.querySelector('.jobs-table-wrap').scrollLeft = scrollLeft;
      positionOpenMenu();
    }
  }
  return {
    showQuestions() {
      search.value = '';
      scoreMinimum.value = '';
      scoreComparison.value = 'gt';
      filter.value = 'waiting';
      page = 1;
      render();
      root.scrollIntoView({block: 'start', behavior: 'smooth'});
    },
    dispose: () => {
      content.querySelector('.record-row-actions:popover-open')?.hidePopover();
      clearInterval(tabTimer);
      tabOwner = null;
      tabVersion++;
      disposeTable();
      mounted = null;
      rows.clear();
    },
    update(snapshot, isBusy) {
      if (data?.automation.id !== snapshot.automation.id) {
        content.querySelector('.record-row-actions:popover-open')?.hidePopover();
        review.close();
        reviewed = null;
        scrollLeft = 0;
        page = 1;
        scoreMinimum.value = '';
        scoreComparison.value = 'gt';
        selectedIds.clear();
        selectionError.textContent = '';
      }
      if (tabOwner !== snapshot.automation.id) {
        liveTabs = [];
        liveTabIdentity = '[]';
        tabVersion++;
      }
      tabOwner = snapshot.automation.id;
      data = snapshot;
      busy = isBusy;
      selectionOwner = snapshot.automation.id;
      const currentIds = new Set(data.results.filter(selectableRecord).map((result) => result.id));
      for (const id of selectedIds)
        if (!currentIds.has(id) && !requests.has(selectionOwner + ':' + id)) selectedIds.delete(id);
      const options = [
        ['All records', 'all'],
        ['★ Starred', 'starred'],
        ['Records in progress', 'active'],
        ['Awaiting answer', 'waiting'],
        ...(data.definition?.records.states ?? []).map((s) => [s.label, s.id]),
        ['Research and trial samples', 'trial'],
      ];
      // Replacing the options would close the list while the user has it open.
      if (changed(filter, JSON.stringify(options))) {
        const selected = filter.value;
        filter.replaceChildren(...options.map(([label, value]) => new Option(label, value)));
        if (options.some(([, value]) => value === selected)) filter.value = selected;
      }
      render();
      void refreshTabs();
    },
  };
}
