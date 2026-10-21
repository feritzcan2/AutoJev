import test from 'node:test';
import assert from 'node:assert/strict';
import {humanClick, humanType, wheelScroll} from '../app/browser/human-input.mjs';

function fakePage() {
  const events = [];
  return {
    events,
    mouse: {
      move: async (x, y) => events.push({type: 'move', x, y, at: performance.now()}),
      down: async () => events.push({type: 'down'}),
      up: async () => events.push({type: 'up'}),
      wheel: async (x, y) => events.push({type: 'wheel', y}),
    },
    keyboard: {
      down: async (key) => events.push({type: 'keydown', key, at: performance.now()}),
      up: async (key) => events.push({type: 'keyup', key}),
      insertText: async (text) => events.push({type: 'insert', text}),
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

test('short text is typed key by key at an uneven pace, with Shift for capitals', async () => {
  const page = fakePage();
  await humanType(page, 'Ab c');
  const downs = page.events.filter((e) => e.type === 'keydown');
  assert.deepEqual(
    downs.map((e) => e.key),
    ['Shift', 'A', 'b', ' ', 'c'],
  );
  assert.equal(page.events.filter((e) => e.type === 'keyup').length, 5);
  const gaps = downs.slice(2).map((e, i) => e.at - downs[i + 1].at);
  assert.ok(gaps.every((gap) => gap >= 40));
  assert.ok(!page.events.some((e) => e.type === 'insert'));
});

test('letters outside the US layout are inserted; line breaks and long text are never Enter', async () => {
  const page = fakePage();
  await humanType(page, 'Gü');
  assert.deepEqual(
    page.events.filter((e) => e.type === 'insert').map((e) => e.text),
    ['ü'],
  );
  const pasted = fakePage();
  await humanType(pasted, 'Line one\nLine two');
  assert.deepEqual(pasted.events, [{type: 'insert', text: 'Line one\nLine two'}]);
  const long = fakePage();
  await humanType(long, 'x'.repeat(200));
  assert.equal(long.events.length, 1);
});

test('after the deadline the rest of the text arrives at once', async () => {
  const page = fakePage();
  await humanType(page, 'abcdef', {deadline: Date.now() - 1});
  assert.deepEqual(page.events, [{type: 'insert', text: 'abcdef'}]);
});

test('a wheel scroll moves the pointer there, then turns in uneven notches', async () => {
  const page = fakePage();
  assert.equal(await wheelScroll(page, {x: 200, y: 300}, -500), true);
  const notches = page.events.filter((e) => e.type === 'wheel');
  assert.equal(page.events[0].type, 'move');
  assert.equal(
    notches.reduce((sum, e) => sum + e.y, 0),
    -500,
  );
  assert.ok(notches.length >= 5 && notches.every((e) => e.y < 0 && e.y >= -120));
});
