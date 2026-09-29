import test from 'node:test';
import assert from 'node:assert/strict';
import {terminalConversation} from '../src/terminal-conversation.js';
const settle=()=>new Promise(r=>setImmediate(r));
test('idle terminal edits Turkish text and submits one message with Enter',async()=>{
 const messages=[],terminal=terminalConversation({write:()=>{},submit:async text=>messages.push(text)});
 terminal.input('İzmir ev arıyorm');terminal.input('\x7f');terminal.input('um');terminal.input('\r');terminal.input('\r');await settle();
 assert.deepEqual(messages,['İzmir ev arıyorum']);assert.equal(terminal.text,'');
});
test('pasted multiple lines wait for Enter, and a failed send preserves the message',async()=>{
 const messages=[],terminal=terminalConversation({write:()=>{},submit:async text=>{messages.push(text);throw Error('Provider unavailable');}});
 terminal.input('\x1b[200~Berlin\nHamburg\x1b[201~');assert.deepEqual(messages,[]);assert.equal(terminal.text,'Berlin\nHamburg');
 terminal.input('\r');await settle();assert.deepEqual(messages,['Berlin\nHamburg']);assert.equal(terminal.text,'Berlin\nHamburg');
 terminal.input('\x03');assert.equal(terminal.text,'');
});
