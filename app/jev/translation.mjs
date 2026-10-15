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

export async function installNoTranslate(page) {
  let pending = installed.get(page);
  if (pending) return pending;
  pending = (async () => {
    await page.addInitScript(markNoTranslate);
    await Promise.race([
      page.evaluate(markNoTranslate).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, CURRENT_DOCUMENT_MS).unref?.()),
    ]);
  })().catch((error) => {
    installed.delete(page);
    throw error;
  });
  installed.set(page, pending);
  return pending;
}
