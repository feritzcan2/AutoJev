// @ts-check
// When Chrome may take the screen. Write tools on a hidden tab bring that tab
// forward (Chrome only paints the front tab), and on macOS that activates
// Chrome and takes keyboard focus from whatever the person is typing in.
// The desktop app installs the policy; without one (tests, CLI) Chrome may
// always come forward and there is nothing to give focus back to.

/** Seconds without keyboard or mouse input, system wide, before Chrome may come forward. */
export const IDLE_BEFORE_FOREGROUND = 8;
/** Longest wait for a pause; after it the write goes ahead so autopilot is never stuck. */
export const MAX_FOREGROUND_WAIT_MS = 3 * 60 * 1000;

const defaults = {
  /** @returns {number} */ idleSeconds: () => Infinity,
  /** @returns {boolean} */ appFocused: () => false,
  refocusApp: () => {},
};
let policy = defaults;

/** @param {Partial<typeof defaults>} next */
export function setForegroundPolicy(next) {
  policy = {...defaults, ...next};
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      {once: true},
    );
  });

// Waits until the person has paused, so a tab coming forward never lands
// in the middle of their typing.
export async function waitForForegroundTurn({
  signal,
  pollMs = 1000,
  maxWaitMs = MAX_FOREGROUND_WAIT_MS,
} = {}) {
  const start = Date.now();
  while (policy.idleSeconds() < IDLE_BEFORE_FOREGROUND && Date.now() - start < maxWaitMs) {
    signal?.throwIfAborted();
    await sleep(pollMs, signal);
  }
  signal?.throwIfAborted();
}

export const appHasFocus = () => {
  try {
    return policy.appFocused();
  } catch {
    return false;
  }
};
export const refocusApp = () => {
  try {
    policy.refocusApp();
  } catch {}
};
