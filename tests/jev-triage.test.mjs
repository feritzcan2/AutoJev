import test from 'node:test';
import assert from 'node:assert/strict';
import {jevCriteria} from '../app/jev-triage.mjs';

test('the user profile contains current language facts and user documents without unrelated history or file paths',()=>{
 const automation={templateId:'job-search',goal:'Compliance roles',criteria:{preferences:'Only remote Germany; no hybrid'},facts:'German B2. Four years of compliance.',referenceData:{profile:{facts:'Older German B1.',cvPath:'/private/candidate.pdf',learnedFacts:{english:{value:'English C1'}}},previousTasks:'UNRELATED_HISTORY'}};
 const context=jevCriteria(automation,{text:'LL.B.\n GDPR audits and healthcare compliance.',path:'PRIVATE_PATH'});
 assert.match(context.userProfile.currentFacts.text,/German B2/);
 assert.match(context.userProfile.savedFacts.text,/English C1/);
 assert.match(context.userProfile.documents.text,/LL.B.*GDPR/);
 assert.equal(context.userProfile.documents.truncated,false);
 assert.equal(context.criteria.preferences,automation.criteria.preferences);
 assert.doesNotMatch(JSON.stringify(context),/UNRELATED_HISTORY|PRIVATE_PATH|candidate.pdf/);
 const other=jevCriteria({...automation,facts:'C# engineer, German C1',referenceData:{}},{text:'Cloud engineering'});
 assert.doesNotMatch(JSON.stringify(other.userProfile),/German B2|healthcare|LL.B/);
});

test('large and unreadable profile sources stay bounded with explicit unknown coverage',()=>{
 const automation={templateId:'job-search',facts:'Current fact. '.repeat(5000),referenceData:{profile:{facts:'Saved fact. '.repeat(5000)}}};
 const context=jevCriteria(automation,{text:'CV experience. '.repeat(5000)}).userProfile;
 assert.equal(context.currentFacts.truncated,true);assert.equal(context.savedFacts.truncated,true);assert.equal(context.documents.truncated,true);
 assert.ok(JSON.stringify(context).length<19000);
 const unavailable=jevCriteria(automation,{text:'',unavailable:'CV unavailable'}).userProfile.documents;
 assert.equal(unavailable.text,'');assert.equal(unavailable.unavailable,'CV unavailable');
 assert.equal(jevCriteria({templateId:'housing',criteria:{budget:'2000'}}).userProfile,undefined,'no document reading sends no user profile');
});
