import test from 'node:test';
import assert from 'node:assert/strict';
import {validateUploadPurpose} from '../app/jev-upload.mjs';

test('a CV cannot be uploaded as a cover letter',()=>{
 assert.throws(()=>validateUploadPurpose('Cover Letter — Attach','CV.pdf'),/ön yazı alanına/);
 assert.doesNotThrow(()=>validateUploadPurpose('Cover Letter — Attach','cover-letter-de.pdf'));
 assert.doesNotThrow(()=>validateUploadPurpose('Resume/CV','CV.pdf'));
 assert.throws(()=>validateUploadPurpose('Resume/CV','cover-letter.pdf'),/CV alanına/);
});
