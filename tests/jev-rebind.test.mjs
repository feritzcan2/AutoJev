import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'patchright-core';
import {JevBrowser} from '../app/jev/browser.mjs';
import {installFormSemantics} from '../app/jev/form-semantics.mjs';

const next = '<button type=button>Next</button>';
const page = (inner) =>
  `<form><label><input type=checkbox checked> I agree</label><div id=slot>${inner}</div></form>`;

// A form that re-renders its Next button after every observation must not
// leave each click stale; any real change to the control still must.
test('a click follows a control the page re-rendered as an identical element', async (t) => {
  const browser = await chromium.launch({channel: 'chrome', headless: true}).catch(() => null);
  if (!browser) return t.skip('Chrome is not available');
  t.after(() => browser.close());
  const snapshot = await readFile(
    new URL('../vendor/jev-ultrafast/snapshot.js', import.meta.url),
    'utf8',
  );
  const reader = `(() => { (${installFormSemantics.toString()})(); return ${snapshot}; })()`;
  const fresh = async (before, after) => {
    const tab = await browser.newPage();
    try {
      await tab.setContent(page(before));
      const observed = await tab.evaluate(reader);
      const node = observed.actions.find((a) => /Next/.test(a.label)).node;
      if (after)
        await tab.evaluate((html) => (document.getElementById('slot').innerHTML = html), after);
      return await JevBrowser.prototype.fresh.call({}, {page: tab}, observed, {
        kind: 'click',
        node,
      });
    } finally {
      await tab.close();
    }
  };
  assert.equal(await fresh(next, null), true, 'an unchanged page');
  assert.equal(await fresh(next, next), true, 'the same button drawn again');
  assert.equal(await fresh(next, '<button type=button>Submit</button>'), false, 'a changed label');
  assert.equal(await fresh(next, '<button type=button disabled>Next</button>'), false, 'disabled');
  assert.equal(await fresh(next + next, next + next), false, 'two identical buttons');
});
