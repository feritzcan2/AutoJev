import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSubmitLabel,
  clickTargetLabel,
  classifySubmission,
  assertSubmitAllowed,
  submissionGuidance,
} from '../app/records/submission.mjs';

test('submit labels are recognized across languages and navigation buttons are not', () => {
  for (const label of [
    'Submit application',
    'Submit',
    'Send application',
    'Bewerbung absenden',
    'Jetzt senden',
    'Başvuruyu gönder',
    'Envoyer ma candidature',
  ])
    assert.equal(isSubmitLabel(label), true, label);
  for (const label of ['Apply now', 'Jetzt bewerben', 'Next', 'Weiter', 'Back', 'Cancel', '', null])
    assert.equal(isSubmitLabel(label), false, String(label));
  // A submit word next to a navigation word is not a final submit.
  assert.equal(isSubmitLabel('Back to submit page'), false);
});

test('the clicked target label is read from the worker snapshot', () => {
  const page = {
    url: 'https://jobs.example.com/apply',
    clickTargets: [
      {targetId: 't-1', label: 'Weiter', role: 'button'},
      {targetId: 't-2', label: 'Bewerbung absenden', role: 'button'},
    ],
  };
  const snapshot = {text: 'Page URL: https://jobs.example.com/apply\n' + JSON.stringify(page)};
  assert.equal(clickTargetLabel(snapshot, 't-2'), 'Bewerbung absenden');
  assert.equal(clickTargetLabel(snapshot, 't-1'), 'Weiter');
  assert.equal(clickTargetLabel(snapshot, 't-9'), null);
  assert.equal(clickTargetLabel(null, 't-1'), null);
  // Truncated JSON still yields the label through the textual fallback.
  const truncated = {text: snapshot.text.slice(0, snapshot.text.length - 5)};
  assert.equal(clickTargetLabel(truncated, 't-2'), 'Bewerbung absenden');
});

test('the fresh page after a submit is classified from generic wording', () => {
  assert.equal(
    classifySubmission('Success – Thank you for submitting your application!').outcome,
    'confirmed',
  );
  assert.equal(classifySubmission('Vielen Dank für Ihre Bewerbung.').outcome, 'confirmed');
  assert.equal(
    classifySubmission('Application status: Application submitted').outcome,
    'confirmed',
  );
  const error = classifySubmission(
    'Error submitting application. Perhaps this email has already been entered.',
  );
  assert.equal(error.outcome, 'error');
  assert.match(error.quote, /Error submitting/);
  assert.equal(classifySubmission('Phone number is required').outcome, 'validation');
  assert.equal(classifySubmission('Preview is being created').outcome, 'unknown');
  assert.equal(classifySubmission('').quote, null);
  for (const outcome of ['confirmed', 'error', 'validation', 'unknown'])
    assert.equal(typeof submissionGuidance({outcome}), 'string');
});

test('only a reserved execute run may click submit, and only once', () => {
  assert.throws(
    () => assertSubmitAllowed({recordOperation: 'verify', actionId: 'r1'}, 'Submit'),
    /Yalnızca başvuru/,
  );
  assert.throws(
    () => assertSubmitAllowed({recordOperation: 'execute'}, 'Submit'),
    /reserve_automation_action/,
  );
  assert.doesNotThrow(() =>
    assertSubmitAllowed({recordOperation: 'execute', actionId: 'r1'}, 'Submit'),
  );
  assert.throws(
    () =>
      assertSubmitAllowed(
        {recordOperation: 'execute', actionId: 'r1', submission: {outcome: 'unknown'}},
        'Submit',
      ),
    /Gönderim zaten denendi/,
  );
  assert.throws(
    () =>
      assertSubmitAllowed(
        {recordOperation: 'execute', actionId: 'r1', submission: {outcome: 'error'}},
        'Submit',
      ),
    /Tekrar tıklama/,
  );
  // A form validation message means the first click did not submit: one retry is fine.
  assert.doesNotThrow(() =>
    assertSubmitAllowed(
      {recordOperation: 'execute', actionId: 'r1', submission: {outcome: 'validation'}},
      'Submit',
    ),
  );
});

test('wording that was already on the form before the click is not the site reaction', () => {
  const page = (text, fields) =>
    'Page URL: https://jobs.example/apply\n' +
    JSON.stringify({url: 'https://jobs.example/apply', text, fillFields: fields, uploads: []});
  const survey = 'Name\nHow do you identify? Please select all that apply.\nI prefer not to answer';
  const before = page(survey + '\nSubmit Application', [{fieldId: 'f1'}]);
  // Same survey text after the click, form gone, no error: unknown + formGone.
  const gone = classifySubmission(page('Overview\nApplication\n' + survey, []), before);
  assert.equal(gone.outcome, 'unknown');
  assert.equal(gone.formGone, true);
  assert.match(submissionGuidance(gone), /form disappeared/);
  // A new validation line after the click still counts.
  const invalid = classifySubmission(
    page(survey + '\nEmail is required', [{fieldId: 'f1'}]),
    before,
  );
  assert.equal(invalid.outcome, 'validation');
  assert.equal(invalid.quote, 'Email is required');
  assert.equal(invalid.formGone, false);
  // A confirmation line that appears after the click is confirmed.
  const done = classifySubmission(page('Thank you for applying!\n' + survey, []), before);
  assert.equal(done.outcome, 'confirmed');
  // Without a before text every line counts, as in the plain-text tests above.
  assert.equal(classifySubmission(page(survey, []), '').outcome, 'validation');
});
