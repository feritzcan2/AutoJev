import {blockedRepeat, rememberProgress, progressKey, stalled} from './navigation.mjs';
import {revealInView} from './rendering.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const choiceKey = (node) => JSON.stringify(['choice', node]);
export async function verifyChoice(slot, node, choice, expected) {
  const deadline = Date.now() + 1000;
  let actual = null,
    verified = false;
  do {
    const current = await slot.page.evaluate(
      (node) => window.__jevFast?.choice(window.__jevFast.nodes.get(node)),
      node,
    );
    const matching =
      current &&
      current.question === choice.question &&
      current.option === choice.option &&
      current.attribute === choice.attribute;
    actual = matching ? current.selected : null;
    verified = matching && actual === expected;
    if (verified) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return {question: choice.question, option: choice.option, expected, actual, verified: !!verified};
}

// Select an exact observed answer; no model, inferred answer or hidden input writes.
export async function selectChoice(slot, args, owner, reader) {
  const stale = {
    status: 'stale',
    reason: 'control_changed',
    executed: false,
    message: 'The option changed; use the returned current controls list. No extra observe is needed.',
  };
  const saved = slot.controls?.get(args.controlId);
  if (!saved) return {...stale, reason: 'unknown_control'};
  if (saved.owner !== owner) throw Error('A current controlId of this session is required.');
  const current = await slot.page.evaluate(reader);
  if (saved.kind !== 'control' || !same(current?.control_guards?.[saved.node], saved.guard))
    return stale;
  const choice = current.controls.find((c) => c.node === saved.node)?.choice;
  if (!choice?.question || typeof choice.selected !== 'boolean')
    return {
      status: 'unsupported',
      executed: false,
      message:
        'This control is not a radio/checkbox option. For a dropdown or combobox, read the options with browser_interact options, then use select or autocomplete. For buttons, use the clickTargets targetId.',
    };
  const key = choiceKey(saved.node),
    before = progressKey(current);
  if (blockedRepeat(slot, key, before)) return stalled;
  slot.pending = null;
  const handle = await slot.page.evaluateHandle(
    (node) => window.__jevFast.nodes.get(node),
    saved.node,
  );
  let clicked = false;
  try {
    // Do not let a submit/reset control masquerade as a choice. Ashby-style
    // non-form buttons and explicit type=button toggles are both supported.
    const supported = await handle.evaluate((e) => {
      const button = e.closest('button');
      return (
        !e.closest('a[href]') &&
        !e.matches('input[type="submit"],input[type="reset"],input[type="image"]') &&
        !(button?.form && button.type !== 'button')
      );
    });
    if (!supported)
      return {
        status: 'unsupported',
        executed: false,
        message: 'A submit button cannot be used as an answer option.',
      };
    if (choice.selected)
      return {
        status: 'ready',
        executed: false,
        selection: {
          question: choice.question,
          option: choice.option,
          expected: true,
          actual: true,
          verified: true,
        },
      };
    const notActionable = (reason) => ({
      status: 'blocked',
      reason,
      executed: false,
      message:
        'The option exists, but no safe click point was found. Inspect the obstruction in the returned full observation; the field is not considered gone. Do not repeat the same action unchanged.',
    });
    const target = await handle.evaluateHandle((e) => window.__jevFast.scrollTarget(e));
    try {
      if (!target.asElement()) return notActionable('target_not_visible');
      try {
        await revealInView(slot, target.asElement());
      } catch {
        return notActionable('reveal_failed');
      }
    } finally {
      await target.dispose();
    }
    const point = await slot.page.evaluate(
      ({node, guard}) => {
        const c = window.__jevFast,
          e = c.nodes.get(node);
        return JSON.stringify(c.controlGuard(e)) === JSON.stringify(guard)
          ? {point: c.clickPoint(e)}
          : {changed: true};
      },
      {node: saved.node, guard: saved.guard},
    );
    if (point.changed) return stale;
    if (!point.point) return notActionable('no_safe_click_point');
    clicked = true;
    for (const type of ['mousePressed', 'mouseReleased'])
      await slot.cdp.send('Input.dispatchMouseEvent', {
        type,
        ...point.point,
        button: 'left',
        clickCount: 1,
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const selection = await verifyChoice(slot, saved.node, choice, true);
    slot.history.push({
      action: choice.question + ' → ' + choice.option,
      kind: 'click',
      operation: 'SELECT_CHOICE',
    });
    slot.history = slot.history.slice(-60);
    if (!selection.verified) {
      const after = progressKey(await slot.page.evaluate(reader));
      rememberProgress(slot, key, after, after);
    }
    return {
      status: selection.verified ? 'ready' : 'uncertain',
      executed: true,
      selection,
      ...(!selection.verified ? {retryBlocked: true} : {}),
      message: selection.verified
        ? 'The answer was verified as selected. Use the current observation; no extra observe/screenshot is needed.'
        : 'The click was made, but the answer selection could not be verified. Do not repeat the same action; inspect the returned current evidence.',
    };
  } catch (error) {
    if (!clicked) throw error;
    const after = await slot.page.evaluate(reader).catch(() => null);
    if (after) {
      const state = progressKey(after);
      rememberProgress(slot, key, state, state);
    }
    return {
      status: 'uncertain',
      executed: 'unknown',
      retryBlocked: true,
      message: 'Could not verify the answer selection; do not repeat the same action.',
    };
  } finally {
    await handle.dispose();
  }
}
