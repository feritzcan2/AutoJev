import {observedId} from './ids.mjs';
import {acquireTabRendering, revealInView} from './rendering.mjs';
import {wheelScroll} from '../browser/human-input.mjs';
import {randomUUID, createHash} from 'node:crypto';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function captureControls(slot, owner) {
  const previous = slot.controls ?? new Map();
  slot.controls = new Map();
  const capture = (items, kind, guards) =>
    items.map(({node, ...item}) => {
      const guard = guards[node];
      const saved = [...previous].find(
        ([, entry]) =>
          entry.owner === owner &&
          entry.node === node &&
          entry.kind === kind &&
          same(entry.guard, guard),
      );
      const controlId = saved?.[0] ?? observedId(kind === 'scroll' ? 's' : 'c');
      slot.controls.set(controlId, {node, kind, guard, owner});
      const read = slot.optionLists?.get(node);
      const field =
        kind === 'control'
          ? [...(slot.fillFields ?? [])].find(
              ([, f]) => f.owner === owner && f.action.node === node,
            )
          : null;
      // Agent-facing names: the agent only has browser_interact operations.
      const recommendedTool = field
        ? 'browser_interact type'
        : item.nativeSelect
          ? 'browser_interact select'
          : item.choice
            ? 'browser_interact click'
            : item.autocomplete
              ? 'browser_interact autocomplete'
              : null;
      return {
        controlId,
        ...item,
        ...(field ? {fieldId: field[0]} : {}),
        ...(recommendedTool ? {recommendedTool} : {}),
        ...(read?.owner === owner && same(read.guard, guard) && read.completeReturned
          ? {
              optionsRead: {
                complete: true,
                count: read.options.length,
                listId: read.id,
                nextAction:
                  'Use the previously returned full list; select its exact label/value without another list query.',
              },
            }
          : {}),
      };
    });
  return {
    controls: capture(slot.observed.controls ?? [], 'control', slot.observed.control_guards),
    scrollTargets: capture(
      slot.observed.scrollTargets ?? [],
      'scroll',
      slot.observed.scroll_guards,
    ),
  };
}
export function progressKey(observed) {
  // Focus alone is not evidence that a click opened a form or submitted it.
  return createHash('sha256')
    .update(
      JSON.stringify([
        observed.page_key,
        observed.text,
        observed.scrollTargets,
        observed.actions.map(({rect, id, ...a}) => a),
      ]),
    )
    .digest('hex');
}
export function blockedRepeat(slot, key, state) {
  return slot.noProgress?.get(key) === state;
}
export function rememberProgress(slot, key, before, after) {
  slot.noProgress ??= new Map();
  if (before === after) {
    slot.noProgress.set(key, after);
    if (slot.noProgress.size > 40) slot.noProgress.delete(slot.noProgress.keys().next().value);
  } else slot.noProgress.delete(key);
  return before !== after;
}
// A control the page keeps hidden (display none, visibility hidden, no box)
// never scrolls into view; the same action usually exists as a visible target.
export const concealedMessage =
  'The page keeps this control hidden; reveal and scrolling cannot show it. Drop this id. The visible button for the same step is listed in clickTargets, often under a different label; click that one.';
export async function concealedByPage(slot, node) {
  return slot.page
    .evaluate((node) => {
      const e = window.__jevFast?.nodes.get(node);
      if (!e) return false;
      const style = getComputedStyle(e),
        box = e.getBoundingClientRect();
      return (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        (box.width === 0 && box.height === 0)
      );
    }, node)
    .catch(() => false);
}
export const stalled = {
  status: 'no_progress',
  executed: false,
  message:
    'The same action made no progress in this page state. Do not repeat it; make the target in controls visible with reveal or use a different observed target.',
};

export async function navigateObserved(slot, name, args, owner, reader) {
  const saved = slot.controls?.get(args.controlId);
  if (!saved)
    return {
      status: 'stale',
      executed: false,
      message:
        'The control id is stale; use the returned current controls/scrollTargets list. No extra observe is needed.',
    };
  if (saved.owner !== owner)
    throw Error(
      'A current controlId of this session is required; use the last controls/scrollTargets list.',
    );
  if ((name === 'browser_scroll') !== (saved.kind === 'scroll')) throw Error('Wrong control type.');
  const current = await slot.page.evaluate(reader),
    guards = saved.kind === 'scroll' ? current?.scroll_guards : current?.control_guards;
  if (!same(guards?.[saved.node], saved.guard))
    return {
      status: 'stale',
      executed: false,
      message: 'The target changed; use the returned current control.',
    };
  if (name === 'browser_list_options') {
    slot.pending = null;
    slot.optionLists ??= new Map();
    let list = slot.optionLists.get(saved.node),
      cached = list?.owner === owner && same(list.guard, saved.guard);
    if (!cached) {
      const result = await slot.page.evaluate((node) => {
        const e = window.__jevFast.nodes.get(node);
        if (e?.tagName !== 'SELECT') return null;
        return [...e.options].map((o) => ({
          index: o.index,
          label: o.label,
          value: o.value,
          selected: o.selected,
          disabled: o.disabled || !!o.closest('optgroup[disabled]'),
          group: o.closest('optgroup')?.label ?? null,
        }));
      }, saved.node);
      if (!result)
        return {
          status: 'unsupported',
          executed: false,
          message:
            'A native SELECT is required; for this control use browser_interact operation=autocomplete: text reads the suggestions, option selects one.',
        };
      list = {
        id: observedId('o'),
        owner,
        guard: saved.guard,
        options: result,
        completeReturned: false,
      };
      slot.optionLists.set(saved.node, list);
      if (slot.optionLists.size > 80) slot.optionLists.delete(slot.optionLists.keys().next().value);
    }
    const repeatedFullList = list.completeReturned,
      query = args.query ?? '',
      offset = args.offset ?? 0,
      limit = args.limit ?? null;
    const normalize = (value) =>
      value
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/ı/g, 'i')
        .replace(/\s+/g, ' ')
        .trim();
    const terms = normalize(query).split(' ').filter(Boolean),
      matches = list.options.filter((o) =>
        terms.every((term) =>
          normalize([o.label, o.value, o.group ?? ''].join(' ')).includes(term),
        ),
      );
    const options = matches.slice(offset, limit === null ? undefined : offset + limit),
      nextOffset = offset + options.length < matches.length ? offset + options.length : null;
    if (!query.trim() && offset === 0 && nextOffset === null) list.completeReturned = true;
    return {
      status: 'ready',
      executed: false,
      controlId: args.controlId,
      listId: list.id,
      cached: Boolean(cached),
      alreadyRead: repeatedFullList,
      query,
      offset,
      optionCount: list.options.length,
      matchCount: matches.length,
      options,
      nextOffset,
      nextAction: 'select_option',
      message: repeatedFullList
        ? 'The whole list was already returned. Do not query again; choose the exact label/value that matches the known answer.'
        : 'Keep the returned options; selecting the known answer needs no extra list query or reveal.',
    };
  }
  const key = JSON.stringify([name, saved.node, args.direction, args.option]),
    before = progressKey(current);
  if (blockedRepeat(slot, key, before)) return stalled;
  slot.pending = null;
  let began = false;
  try {
    if (name === 'browser_choose_option') {
      // Resolve only a unique, exact observed native option. No fuzzy answers,
      // arbitrary selector, checkbox, custom dropdown, or submit operation.
      const match = await slot.page.evaluate(
        ({node, option}) => {
          const e = window.__jevFast.nodes.get(node);
          if (
            e?.tagName !== 'SELECT' ||
            e.multiple ||
            e.matches(':disabled') ||
            e.closest('[aria-disabled="true"],[inert]')
          )
            return {error: 'An enabled single-select native SELECT is required.'};
          const matches = [...e.options].filter(
            (o) => o.value === option || o.label.trim() === option.trim(),
          );
          if (
            matches.length !== 1 ||
            matches[0].disabled ||
            matches[0].closest('optgroup[disabled]')
          )
            return {
              needsSelection: true,
              optionCount: e.options.length,
              reason:
                matches.length > 1 ? 'ambiguous' : matches.length === 0 ? 'no_match' : 'disabled',
            };
          const o = matches[0];
          return {value: o.value, label: o.label, index: o.index, unchanged: o.selected};
        },
        {node: saved.node, option: args.option},
      );
      if (match.error) throw Error(match.error);
      if (match.needsSelection) {
        const list = slot.optionLists?.get(saved.node),
          known = list?.owner === owner && same(list.guard, saved.guard) && list.completeReturned;
        return {
          status: 'needs_selection',
          executed: false,
          optionCount: match.optionCount,
          reason: match.reason,
          message: known
            ? 'No exact, enabled option matched. The full list was already returned; use the actual label/value from that list. Do not request the list again or guess another spelling.'
            : 'No exact, enabled option matched. Read all options with browser_list_options; use the actual label/value. Do not guess another spelling; no observe or screenshot is needed.',
        };
      }
      if (match.unchanged)
        return {status: 'ready', executed: false, selection: {...match, verified: true}};
      const handle = await slot.page.evaluateHandle(
          (node) => window.__jevFast.nodes.get(node),
          saved.node,
        ),
        releaseRendering = await acquireTabRendering(slot, {timeoutMs: 2000});
      try {
        await revealInView(slot, handle.asElement());
        const actionable = await slot.page.evaluate(
          ({node, guard}) => {
            const c = window.__jevFast,
              e = c.nodes.get(node);
            return JSON.stringify(c.controlGuard(e)) === JSON.stringify(guard) && !!c.clickPoint(e);
          },
          {node: saved.node, guard: saved.guard},
        );
        if (!actionable)
          return {
            status: 'stale',
            executed: false,
            message: 'The select field is covered or the field changed.',
          };
        began = true;
        await handle.asElement().selectOption({index: match.index}, {timeout: 2000});
        await new Promise((resolve) => setTimeout(resolve, 100));
        const actual = await handle.evaluate((e) =>
            e.isConnected ? {value: e.value, index: e.selectedIndex} : null,
          ),
          verified = actual?.value === match.value && actual?.index === match.index;
        if (!verified) {
          const state = progressKey(await slot.page.evaluate(reader));
          rememberProgress(slot, key, state, state);
        }
        return {
          status: verified ? 'ready' : 'uncertain',
          executed: true,
          selection: {
            value: match.value,
            label: match.label,
            actual: actual?.value ?? null,
            verified,
          },
        };
      } finally {
        await handle.dispose();
        await releaseRendering();
      }
    }
    if (name === 'browser_reveal') {
      const handle = await slot.page.evaluateHandle(
        (node) => window.__jevFast.nodes.get(node),
        saved.node,
      );
      try {
        began = true;
        await revealInView(slot, handle.asElement());
      } finally {
        await handle.dispose();
      }
    } else {
      began = true;
      const height = await slot.page.evaluate(
        (node) => window.__jevFast.nodes.get(node).clientHeight,
        saved.node,
      );
      await wheelScrollNode(slot, {
        node: saved.node,
        delta: Math.round((args.direction === 'down' ? 1 : -1) * Math.min(560, height * 0.8)),
      });
    }
    const after = await slot.page.evaluate(reader),
      progress = rememberProgress(slot, key, before, progressKey(after));
    if (name === 'browser_reveal') {
      const visible = after.controls.find((c) => c.node === saved.node)?.visible === true;
      const concealed = visible ? false : await concealedByPage(slot, saved.node);
      return {
        status: visible ? 'ready' : 'no_progress',
        executed: true,
        progress,
        visible,
        ...(!visible ? {concealed, message: concealed ? concealedMessage : stalled.message} : {}),
      };
    }
    return {
      status: progress ? 'ready' : 'no_progress',
      executed: true,
      progress,
      ...(!progress ? {message: stalled.message} : {}),
    };
  } catch (error) {
    if (!began) throw error;
    return {
      status: 'uncertain',
      executed: 'unknown',
      message:
        'Could not verify the action result; check the current observation. ' +
        error.message.split('\n')[0],
    };
  }
}

// Keep complete short field IDs every time; never truncate an ID or a consent
// label. Large dropdown options stay in the page, accessible by exact answer.
export function compactElements(elements) {
  return elements.map(({options, ...e}) => ({
    ...e,
    ...(options
      ? {
          optionCount: options.length,
          options: options
            .slice(0, 5)
            .map((o) => ({...o, label: o.label.split(' → ').slice(1).join(' → ')})),
          optionsOmitted: Math.max(0, options.length - 5),
        }
      : {}),
  }));
}
// A model often requests full=true after every action. An explicit lost-base
// reason distinguishes reconstruction from routine fresh reads; neither path
// skips the actual page observation or outcome verification.
export function observationPolicy(name, args, status) {
  const recovery =
    name === 'browser_observe' && args.full === true && args.fullReason === 'context_loss';
  return {
    standalone: true,
    full:
      name === 'browser_open_page' ||
      recovery ||
      (name === 'browser_select_choice' && ['stale', 'blocked'].includes(status)) ||
      (name === 'browser_fill_fields' && ['stale', 'invalid_target'].includes(status)),
  };
}
export function presentObservation(slot, value, {full = false, standalone = false} = {}) {
  if (!value.elements) return value;
  const previous = slot.presented,
    ownerChanged = slot.presentedOwner !== slot.owner,
    observationId = randomUUID();
  slot.presentedOwner = slot.owner;
  slot.presented = {...value, observationId, mapDeltas: true};
  if (full || !previous || ownerChanged || previous.url !== value.url)
    return {
      ...slot.presented,
      observationMode: 'full',
      ...(standalone ? {controlMaps: 'replace'} : {}),
    };
  if (standalone) {
    // Actionable state is a complete current replacement, never a patch that
    // requires the model to reconstruct opaque IDs from earlier turns.
    const compact = {
      ...slot.presented,
      observationMode: 'compact',
      controlMaps: 'replace',
      mapDeltas: false,
    };
    // elements duplicates clickTargets/controls; model next/act uses the
    // original internal snapshot, which is retained untouched.
    delete compact.elements;
    if (same(previous.text, value.text)) {
      delete compact.text;
      compact.textUnchanged = true;
    }
    if (same(previous.links, value.links)) delete compact.links;
    if (Array.isArray(value.history)) compact.history = value.history.slice(-1);
    return compact;
  }
  const delta = {
    ...slot.presented,
    baseObservationId: previous.observationId,
    observationMode: 'delta',
  };
  for (const key of ['text', 'links', 'title'])
    if (same(previous[key], value[key])) delete delta[key];
  delta.elements = value.elements.filter(
    (e) => !previous.elements.some((old) => old.index === e.index && same(old, e)),
  );
  delta.removedElements = previous.elements
    .filter((old) => !value.elements.some((e) => e.index === old.index))
    .map((e) => e.index);
  // IDs survive only while their owner, DOM identity and meaning match.
  // The consumed click/fill ID is retired; unaffected IDs remain usable.
  for (const [key, id, removed] of [
    ['controls', 'controlId', 'removedControls'],
    ['clickTargets', 'targetId', 'removedClickTargets'],
    ['fillFields', 'fieldId', 'removedFillFields'],
    ['scrollTargets', 'controlId', 'removedScrollTargets'],
  ]) {
    if (!Array.isArray(value[key])) continue;
    const before = new Map((previous[key] ?? []).map((item) => [item[id], item]));
    const current = new Map(value[key].map((item) => [item[id], item]));
    delta[key] = [...current.values()].filter((item) => !same(before.get(item[id]), item));
    delta[removed] = [...before.keys()].filter((id) => !current.has(id));
  }
  // History is context, not an action map. Keep the latest change only; a
  // full observation still carries the recent history for recovery.
  if (same(previous.history, value.history)) delete delta.history;
  else if (Array.isArray(value.history)) delta.history = value.history.slice(-1);
  // Upload handles are still one-observation replacements.
  return delta;
}

// A scroll action turns the wheel over the scrolled element, as a person does.
// Where no visible point of the element takes the wheel (it is covered, sits
// in an iframe, or a nested list under the pointer would scroll instead), or
// the wheel covered much less than the distance, the rest scrolls directly.
export async function wheelScrollNode(slot, {node, delta}, signal) {
  const read = (request) =>
    slot.page.evaluate(
      ({node, delta, plan}) => {
        let e = window.__jevFast.nodes.get(node);
        const pageScroll = [
          document.scrollingElement,
          document.documentElement,
          document.body,
        ].includes(e);
        if (pageScroll) e = document.scrollingElement ?? document.documentElement;
        if (!plan) return {top: e.scrollTop};
        if (location.ancestorOrigins.length) return {top: e.scrollTop};
        // The first ancestor that can still scroll in this direction takes the wheel.
        const owner = (hit) => {
          for (
            let n = hit;
            n && n !== document.body && n !== document.documentElement;
            n = n.parentElement
          ) {
            const style = getComputedStyle(n);
            if (
              /(auto|scroll|overlay)/.test(style.overflowY) &&
              n.scrollHeight > n.clientHeight &&
              (delta > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0)
            )
              return n;
          }
          return document.scrollingElement ?? document.documentElement;
        };
        const r = pageScroll
            ? {left: 0, top: 0, right: innerWidth, bottom: innerHeight}
            : e.getBoundingClientRect(),
          left = Math.max(r.left, 0),
          right = Math.min(r.right, innerWidth),
          up = Math.max(r.top, 0),
          down = Math.min(r.bottom, innerHeight);
        if (right - left >= 4 && down - up >= 4)
          for (const [fx, fy] of [
            [0.5, 0.5],
            [0.3, 0.5],
            [0.7, 0.5],
            [0.5, 0.3],
            [0.5, 0.7],
          ]) {
            const x = left + (right - left) * fx,
              y = up + (down - up) * fy,
              hit = document.elementFromPoint(x, y);
            if (hit && owner(hit) === e) return {top: e.scrollTop, x, y};
          }
        return {top: e.scrollTop};
      },
      {node, delta, plan: request},
    );
  const before = await read(true);
  if (before.x !== undefined && (await wheelScroll(slot.page, before, delta, {signal}))) {
    // Wheel scrolling animates; let it come to rest before measuring.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const moved = (await read(false)).top - before.top;
    if (Math.abs(delta - moved) <= Math.abs(delta) * 0.3) return;
    delta -= moved;
  }
  await slot.page.evaluate(
    ({node, delta}) => window.__jevFast.nodes.get(node).scrollBy({top: delta, behavior: 'instant'}),
    {node, delta},
  );
}
