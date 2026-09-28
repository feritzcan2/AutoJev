import test from 'node:test';
import assert from 'node:assert/strict';
import {validateJevArgs} from '../app/jev-browser.mjs';
import {fillKnownFields} from '../app/jev-form.mjs';
test('text value alias is normalized but conflicting text is rejected before writing',()=>{
 const args={tabId:'tab',fields:[{fieldId:'field',value:'known answer'}]};
 validateJevArgs('browser_jev_fill_fields',args);
 assert.deepEqual(args.fields,[{fieldId:'field',text:'known answer'}]);
 assert.throws(()=>validateJevArgs('browser_jev_fill_fields',{tabId:'tab',fields:[{fieldId:'field',value:'one',text:'two'}]}));
});
test('control ID in batch fill reports wrong target type without touching the page',async()=>{
 const result=await fillKnownFields({controls:new Map([['control',{}]])},[{fieldId:'control',text:'value'}],'owner',()=>assert.fail('Must not write'));
 assert.equal(result.status,'invalid_target');assert.equal(result.results[0].status,'not_attempted');assert.match(result.message,/controlId/);
});
