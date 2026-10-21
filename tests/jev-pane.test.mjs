import test from 'node:test';
import assert from 'node:assert/strict';
import {readPane} from '../app/jev/pane.mjs';

const results = 'https://www.linkedin.com/jobs/search-results/?keywords=Backend&geoId=101282230';
const posting = (id) => `https://www.linkedin.com/jobs/view/420000000${id}/`;
const description = 'Build reliable APIs and own the platform. '.repeat(8);
// A synthetic results page whose pane shows one posting (shown) and whose
// cards (ids) show theirs a few reads after a click. after(id) may move the
// page elsewhere instead.
function fakePage({
  shown = '4200000001',
  ids = ['4200000001', '4200000002'],
  delay = 2,
  after = null,
} = {}) {
  const state = {url: results, shown, reads: 0, clicks: []};
  const raw = () => ({
    url: state.url,
    key: state.shown,
    title: 'Role ' + state.shown,
    company: 'Acme',
    location: 'Berlin',
    description,
    closed: false,
  });
  state.page = {
    url: () => state.url,
    evaluate: async () => {
      state.reads++;
      if (state.pending && --state.pending.reads <= 0) {
        state.shown = state.pending.id;
        state.pending = null;
      }
      return raw();
    },
    evaluateHandle: async (_card, key) => ({
      asElement: () =>
        ids.includes(key)
          ? {
              scrollIntoViewIfNeeded: async () => {},
              click: async () => {
                state.clicks.push(key);
                if (after) state.url = after(key.slice(-1));
                else state.pending = {id: key, reads: delay};
              },
              dispose: async () => {},
            }
          : null,
      dispose: async () => {},
    }),
  };
  return state;
}

test('a card click shows its posting in the pane, read once it settles', async () => {
  const state = fakePage();
  const read = await readPane({page: state.page}, posting('2'));
  assert.equal(read.status, 'read');
  assert.deepEqual(state.clicks, ['4200000002']);
  assert.equal(read.listing.title, 'Role 4200000002');
  assert.match(read.listing.text, /Build reliable APIs/);
  assert.equal(read.listing.fields.company, 'Acme');
});

test('the posting the pane already shows needs no click', async () => {
  const state = fakePage();
  const read = await readPane({page: state.page}, posting('1'));
  assert.equal(read.status, 'read');
  assert.deepEqual(state.clicks, []);
});

test('a pane that does not show the posting in time, a missing card or another page is no read', async () => {
  const slow = fakePage({delay: 1000});
  assert.equal(
    (await readPane({page: slow.page}, posting('2'), {showMs: 500})).status,
    'not_shown',
    'a load that never completes ends within its bound',
  );
  assert.equal((await readPane({page: fakePage().page}, posting('9'))).status, 'no_card');
  const away = fakePage({after: posting});
  assert.equal((await readPane({page: away.page}, posting('2'))).status, 'left_results');
  const other = fakePage();
  other.url = posting('1');
  assert.equal(
    (await readPane({page: other.page}, posting('2'))).status,
    'unsupported',
    'a page that is not a results page with a pane is not clicked',
  );
  assert.equal(
    (await readPane({page: fakePage().page}, 'https://example.com/job/2')).status,
    'unsupported',
  );
});

test('a pane read stops when its task is cancelled', async () => {
  const slow = fakePage({delay: 1000}),
    abort = new AbortController();
  setTimeout(() => abort.abort(), 300);
  await assert.rejects(
    readPane({page: slow.page}, posting('2'), {signal: abort.signal}),
    (e) => e.name === 'AbortError',
  );
});
