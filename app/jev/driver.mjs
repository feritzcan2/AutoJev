// @ts-check
import {createRequire} from 'node:module';

// Jev drives Chrome through Patchright, Playwright with its page-visible CDP
// traces removed: Runtime.enable is never sent to a tab, and page.evaluate runs
// in an isolated world, so the page's own scripts neither see Jev's helpers nor
// find Jev's functions on their stack. Code that needs the page's own globals
// asks for the main world explicitly (evaluateInPageWorld in page.mjs).
// Scripts that drive Electron in tests keep using Playwright itself.
const require = createRequire(import.meta.url);
export const jevChromium = () => require('patchright-core').chromium;
