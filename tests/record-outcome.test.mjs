import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNotSubmitted} from '../app/record-outcome.mjs';

const item={url:'https://listing.test/job',actionUrl:'https://portal.test/apply/R30035',title:'CrowdStrike R30035'};
const quote='R30035\nNot Submitted',proof={kind:'draft',quote,recordEvidence:'R30035'};
test('portal evidence decodes JSON escapes before comparing visible lines',()=>{
 for(const text of [quote,JSON.stringify({text:quote}),`Page URL: https://portal.test/home\n${JSON.stringify({text:quote})}`]){
  assert.equal(validateNotSubmitted(item,proof,{url:'https://portal.test/home',text}).quote,quote);
 }
});
test('hidden metadata, malformed JSON, changed identity and changed status are not draft evidence',()=>{
 for(const text of [
  JSON.stringify({text:'R30035\nSubmitted',history:[{text:quote}]}),
  JSON.stringify({text:'R30035\nSubmitted',fillFields:[{value:quote}]}),
  JSON.stringify({history:[{text:quote}]}),
  '{"text":"R30035\\nNot Submitted"',
  JSON.stringify({text:'R30036\nNot Submitted'}),
 ])assert.throws(()=>validateNotSubmitted(item,proof,{url:'https://portal.test/home',text}),/kanıt/);
});
