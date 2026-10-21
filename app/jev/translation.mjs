// Chrome's page translation rewrites visible labels between runs ("Weiter"
// becomes "Further" or "Continue to the overview"), so an agent cannot match a
// remembered control and sees translated duplicates in the control map. Owned
// Jev tabs opt out with the notranslate meta Chrome checks before it offers or
// auto-applies a translation. The user's own tabs stay untouched.
const installed = new WeakMap();
// Marking the current document is best effort: a page whose script context
// never answers (for example an error page restored from an earlier run)
// must not hold the tab's setup. The init script covers its next document.
const CURRENT_DOCUMENT_MS = 5000;

export function markNoTranslate() {
  const mark = () => {
    const root = document.documentElement,
      head = document.head;
    if (!root || !head) return false;
    root.setAttribute('translate', 'no');
    if (!head.querySelector('meta[name="google"][content="notranslate"]')) {
      const meta = document.createElement('meta');
      meta.name = 'google';
      meta.content = 'notranslate';
      head.prepend(meta);
    }
    return true;
  };
  if (mark()) return;
  // At document start the head does not exist yet; mark it as soon as it does.
  const observer = new MutationObserver(() => {
    if (mark()) observer.disconnect();
  });
  observer.observe(document, {childList: true, subtree: true});
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      mark();
      observer.disconnect();
    },
    {once: true},
  );
}

// The script runs in an isolated world of its own, so the page's scripts see
// the marked document but never Jev's code or a script registered in their
// own world.
const WORLD = 'jev-notranslate';

export async function installNoTranslate(slot) {
  let pending = installed.get(slot);
  if (pending) return pending;
  const source = `(${markNoTranslate})()`;
  pending = (async () => {
    await slot.cdp.send('Page.addScriptToEvaluateOnNewDocument', {source, worldName: WORLD});
    const current = (async () => {
      const {frameTree} = await slot.cdp.send('Page.getFrameTree'),
        {executionContextId} = await slot.cdp.send('Page.createIsolatedWorld', {
          frameId: frameTree.frame.id,
          worldName: WORLD,
        });
      await slot.cdp.send('Runtime.evaluate', {expression: source, contextId: executionContextId});
    })();
    await Promise.race([
      current.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, CURRENT_DOCUMENT_MS).unref?.()),
    ]);
  })().catch((error) => {
    installed.delete(slot);
    throw error;
  });
  installed.set(slot, pending);
  return pending;
}
