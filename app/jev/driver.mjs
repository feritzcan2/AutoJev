// @ts-check
import {createRequire} from 'node:module';

// Jev drives Chrome through Patchright, Playwright with its page-visible CDP
// traces removed: Runtime.enable is never sent to a tab, and page.evaluate runs
// in an isolated world, so the page's own scripts neither see Jev's helpers nor
// find Jev's functions on their stack. Code that needs the page's own globals
// asks for the main world explicitly (evaluateInPageWorld in page.mjs).
// patches/patchright-core*.patch keeps Playwright's rule for an existing Chrome
// (noDefaults): no focus emulation on every tab, so background tabs stay hidden
// and focus emulation is turned on only for an operation (rendering.mjs).
// Scripts that drive Electron in tests keep using Playwright itself.
const require = createRequire(import.meta.url);
export const jevChromium = () => require('patchright-core').chromium;
