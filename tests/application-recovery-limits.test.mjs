import test from 'node:test';
import assert from 'node:assert/strict';
import {takeUploadAttempt} from '../app/upload-budget.mjs';
import {isStopReply} from '../app/application-stop.mjs';
import {isMissingDocumentsReply,missingDocumentReplies} from '../app/application-replies.mjs';
import {validateQuestionReview} from '../app/question-gate.mjs';
test('upload budget survives new observation ids and stops elapsed or repeated attempts',()=>{
 const slot={};assert.equal(takeUploadAttempt(slot,'field/file',0),true);
 assert.equal(takeUploadAttempt(slot,'field/file',100),true);
 assert.equal(takeUploadAttempt(slot,'field/file',200),false);
 assert.equal(takeUploadAttempt(slot,'different/file',200),true);
 assert.equal(takeUploadAttempt(slot,'different/file',60200),false);
});
test('job scoped colloquial cancellation accepts explicit command without broad substring matching',()=>{
 for(const answer of ['tmm iptal et omexi','tamam OMMAXı iptal et','iptal et'])assert.equal(isStopReply(answer,{company:'OMMAX'}),true,answer);
 for(const answer of ['iptal etme omexi','tmm iptal et captcha','iptal et midası','omexi iptal et demedim'])assert.equal(isStopReply(answer,{company:'OMMAX'}),false,answer);
});
test('legacy mixed access/document answers defer only explicit document absence',()=>{
 const q={id:'q',jobId:'job',question:'Giriş şifren ve transkript belgen var mı?',applicationBlocker:{kind:'access'},answer:'belgelerim yok'};
 assert.equal(isMissingDocumentsReply(q),true);
 assert.equal(isMissingDocumentsReply({...q,answer:'hayır'}),false);
 assert.equal(isMissingDocumentsReply({...q,answer:'password123'}),false);
 assert.equal(missingDocumentReplies({id:'job'},[q]).length,1);
});
test('site CAPTCHA quota cannot become a candidate action request',()=>{
 for(const kind of ['captcha','user_only'])assert.throws(()=>validateQuestionReview(null,'candidate',{applicationBlocker:{kind:'access',evidence:'This site is exceeding reCAPTCHA Enterprise free quota',recovery:{kind,userActionReason:'Clear it'}}},null),/Site kotası/);
});
