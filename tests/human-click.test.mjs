import test from 'node:test';
import assert from 'node:assert/strict';
import {humanClick} from '../app/captcha/human-click.mjs';

function fakePage() {
  const events = [];
  return {
    events,
    mouse: {
      move: async (x, y) => events.push({type: 'move', x, y, at: performance.now()}),
      down: async () => events.push({type: 'down'}),
      up: async () => events.push({type: 'up'}),
    },
  };
}

test('a verification click moves in whole pixels, lands on the target, then presses once', async () => {
  for (let run = 0; run < 5; run++) {
    const page = fakePage();
    await humanClick(page, 300.4, 200.7);
    const moves = page.events.filter((e) => e.type === 'move'),
      last = moves.at(-1);
    assert.ok(moves.length >= 9);
    assert.ok(moves.every((m) => Number.isInteger(m.x) && Number.isInteger(m.y)));
    assert.ok(moves.slice(1).every((m, i) => m.x !== moves[i].x || m.y !== moves[i].y));
    assert.ok(Math.hypot(last.x - 300.4, last.y - 200.7) <= 4);
    assert.deepEqual(
      page.events.slice(-2).map((e) => e.type),
      ['down', 'up'],
    );
    assert.ok(last.at - moves[0].at >= 150, 'the approach is not instant');
  }
});

test('a second click on the same page starts where the pointer rests', async () => {
  const page = fakePage();
  await humanClick(page, 100, 100);
  const rest = page.events.filter((e) => e.type === 'move').at(-1);
  page.events.length = 0;
  await humanClick(page, 400, 300);
  assert.deepEqual({x: page.events[0].x, y: page.events[0].y}, {x: rest.x, y: rest.y});
});

test('a changed task stops before the press', async () => {
  const page = fakePage();
  await assert.rejects(
    humanClick(page, 200, 200, () => {
      throw Error('changed');
    }),
  );
  assert.ok(!page.events.some((e) => e.type === 'down'));
});
