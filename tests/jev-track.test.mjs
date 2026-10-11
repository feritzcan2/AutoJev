import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev/browser.mjs';

// A page whose setup failed once (for example while it was navigating) is
// tracked again on the next call instead of failing forever.
test('a failed tab setup is not cached', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'jev-track-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const client = new JevBrowser(directory, {
    connection: 'separate',
    headless: true,
    config: async () => ({}),
    choose: async () => {
      throw Error('No model required');
    },
  });
  const page = {
    on() {},
    addInitScript: async () => {},
    evaluate: async () => {},
    isClosed: () => false,
  };
  let attempts = 0;
  const context = {
    newCDPSession: async () => {
      if (attempts++ === 0) throw Error('frame.evaluateHandle: Execution context was destroyed');
      return {send: async () => ({targetInfo: {targetId: 'TAB1'}})};
    },
  };
  await assert.rejects(client.track(context, page), /context was destroyed/);
  const slot = await client.track(context, page);
  assert.equal(slot.id, 'TAB1');
  assert.equal(await client.track(context, page), slot);
});
