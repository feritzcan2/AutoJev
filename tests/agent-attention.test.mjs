import assert from 'node:assert/strict';
import {test} from 'node:test';
import {terminalAttention, trustKeys} from '../src/agent-attention.js';

test('Claude workspace trust prompt is attention bearing even while provider says Working', () => {
  const screen = `Accessing workspace:\n/Users/example/workspace\n\nQuick safety check: Is this a project you created or one you trust?\nClaude Code'll be able to read, edit, and execute files here.\n\nNo, exit\n❯ Yes, I trust this folder\n\nEnter to confirm · Esc to cancel`;
  assert.equal(terminalAttention(screen, 'Working')?.kind, 'trust');
  assert.equal(terminalAttention('The agent is processing a page.', 'Working'), null);
});

test('native awaiting input remains visible without a recognizable permission prompt', () => {
  assert.equal(terminalAttention('What city should I search?', 'AwaitingInput')?.kind, 'input');
});

test('tool approval requires both a permission question and terminal choices', () => {
  assert.equal(
    terminalAttention('Do you want to allow this command? Yes  No  Enter to confirm', 'Working')
      ?.kind,
    'permission',
  );
  assert.equal(terminalAttention('The docs say: allow this command?', 'Working'), null);
});

test('the trust button moves to "Yes, I trust this folder" from whichever option is selected', () => {
  const menu = (first, second) =>
    `Quick safety check\n\n${first}\n${second}\n\nEnter to confirm · Esc to cancel`;
  // Claude 2.1.304 lists "No, exit" first and selects it.
  assert.deepEqual(trustKeys(menu(' ❯ No, exit', '   Yes, I trust this folder')), ['\x1b[B', '\r']);
  assert.deepEqual(trustKeys(menu(' ❯ 1. Yes, I trust this folder', '   2. No, exit')), ['\r']);
  assert.deepEqual(trustKeys(menu('   No, exit', ' ❯ Yes, I trust this folder')), ['\r']);
  assert.deepEqual(trustKeys(menu('   Yes, I trust this folder', ' ❯ No, exit')), ['\x1b[A', '\r']);
  assert.equal(trustKeys('Yes, I trust this folder\nNo, exit'), null, 'No selection: no keys');
  assert.equal(trustKeys(''), null);
});
