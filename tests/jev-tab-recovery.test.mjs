import test from 'node:test';
import assert from 'node:assert/strict';
import {restoredTargets,sameBrowserInstance} from '../app/jev-tabs.mjs';
test('restore exact saved/checkpoint targets in a verified browser profile, never same-URL personal tabs',()=>{
 const a='A'.repeat(32),b='B'.repeat(32),c='C'.repeat(32),d='D'.repeat(32);
 const saved={endpoint:'old-debugger',targets:[a,d]};
 const checkpoints=[{browser:'Jev Chrome',tabId:b},{browser:'Jev Chrome',tabId:c},{browser:'Chrome',tabId:'123'}];
 const live=new Map([[a,{browserContextId:'irem'}],[b,{browserContextId:'irem'}],[c,{browserContextId:'other'}],['E'.repeat(32),{browserContextId:'irem',url:'https://same.example/form'}]]);
 assert.deepEqual(restoredTargets(saved,checkpoints,live,'irem'),[a,b]);
 assert.deepEqual(restoredTargets(saved,checkpoints,live,null),[]);
 assert.deepEqual(restoredTargets({targets:[]},checkpoints,live,'irem'),[b]);
 assert.deepEqual(restoredTargets(saved,checkpoints,new Map(),'irem'),[]);
});
test('an address change can preserve browser identity; a new Chrome process cannot',()=>{
 assert.equal(sameBrowserInstance('ws://127.0.0.1:123/devtools/browser/browser-a','ws://localhost:456/devtools/browser/browser-a'),true);
 assert.equal(sameBrowserInstance('ws://127.0.0.1:123/devtools/browser/browser-a','ws://127.0.0.1:123/devtools/browser/browser-b'),false);
 assert.equal(sameBrowserInstance('ws://localhost','ws://localhost'),false);
});
