import test from 'node:test';
import assert from 'node:assert/strict';
import {browserNavigation} from '../app/browser-navigation.mjs';
import {BrowserSnapshot,BROWSER_RESPONSE_BYTES} from '../app/browser-snapshot.mjs';
const url='https://homes.example/search?selected_area=amsterdam';
const response=page=>({content:[{type:'text',text:'Page URL: '+url+'\n'+JSON.stringify(page)}]});
test('long paged observations retain scroll distance and real pagination outside escaped text',()=>{
 const next=url+'&page=2',r=response({text:'card '.repeat(30000),scrollTargets:[{controlId:'s1',label:'Page',top:1680,height:6138,viewport:735}],pagination:[{text:'2',url:next,kind:'link',current:false,disabled:false}]});
 const pageNavigation=browserNavigation(r);assert.equal(pageNavigation.scrollTargets[0].remainingDown,3723);assert.equal(pageNavigation.scrollTargets[0].atBottom,false);assert.equal(pageNavigation.pagination[0].url,next);
 const reader=new BrowserSnapshot(),first=reader.capture({url,...r,pageNavigation});assert.equal(first.snapshot.complete,false);assert.deepEqual(first.pageNavigation,pageNavigation);
 const part=reader.read({snapshotId:first.snapshot.id,offset:first.snapshot.nextOffset});assert.deepEqual(part.pageNavigation,pageNavigation);assert.ok(Buffer.byteLength(JSON.stringify(part))<=BROWSER_RESPONSE_BYTES);
});
test('pagination targets require a unique current click target, and a scroll boundary is not a final page claim',()=>{
 const p={scrollTargets:[{controlId:'s2',label:'Page',top:5403,height:6138,viewport:735}],pagination:[{text:'Volgende',url:null,kind:'button',disabled:false}],clickTargets:[{label:'Volgende',targetId:'next'}]};
 let nav=browserNavigation(response(p));assert.equal(nav.scrollTargets[0].atBottom,true);assert.equal(nav.pagination[0].targetId,'next');
 nav=browserNavigation(response({...p,clickTargets:[...p.clickTargets,{label:'Volgende',targetId:'other'}]}));assert.equal(nav.pagination[0].targetId,undefined);
 assert.equal(browserNavigation({content:[{type:'text',text:'Not a Jev document'}]}),undefined);
});

test('large pagination URLs stay exact and cannot overflow the response metadata budget',()=>{
 const r=response({text:'card '.repeat(30000),scrollTargets:[],pagination:Array.from({length:30},(_,n)=>({text:String(n),url:url+'&page='+n+'&filter='+'x'.repeat(1800),kind:'link'}))});
 const pageNavigation=browserNavigation(r);assert.equal(pageNavigation.paginationCount,30);assert.ok(pageNavigation.pagination.length<16);assert.ok(pageNavigation.pagination.every(p=>p.url.endsWith('x'.repeat(1800))));
 const page=new BrowserSnapshot().capture({url,...r,pageNavigation});assert.ok(Buffer.byteLength(JSON.stringify(page))<=BROWSER_RESPONSE_BYTES);
});
