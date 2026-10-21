// @ts-check
import {setTimeout as delay} from 'node:timers/promises';

// Pointer, keyboard and wheel input the way a person produces it. A page (or
// a bot-protection script on it) sees every mouse move, key and wheel event;
// a click without a preceding move, a value that appears without key events,
// a scroll that jumps in one frame or input at a fixed beat reads as automated.
// Every wait is short, random and cancellable through the caller's signal.

/** @typedef {{signal?: AbortSignal, deadline?: number, check?: () => unknown, notice?: number[], rounds?: number}} InputOptions */

const between = (min, max) => min + Math.random() * (max - min);
const pause = (min, max, signal) => delay(between(min, max), undefined, {signal});

// The last pointer position this helper left on each page, so a second click
// starts where the pointer actually rests instead of appearing somewhere new.
const pointers = new WeakMap();

// A click the way a person makes it: a short pause to notice the target, then
// the pointer travels along a slight curve with a little hand tremor, speeding
// up and slowing down (longer moves take longer), sometimes overshoots a few
// pixels and corrects, rests on the target (hover), then presses and releases.
// Mouse events carry whole pixels, as a real mouse does. The landing point
// stays within 4 px of the target centre, so the caller's hit-test of that
// point still applies. `check` (may be async) runs before the approach and
// again right before the press, and stops the click by throwing when the task
// or the target changed meanwhile. A verification checkbox keeps the longer
// default notice pause; routine controls pass a shorter one.
/** @param {any} page @param {number} x @param {number} y @param {() => unknown} [check] @param {InputOptions} [options] */
export async function humanClick(page, x, y, check = () => {}, {notice = [250, 700], signal} = {}) {
  let at = null;
  const move = async (px, py) => {
    const next = {x: Math.max(0, Math.round(px)), y: Math.max(0, Math.round(py))};
    // A real mouse sends no event when the pointer stays on the same pixel.
    if (at && at.x === next.x && at.y === next.y) return;
    at = next;
    await page.mouse.move(next.x, next.y);
  };
  let from = pointers.get(page);
  if (!from || Math.hypot(from.x - x, from.y - y) < 40) {
    const angle = between(0, 2 * Math.PI),
      distance = between(120, 320);
    from = {x: x + Math.cos(angle) * distance, y: y + Math.sin(angle) * distance};
  }
  await pause(notice[0], notice[1], signal);
  await check();
  await move(from.x, from.y);
  const to = {x: x + between(-2, 2), y: y + between(-2, 2)},
    distance = Math.hypot(to.x - from.x, to.y - from.y),
    ux = (to.x - from.x) / distance,
    uy = (to.y - from.y) / distance,
    // Most longer reaches end a few pixels past the target, then come back.
    overshoot = distance > 80 && Math.random() < 0.6 ? between(3, 8) : 0,
    aim = {x: to.x + ux * overshoot, y: to.y + uy * overshoot},
    bend = between(-0.2, 0.2) * distance,
    control = {x: (from.x + aim.x) / 2 - uy * bend, y: (from.y + aim.y) / 2 + ux * bend},
    // Fitts's law for a ~24 px target, with person-to-person variation.
    duration = (120 + 110 * Math.log2(distance / 24 + 1)) * between(0.85, 1.25),
    steps = Math.max(8, Math.round(duration / 16));
  for (let i = 1; i <= steps; i++) {
    // Minimum-jerk profile: slow start, fast middle, slow final approach.
    const t = i / steps,
      e = t * t * t * (10 - 15 * t + 6 * t * t),
      u = 1 - e,
      tremor = i < steps ? between(-0.8, 0.8) * (1 - t) : 0;
    await move(
      u * u * from.x + 2 * u * e * control.x + e * e * aim.x - uy * tremor,
      u * u * from.y + 2 * u * e * control.y + e * e * aim.y + ux * tremor,
    );
    await pause(10, 22, signal);
  }
  if (overshoot) {
    await pause(40, 110, signal);
    const back = Math.round(between(2, 4));
    for (let i = 1; i <= back; i++) {
      const t = i / back;
      await move(aim.x + (to.x - aim.x) * t, aim.y + (to.y - aim.y) * t);
      await pause(14, 30, signal);
    }
  }
  // The hand is not perfectly still while hovering.
  await pause(60, 160, signal);
  if (Math.random() < 0.5) {
    await move(to.x + between(-1, 1), to.y + between(-1, 1));
    await pause(40, 120, signal);
  }
  pointers.set(page, at);
  await check();
  await page.mouse.down();
  await pause(55, 140, signal);
  await page.mouse.up();
}

// The pause before a routine control: the person already looks at the form.
export const ROUTINE_NOTICE = [60, 220];

// A point on the element that a click there really reaches (not a cover, a
// sticky bar or a neighbour), in the coordinates of the top page, so an
// element inside an iframe works too. Null when no such point is visible.
export async function elementClickPoint(handle) {
  const local = await Promise.resolve()
    .then(() =>
      handle.evaluate((e) => {
        const rects = [...e.getClientRects()].filter((r) => r.width >= 1 && r.height >= 1),
          r = rects[0];
        if (!r) return null;
        const root = e.getRootNode(),
          scope = /** @type {Document | ShadowRoot} */ (
            'elementFromPoint' in root ? root : e.ownerDocument
          );
        const reaches = (x, y) => {
          const hit = scope.elementFromPoint(x, y);
          return !!hit && (e === hit || e.contains(hit));
        };
        const box = e.getBoundingClientRect();
        // The centre first, then the middle of the left part, where a text
        // field's own text and a button's label usually sit.
        for (const [fx, fy] of [
          [0.5, 0.5],
          [0.3, 0.5],
          [0.7, 0.5],
          [0.5, 0.3],
          [0.5, 0.7],
        ]) {
          const x = r.x + r.width * fx,
            y = r.y + r.height * fy;
          if (x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight && reaches(x, y))
            return {x, y, box: {x: box.x, y: box.y, width: box.width, height: box.height}};
        }
        return null;
      }),
    )
    .catch(() => null);
  if (!local) return null;
  // boundingBox is relative to the top page, through any iframes.
  const box = await handle.boundingBox().catch(() => null);
  if (!box || local.box.width < 1 || local.box.height < 1) return null;
  return {
    x: box.x + (local.x - local.box.x) * (box.width / local.box.width),
    y: box.y + (local.y - local.box.y) * (box.height / local.box.height),
  };
}

// A human click on an element handle. False (nothing sent) when no point of
// the element can be reached; the caller then uses its own fallback.
/** @param {any} page @param {any} handle @param {InputOptions} [options] */
export async function humanClickElement(page, handle, {check = () => {}, signal} = {}) {
  const point = await elementClickPoint(handle);
  if (!point) return false;
  await humanClick(page, point.x, point.y, check, {notice: ROUTINE_NOTICE, signal});
  return true;
}

async function press(page, key, signal) {
  await page.keyboard.down(key);
  await pause(25, 85, signal);
  await page.keyboard.up(key);
}

// Characters a US keyboard types with Shift held.
const SHIFTED = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/;
// Longer text, or text over several lines, arrives at once, as a person
// pastes a prepared answer; typing it key by key would take minutes.
const TYPED_LIMIT = 80;
// Text in the focused field, key by key: each key goes down, is held briefly
// and comes up, at an uneven pace with an occasional pause between words.
// Characters outside the plain US layout (ü, ğ, é) and line breaks are
// inserted as text, the way an input method or a paste delivers them; a line
// break is never an Enter that could submit the form. After `deadline` (ms
// since the epoch) the rest is inserted at once.
/** @param {any} page @param {string} text @param {InputOptions} [options] */
export async function humanType(page, text, {deadline = Infinity, signal} = {}) {
  if (text.length > TYPED_LIMIT || /[\r\n]/.test(text)) {
    await pause(150, 450, signal);
    await page.keyboard.insertText(text);
    return;
  }
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (Date.now() > deadline) {
      await page.keyboard.insertText(chars.slice(i).join(''));
      return;
    }
    if (!/^[ -~]$/.test(char)) await page.keyboard.insertText(char);
    else if (SHIFTED.test(char)) {
      await page.keyboard.down('Shift');
      await pause(20, 60, signal);
      await press(page, char, signal);
      await page.keyboard.up('Shift');
    } else await press(page, char, signal);
    await pause(45, 170, signal);
    if (char === ' ' && Math.random() < 0.12) await pause(150, 450, signal);
  }
}

// Field types whose value a person picks from a widget, not types; these
// keep Playwright's fill.
const PICKED = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
// Replaces the text of a field the way a person does: clicks into it (or, when
// no point of it can be reached, focuses it), selects what is there, then types
// the new text or deletes the old one. `check` runs before the click.
/** @param {any} page @param {any} handle @param {string} text @param {InputOptions} [options] */
export async function humanFill(page, handle, text, {deadline, signal, check} = {}) {
  const type = await handle.evaluate((e) => (e.tagName === 'INPUT' ? e.type : '')).catch(() => '');
  if (PICKED.has(type)) {
    await handle.fill(text, {timeout: 2000});
    return;
  }
  if (!(await humanClickElement(page, handle, {check, signal}))) {
    await check?.();
    await handle.focus();
  }
  const focused = await handle.evaluate((e) => {
    const active = /** @type {Document | ShadowRoot} */ (e.getRootNode()).activeElement;
    return !!active && (active === e || e.contains(active));
  });
  // A click on the field's label part or a wrapper did not focus the editor.
  if (!focused) await handle.focus();
  await pause(80, 220, signal);
  await replaceFocusedText(page, text, {deadline, signal});
}

// Selects the text of the focused field and types the new text over it, or
// deletes it when the new text is empty.
/** @param {any} page @param {string} text @param {InputOptions} [options] */
export async function replaceFocusedText(page, text, {deadline, signal} = {}) {
  await page.keyboard.down('ControlOrMeta');
  await pause(30, 80, signal);
  await press(page, 'a', signal);
  await page.keyboard.up('ControlOrMeta');
  await pause(60, 180, signal);
  if (text) await humanType(page, text, {deadline, signal});
  else await press(page, 'Backspace', signal);
}

const WHEEL_CALL_MS = 2000;
// Wheel notches until `delta` pixels (negative: up) are scrolled at `point`,
// with the pointer moved there first. Each notch is 60-120 px, as a mouse
// wheel or a trackpad swipe delivers. Returns false when the browser did not
// take a notch in time; the caller then scrolls the old way.
/** @param {any} page @param {{x: number, y: number}} point @param {number} delta @param {InputOptions} [options] */
export async function wheelScroll(page, point, delta, {signal} = {}) {
  const from = pointers.get(page);
  if (!from || Math.hypot(from.x - point.x, from.y - point.y) > 3) {
    const x = Math.round(point.x + between(-6, 6)),
      y = Math.round(point.y + between(-6, 6));
    await page.mouse.move(x, y, {steps: Math.round(between(3, 7))});
    pointers.set(page, {x, y});
  }
  await pause(40, 140, signal);
  let left = delta;
  while (Math.abs(left) >= 1) {
    const step = Math.sign(left) * Math.min(Math.abs(left), Math.round(between(60, 120)));
    let timer;
    const sent = await Promise.race([
      page.mouse.wheel(0, step).then(
        () => true,
        () => false,
      ),
      new Promise((resolve) => (timer = setTimeout(() => resolve(false), WHEEL_CALL_MS))),
    ]).finally(() => clearTimeout(timer));
    if (!sent) return false;
    left -= step;
    await pause(25, 90, signal);
  }
  return true;
}

// Scrolls an element into the middle part of the viewport with wheel notches
// over its scroll container, a bounded number of rounds. False when the
// element sits in an iframe, no point over its container takes the wheel, or
// the wheel moved nothing; the caller then reveals it the old way.
/** @param {any} page @param {any} handle @param {InputOptions} [options] */
export async function wheelReveal(page, handle, {signal, rounds = 6} = {}) {
  for (let round = 0; round < rounds; round++) {
    signal?.throwIfAborted();
    const plan = await handle
      .evaluate((e) => {
        // window.top differs from window in an isolated world even in the
        // top document; the ancestor list is empty only there.
        if (location.ancestorOrigins.length) return null;
        const r = e.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) return null;
        const top = innerHeight * 0.15,
          bottom = innerHeight * 0.85;
        if (r.top >= top && r.bottom <= bottom) return {done: true};
        if (r.height > bottom - top && r.top <= top && r.bottom >= top) return {done: true};
        const delta = r.top + r.height / 2 - innerHeight / 2,
          vertical = (node) => {
            const style = getComputedStyle(node);
            return (
              /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight
            );
          };
        // The element's own scroll container: the nearest vertically
        // scrollable ancestor, else the page.
        let container = null;
        for (let node = e.parentElement; node; node = node.parentElement) {
          if (node === document.body || node === document.documentElement) break;
          if (vertical(node)) {
            container = node;
            break;
          }
        }
        const area = container
          ? container.getBoundingClientRect()
          : {left: 0, top: 0, right: innerWidth, bottom: innerHeight};
        const left = Math.max(area.left, 0),
          right = Math.min(area.right, innerWidth),
          up = Math.max(area.top, 0),
          down = Math.min(area.bottom, innerHeight);
        if (right - left < 4 || down - up < 4) return null;
        // A point over the container whose own scroll target is the same
        // container (not a nested list or map that would take the wheel).
        for (const [fx, fy] of [
          [0.5, 0.5],
          [0.25, 0.5],
          [0.75, 0.5],
          [0.5, 0.25],
          [0.5, 0.75],
        ]) {
          const x = left + (right - left) * fx,
            y = up + (down - up) * fy,
            hit = document.elementFromPoint(x, y);
          if (!hit) continue;
          let owner = null;
          for (let node = hit; node; node = node.parentElement) {
            if (node === document.body || node === document.documentElement) break;
            if (vertical(node)) {
              owner = node;
              break;
            }
          }
          if (owner === container)
            return {
              x,
              y,
              delta: Math.sign(delta) * Math.min(Math.abs(delta), (down - up) * 0.8),
              at: r.top,
            };
        }
        return null;
      })
      .catch(() => null);
    if (!plan) return false;
    if (plan.done) return true;
    if (!(await wheelScroll(page, plan, plan.delta, {signal}))) return false;
    await pause(80, 200, signal);
    const after = await handle.evaluate((e) => e.getBoundingClientRect().top).catch(() => null);
    if (after === null || Math.abs(after - plan.at) < 1) return false;
  }
  return false;
}
