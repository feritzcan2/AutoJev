import {blockedRepeat, rememberProgress, progressKey, stalled} from './navigation.mjs';
import {revealInView} from './rendering.mjs';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const normalize = (value) => value.replace(/\s+/g, ' ').trim();
// The control id itself no longer matches the page.
export const stale = {
  status: 'stale',
  executed: false,
  message:
    'The control id is stale; use the returned current controls list. No extra observe is needed.',
};

// Scroll the open popup list one step from an option inside it. Long or
// virtualized lists render only part of their options at a time.
async function scrollOptions(page, node, {top = false} = {}) {
  return page.evaluate(
    ({node, top}) => {
      for (let p = window.__jevFast.nodes.get(node)?.parentElement; p; p = p.parentElement) {
        if (p === document.body || p === document.documentElement) return false;
        if (
          p.scrollHeight <= p.clientHeight + 1 ||
          !/auto|scroll/.test(getComputedStyle(p).overflowY)
        )
          continue;
        const before = p.scrollTop;
        p.scrollTop = top ? 0 : before + Math.max(p.clientHeight * 0.8, 40);
        return p.scrollTop !== before;
      }
      return false;
    },
    {node, top},
  );
}

// Query + bounded wait + exact selection. No model, selectors from the caller,
// hidden-field writes, keyboard submission, or fuzzy candidate answers.
export async function selectAutocomplete(slot, args, owner, reader) {
  const listOnly = args.option === undefined;
  const saved = slot.controls?.get(args.controlId);
  if (!saved) return stale;
  if (saved.owner !== owner) throw Error('A current controlId of this session is required.');
  const observed = await slot.page.evaluate(reader);
  if (saved.kind !== 'control' || !same(observed?.control_guards?.[saved.node], saved.guard))
    return stale;
  const key = JSON.stringify([
      listOnly ? 'autocomplete-options' : 'autocomplete',
      saved.node,
      args.text,
      args.option,
    ]),
    before = progressKey(observed);
  const selectionKey = listOnly
    ? null
    : JSON.stringify(['autocomplete-select', saved.node, normalize(args.option)]);
  if (!listOnly && (blockedRepeat(slot, key, before) || blockedRepeat(slot, selectionKey, before)))
    return stalled;
  slot.pending = null;
  const handle = await slot.page.evaluateHandle(
      (node) => window.__jevFast.nodes.get(node),
      saved.node,
    ),
    input = handle.asElement();
  let wrote = false,
    clicked = false,
    opened = false;
  const read = () =>
    input.evaluate((e) => {
      const c = window.__jevFast,
        widget = c.autocomplete(e);
      if (!widget) return null;
      const guard = c.controlGuard(e);
      if (!guard) return null;
      // Query and selected-caption changes are expected during selection;
      // identity, label, ownership and form are not (guard slots 7 and 17).
      return {
        identity: guard.filter((_, i) => i !== 7 && i !== 17),
        value: widget.value ?? e.value,
        valid: (e.validity?.valid ?? true) && e.getAttribute('aria-invalid') !== 'true',
        ...widget,
        options: widget.options.map((o) => ({...o, point: c.clickPoint(c.nodes.get(o.node))})),
        point: c.clickPoint(e),
      };
    });
  const stop = async (status, message, extra = {}) => {
    const state = await slot.page.evaluate(reader).catch(() => null);
    if (state) {
      const after = progressKey(state);
      rememberProgress(slot, key, after, after);
      if (clicked) rememberProgress(slot, selectionKey, after, after);
    }
    return {status, executed: wrote || clicked || opened, message, ...extra};
  };
  try {
    const initial = await read();
    if (initial?.editable === false && !initial.searchable && args.text !== undefined && listOnly)
      return {
        status: 'unsupported',
        executed: false,
        message:
          'This list has no text field; omit text to list its options, or select one with option.',
      };
    if (!initial)
      return {
        status: 'unsupported',
        executed: false,
        message:
          'No suggestion list is associated with this control; use a native select or an observed click target.',
      };
    await revealInView(slot, input);
    let current = await read();
    // An open popup may cover its own trigger; only a closed one needs a click.
    if (!current || !same(current.identity, initial.identity)) return stale;
    if (!current.expanded) {
      if (!current.point)
        return {
          status: 'stale',
          executed: false,
          message: 'The control is covered; nothing was clicked. Close what covers it, then retry.',
        };
      opened = true;
      await slot.page.mouse.click(current.point.x, current.point.y);
    }
    if (args.text !== undefined && initial.editable === false) {
      // A dropdown button: type into the search box its open popup shows.
      const until = Date.now() + 1500;
      while (!(current = await read())?.search && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 100));
      if (!current || !same(current.identity, initial.identity))
        return await stop('stale', 'The control changed; nothing was selected.');
      if (!current.search && listOnly)
        return await stop(
          'unsupported',
          'This dropdown has no search box. Omit text and pass option with the exact label; the tool scrolls a long list to find it. The suggestions below may be only the first part of the list.',
          {suggestions: current.options.map((o) => o.label).slice(0, 20)},
        );
      // With a wanted option the text only aids the search; without a search
      // box the option is picked from the (scrolled) list below.
      if (current.search) {
        const search = await slot.page.evaluateHandle(
          (node) => window.__jevFast.nodes.get(node),
          current.search,
        );
        try {
          wrote = true;
          await search.asElement().fill(args.text, {timeout: 2000});
        } finally {
          await search.dispose();
        }
      }
    } else if (args.text !== undefined) {
      if (current.value !== args.text) {
        wrote = true;
        await input.fill(args.text, {timeout: 2000});
      } else await input.focus();
    }
    let match;
    const deadline = Date.now() + 2500;
    do {
      current = await read();
      if (!current || !same(current.identity, initial.identity))
        return await stop('stale', 'The field changed; nothing was selected.');
      if (listOnly) {
        if (current.options.length) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const matches = current.options.filter((o) => normalize(o.label) === normalize(args.option));
      if (matches.length > 1)
        return await stop(
          'ambiguous',
          'More than one option has the same name; nothing was selected.',
          {
            suggestions: current.options.map((o) => o.label).slice(0, 20),
          },
        );
      if (matches.length === 1) {
        match = matches[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    // A failed or leftover query can filter every option away. Clear it once
    // and read the unfiltered list, so the result names the real choices.
    let cleared = false;
    if (
      !match &&
      !current.options.length &&
      current.editable !== false &&
      normalize(String(current.value ?? ''))
    ) {
      wrote = cleared = true;
      await input.fill('', {timeout: 2000});
      const until = Date.now() + 1500;
      do {
        current = await read();
        if (!current || !same(current.identity, initial.identity))
          return await stop('stale', 'The field changed; nothing was selected.');
        if (!listOnly) {
          const matches = current.options.filter(
            (o) => normalize(o.label) === normalize(args.option),
          );
          if (matches.length === 1) match = matches[0];
        }
        if (match || current.options.length) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < until);
    }
    // The wanted option, or the full list, may lie below the rendered part.
    // Scroll the popup list from its top in bounded steps; never past its end.
    const seen = new Set(current.options.map((o) => o.label));
    if (!match && current.options.length) {
      await scrollOptions(slot.page, current.options[0].node, {top: true}).catch(() => false);
      for (let step = 0; step < 60; step++) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        current = await read();
        if (!current || !same(current.identity, initial.identity))
          return await stop('stale', 'The control changed; nothing was selected.');
        for (const o of current.options) seen.add(o.label);
        if (!listOnly) {
          const matches = current.options.filter(
            (o) => normalize(o.label) === normalize(args.option),
          );
          if (matches.length === 1) match = matches[0];
        }
        if (match || !current.options.length) break;
        if (!(await scrollOptions(slot.page, current.options.at(-1).node).catch(() => false)))
          break;
      }
    }
    if (listOnly)
      return {
        status: 'ready',
        executed: wrote || opened,
        selected: false,
        query: current.value,
        expanded: current.expanded,
        optionCount: seen.size,
        suggestions: [...seen],
        options: current.options.map(({label, selected}) => ({label, selected})),
        message: seen.size
          ? 'Nothing was selected. Call again with option set to the exact label (from suggestions) that matches the proven answer; typed text alone is cleared when the field loses focus.'
          : 'No option is shown for this query. Do not guess; clear the query with text="" to read the list.',
      };
    if (!match)
      return await stop(
        'needs_selection',
        cleared && seen.size
          ? `No option matches "${args.text ?? args.option}"; the query was cleared and suggestions is the full list this field offers. Pick the option with the same meaning as the proven answer, or ask/report if none fits; do not search again for a value that is not offered.`
          : 'No option matches exactly, also after scrolling the whole list. Pick the returned option with the same meaning as the proven answer; do not repeat the same query.',
        {suggestions: [...seen].slice(0, 300), ...(cleared ? {query: ''} : {})},
      );
    // A dropdown list, or an option outside the visible part of the popup
    // (a long list opened without a query), is scrolled into view first.
    if (current.editable === false || !match.point) {
      const optionHandle = await slot.page.evaluateHandle(
        (node) => window.__jevFast.nodes.get(node),
        match.node,
      );
      try {
        await revealInView(slot, optionHandle.asElement());
      } finally {
        await optionHandle.dispose();
      }
      const fresh = await read();
      if (!fresh || !same(fresh.identity, initial.identity))
        return await stop('stale', 'The list changed; nothing was selected.');
    }
    // Recheck the same option immediately before clicking. Never use an old point.
    const point = await input.evaluate((e, {node, label}) => {
      const c = window.__jevFast,
        widget = c.autocomplete(e),
        option = widget?.options.find((o) => o.node === node && o.label === label);
      return option ? c.clickPoint(c.nodes.get(node)) : null;
    }, match);
    if (!point)
      return await stop(
        'stale',
        'The option is covered or the target changed; it was not clicked.',
      );
    clicked = true;
    await slot.page.mouse.click(point.x, point.y);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const verifyUntil = Date.now() + 1000;
    let actual,
      verified = false;
    do {
      const state = await read();
      // A multiple choice adds a chip and may keep its list open.
      const chip = state?.selectedLabels?.find((l) => normalize(l) === normalize(match.label));
      actual = chip || state?.selectedLabels?.[0] || state?.value;
      verified =
        !!state &&
        same(state.identity, initial.identity) &&
        normalize(actual) === normalize(match.label) &&
        state.valid &&
        (!state.expanded || Boolean(chip));
      if (verified) {
        if (state.expanded) await input.press('Escape');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < verifyUntil);
    // Some widgets display a shortened value (e.g. +49 for Germany +49).
    // Reopen the same observed control and require the exact option's selected
    // state; never infer a match from a substring or the click itself.
    if (!verified) {
      let state = await read();
      if (
        state?.selectedLabels.length &&
        state.valid &&
        !state.expanded &&
        same(state.identity, initial.identity) &&
        state.point
      ) {
        await slot.page.mouse.click(state.point.x, state.point.y);
        const until = Date.now() + 1000;
        let selected = false;
        do {
          state = await read();
          const matches =
            state?.options.filter((o) => normalize(o.label) === normalize(match.label)) ?? [];
          selected =
            !!state &&
            same(state.identity, initial.identity) &&
            matches.length === 1 &&
            matches[0].selected === true;
          if (selected) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < until);
        await input.press('Escape');
        state = await read();
        verified =
          selected &&
          !!state &&
          same(state.identity, initial.identity) &&
          state.valid &&
          !state.expanded;
        actual = state?.selectedLabels?.[0] || state?.value;
      }
    }
    slot.history.push({action: match.label, kind: 'select', operation: 'AUTOCOMPLETE'});
    slot.history = slot.history.slice(-60);
    const selection = {label: match.label, actual, verified};
    if (!verified)
      return await stop(
        'uncertain',
        'The option was clicked, but its acceptance could not be verified. Inspect the returned form evidence; do not blindly repeat the action.',
        {selection},
      );
    return {
      status: 'ready',
      executed: true,
      selection,
      message:
        'The autocomplete selection was verified. Use the returned current observation; no extra observe or screenshot is needed.',
    };
  } catch (error) {
    if (!wrote && !clicked && !opened) throw error;
    return await stop(
      'uncertain',
      'Could not verify the autocomplete result; inspect the returned observation. ' +
        error.message.split('\n')[0],
    );
  } finally {
    await handle.dispose();
  }
}
