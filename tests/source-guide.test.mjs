import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSourceSearch} from '../app/source-integrations.mjs';
import {guideSections} from '../app/source-guide.mjs';

test('source settings retain guide edits on unrelated saves and allow explicit reset',()=>{
 const saved=validateSourceSearch({skillText:'Keep my instructions.',guideOverrides:{pagination:'Check the category before following Next.'}});
 assert.deepEqual(validateSourceSearch({fallback:'none'},saved).guideOverrides,saved.guideOverrides);
 const reset=validateSourceSearch({guideOverrides:{},skillText:null},saved);
 assert.deepEqual(reset.guideOverrides,{});assert.equal(reset.skillText,null);
 for(const guideOverrides of [null,[],{unknown:'No'},{search:''},{search:'x'.repeat(6001)}])assert.throws(()=>validateSourceSearch({guideOverrides}));
});

test('guide edits work before learning and method changes invalidate displayed verification',()=>{
 const sections=guideSections(null,{search:'Use the public category.'});
 assert.equal(sections[0].instructions,'Use the public category.');assert.equal(sections[0].userEdited,true);
 const skill={needsReview:true,sections:[{key:'search',status:'verified',instructions:'Observed route',evidence:[]}]};
 assert.equal(guideSections(skill)[0].status,'unverified');
 assert.equal(skill.sections[0].status,'verified');
});
