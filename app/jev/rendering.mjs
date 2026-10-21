import {wheelReveal} from '../browser/human-input.mjs';

// Ordinary Chrome pauses animation frames in background tabs. Playwright's
// visibility/stability checks need those frames even for a ready document.
// Resume only the owned tab for the current operation, without activating a
// window or changing DOM visibility. Nested reads share the same lifetime.
const active = new WeakMap();
async function bounded(operation, {signal, timeoutMs}) {
  signal?.throwIfAborted();
  let timer, abort;
  const stopped = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(
            Error(
              'Background rendering of the tab was not ready in time; report the technical blocker on the same tab.',
            ),
            {code: 'TAB_RENDER_TIMEOUT'},
          ),
        ),
      timeoutMs,
    );
    if (signal) {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, {once: true});
    }
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return operation();
      }),
      stopped,
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
// Whether the tab is hidden. A page whose scripts do not answer is frozen or
// not running, which Chrome does to a tab in a covered or background window:
// wake it through the browser and treat it as hidden, so focus emulation
// turns its rendering on. The operation that follows keeps its own bound.
async function visibility(slot, {signal, timeoutMs}) {
  try {
    return await bounded(() => slot.page.evaluate(() => document.visibilityState === 'hidden'), {
      signal,
      timeoutMs,
    });
  } catch (error) {
    if (error.code !== 'TAB_RENDER_TIMEOUT') throw error;
    await bounded(() => slot.cdp.send('Page.setWebLifecycleState', {state: 'active'}), {
      signal,
      timeoutMs,
    }).catch(() => {});
    signal?.throwIfAborted();
    return true;
  }
}
export async function acquireTabRendering(
  slot,
  {signal, hidden, foreground = false, timeoutMs = 2000} = {},
) {
  signal?.throwIfAborted();
  if (!slot.cdp) return () => {};
  let state = active.get(slot);
  if (state?.stopping) {
    await bounded(() => state.stopping, {signal, timeoutMs});
    return acquireTabRendering(slot, {signal, hidden, foreground, timeoutMs});
  }
  if (!state) {
    state = {users: 0, enabled: false};
    active.set(slot, state);
    state.ready = (async () => {
      if ((hidden ?? (await visibility(slot, {signal, timeoutMs}))) !== true) return;
      signal?.throwIfAborted();
      // Focus emulation alone makes a background tab (even in a minimized
      // window) visible and painting, so reads and form writes (fill, click,
      // upload, scroll) work without activating the tab or raising Chrome over
      // the user's work. Only callers that need the real foreground (a captcha
      // click) ask for it.
      if (foreground) {
        await bounded(() => slot.bringToFront?.() ?? slot.page.bringToFront(), {
          signal,
          timeoutMs,
        }).catch(() => {});
        signal?.throwIfAborted();
      }
      state.enabled = true;
      await bounded(() => slot.cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true}), {
        signal,
        timeoutMs,
      });
    })();
  }
  state.users++;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (--state.users) return;
    state.stopping = (async () => {
      await state.ready.catch(() => {});
      // Cleanup has its own bound: cancellation still restores the same tab.
      if (state.enabled)
        await bounded(() => slot.cdp.send('Emulation.setFocusEmulationEnabled', {enabled: false}), {
          timeoutMs,
        }).catch(() => {});
      if (active.get(slot) === state) active.delete(slot);
    })();
    await state.stopping;
  };
  try {
    await bounded(() => state.ready, {signal, timeoutMs});
    signal?.throwIfAborted();
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}

// Playwright's scrollIntoViewIfNeeded waits for stable animation frames, which a
// background tab never delivers. Run the step with the tab's own rendering on.
// The wheel brings the element into view first, as a person scrolls; where it
// cannot (an iframe, a covered container), the direct scroll does.
export async function revealInView(slot, handle, {signal, timeoutMs = 2000} = {}) {
  const release = await acquireTabRendering(slot, {signal, timeoutMs});
  try {
    await wheelReveal(slot.page, handle, {signal}).catch((error) => {
      if (signal?.aborted) throw error;
    });
    await handle.scrollIntoViewIfNeeded({timeout: timeoutMs});
    // An element already inside the viewport can still sit under a sticky
    // header or bar; scrollIntoViewIfNeeded then does nothing. Center it once.
    await handle.evaluate((e) => {
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      const root = e.getRootNode(),
        hit = (root.elementFromPoint ? root : document).elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
      if (hit && !e.contains(hit) && !hit.contains(e))
        e.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'});
    });
  } finally {
    await release();
  }
}
