import test from 'node:test';
import assert from 'node:assert/strict';
import {captureEmbeddedForms} from '../app/jev-frames.mjs';

test('a visible application iframe remains actionable when Chrome reports an empty frame URL',async()=>{
 const main={parentFrame:()=>null};
 const element={src:'https://job-boards.greenhouse.io/embed/job_app?for=example',id:'grnhse_iframe',title:'Greenhouse Job Board',
  hasAttribute:()=>false,closest:()=>null,checkVisibility:()=>true,getBoundingClientRect:()=>({width:900,height:1200})};
 const handle={evaluate:async(fn,arg)=>fn(element,arg),dispose:async()=>{}};
 const frame={url:()=>'',parentFrame:()=>main,frameElement:async()=>handle,evaluate:async()=>({form:true,links:false,password:false})};
 const page={mainFrame:()=>main,frames:()=>[main,frame]};
 const slot={page,owner:'worker'};
 const forms=await captureEmbeddedForms(slot);
 assert.equal(forms.length,1);
 assert.equal(forms[0].url,element.src);
 assert.equal(slot.embeddedFrames.get(forms[0].frameId).rawUrl,'');
});
