// Jev's page.evaluate runs in an isolated world (Patchright), where globals and
// handlers the page's own scripts set (onclick="window.clicks++" ...) are not
// visible. Smokes build and check their fixtures in the page's main world, as
// the page's own scripts do.
export const inPageWorld = (page, fn, arg) =>
  page.evaluateInPageWorld
    ? page.evaluateInPageWorld(fn, arg)
    : page.mainFrame().evaluate(fn, arg, undefined, false);
