import assert from 'node:assert/strict';
import {test} from 'node:test';
import {terminalAttention} from '../src/agent-attention.js';

test('Claude workspace trust prompt is attention bearing even while provider says Working',()=>{
 const screen=`Accessing workspace:\n/Users/example/workspace\n\nQuick safety check: Is this a project you created or one you trust?\nClaude Code'll be able to read, edit, and execute files here.\n\nNo, exit\n❯ Yes, I trust this folder\n\nEnter to confirm · Esc to cancel`;
 assert.equal(terminalAttention(screen,'Working')?.kind,'trust');
 assert.equal(terminalAttention('The agent is processing a page.','Working'),null);
});

test('native awaiting input remains visible without a recognizable permission prompt',()=>{
 assert.equal(terminalAttention('What city should I search?','AwaitingInput')?.kind,'input');
});

test('tool approval requires both a permission question and terminal choices',()=>{
 assert.equal(terminalAttention('Do you want to allow this command? Yes  No  Enter to confirm','Working')?.kind,'permission');
 assert.equal(terminalAttention('The docs say: allow this command?','Working'),null);
});
