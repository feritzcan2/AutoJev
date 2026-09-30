import {test} from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import {TerminalScreen} from '../app/terminal-screen.mjs';

const write=(terminal,text)=>new Promise(resolve=>terminal.write(text,resolve));
const contents=terminal=>{const b=terminal.buffer.active;return {lines:Array.from({length:b.length},(_,i)=>b.getLine(i).translateToString(true)),cursor:[b.cursorX,b.cursorY],type:b.type};};
async function restored(snapshot){const t=new headless.Terminal({rows:snapshot.rows,cols:snapshot.cols,scrollback:2000,allowProposedApi:true});await write(t,Uint8Array.from(snapshot.bytes));return t;}

test('snapshot preserves cursor updates made at a narrower grid before resize',async t=>{
 const screen=new TerminalScreen({rows:24,cols:80});t.after(()=>screen.dispose());
 const text='A'.repeat(90)+'\r\n\x1b[1APASS\x1b[K\r\n';
 screen.write(Buffer.from(text),1);screen.resize({rows:26,cols:133});
 const snapshot=await screen.snapshot('session'),copy=await restored(snapshot);t.after(()=>copy.dispose());
 assert.equal(snapshot.sequence,1);assert.equal(snapshot.sessionId,'session');
 assert.deepEqual(contents(copy),contents(screen.terminal));
 const broken=new headless.Terminal({rows:26,cols:133,allowProposedApi:true});t.after(()=>broken.dispose());await write(broken,text);
 assert.notDeepEqual(contents(broken),contents(copy),'raw replay at the new width loses the first 80 characters');
});

test('snapshots include exactly their sequence and retain split UTF-8 and ANSI writes',async t=>{
 const screen=new TerminalScreen();t.after(()=>screen.dispose());
 const bytes=Buffer.from('\x1b[32mKaynak: İstanbul ✓\x1b[0m');
 for(let i=0;i<bytes.length;i++)screen.write(bytes.subarray(i,i+1),i+1);
 const pending=screen.snapshot('one');screen.write(Buffer.from('\r\nLater'),bytes.length+1);
 const first=await pending,copy=await restored(first);t.after(()=>copy.dispose());
 assert.equal(first.sequence,bytes.length);assert.match(contents(copy).lines.join('\n'),/Kaynak: İstanbul ✓/);assert.doesNotMatch(contents(copy).lines.join('\n'),/Later/);
 const final=await screen.snapshot('one'),last=await restored(final);t.after(()=>last.dispose());assert.deepEqual(contents(last),contents(screen.terminal));
});

test('alternate screen and terminal input modes survive restoration',async t=>{
 const screen=new TerminalScreen();t.after(()=>screen.dispose());
 screen.write(Buffer.from('history\x1b[?1049h\x1b[?2004h\x1b[?1h\x1b[?1003h\x1b[?1006h\x1b[5;8Happroval'),1);
 const copy=await restored(await screen.snapshot('session'));t.after(()=>copy.dispose());
 assert.deepEqual(contents(copy),contents(screen.terminal));assert.deepEqual(copy.modes,screen.terminal.modes);
});

test('long output keeps a complete bounded screen instead of a truncated ANSI suffix',async t=>{
 const screen=new TerminalScreen({rows:24,cols:80});t.after(()=>screen.dispose());
 screen.write(Buffer.from(('x'.repeat(78)+'\r\n').repeat(14000)+'\x1b[3;1HLatest\x1b[K'),1);
 const copy=await restored(await screen.snapshot('long'));t.after(()=>copy.dispose());
 assert.ok(copy.buffer.active.length<=2024);assert.deepEqual(contents(copy),contents(screen.terminal));
});
