import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readChoicePrompt, choiceKeys} from '../src/jobloop/terminal-prompt.js';

test('reads an unnumbered folder trust prompt', () => {
  const screen = `Accessing workspace:\n/Users/example/workspace\n\nQuick safety check: Is this a project you created or one you trust?\nClaude Code'll be able to read, edit, and execute files here.\n\nNo, exit\n❯ Yes, I trust this folder\n\nEnter to confirm · Esc to cancel`;
  const prompt = readChoicePrompt(screen);
  assert.deepEqual(
    prompt.options.map((o) => o.label),
    ['No, exit', 'Yes, I trust this folder'],
  );
  assert.equal(prompt.selected, 1);
  assert.match(prompt.question, /Quick safety check/);
  assert.equal(choiceKeys(prompt, 0), '\x1b[A\r');
  assert.equal(choiceKeys(prompt, 1), '\r');
});

test('reads a numbered tool approval inside a box', () => {
  const screen = [
    '╭──────────────────────────────────────────────╮',
    '│ Read file                                    │',
    '│                                              │',
    '│ Do you want to allow Read(/tmp/cv.pdf)?      │',
    '│ ❯ 1. Yes                                     │',
    "│   2. Yes, and don't ask again this session   │",
    '│   3. No, and tell Claude what to do          │',
    '╰──────────────────────────────────────────────╯',
    '   Esc to cancel',
  ].join('\n');
  const prompt = readChoicePrompt(screen);
  assert.deepEqual(
    prompt.options.map((o) => o.label),
    ['Yes', "Yes, and don't ask again this session", 'No, and tell Claude what to do'],
  );
  assert.equal(prompt.question, 'Do you want to allow Read(/tmp/cv.pdf)?');
  assert.equal(prompt.context, 'Read file');
  assert.equal(choiceKeys(prompt, 2), '\x1b[B\x1b[B\r');
});

test('ordinary output is not a prompt', () => {
  assert.equal(readChoicePrompt('Reading the CV…\n> thinking'), null);
  assert.equal(readChoicePrompt(''), null);
});

test('a menu without a key hint counts only when it asks a question', () => {
  const box = [
    '│ Do you want to proceed?   │',
    '│ ❯ 1. Yes                  │',
    '│   2. No                   │',
    '╰───────────────────────────╯',
  ];
  assert.equal(readChoicePrompt(box.join('\n')).options.length, 2);
  assert.equal(readChoicePrompt(['Pick one', '❯ 1. A', '  2. B'].join('\n')), null);
});
