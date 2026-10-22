import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationFailureEvent,
  reportableApplicationFailure,
} from '../app/system/application-failure-report.mjs';

const context = {release: '0.1.20', environment: 'production', installId: 'install-1'};
const application = (patch = {}) => ({
  id: 'run-1',
  kind: 'run',
  recordOperation: 'execute',
  status: 'blocked',
  sourceUrl: 'https://listings.test/',
  sources: ['https://listings.test/jobs/123'],
  startedAt: 1000,
  finishedAt: 61000,
  browserSteps: 14,
  summary:
    'Example Corp form filled with start date 01.12.2026 and "valid visa"; mail person@example.com.',
  blocker: {
    category: 'technical',
    reason:
      'The "Senior Engineer" form Next button at https://jobs.example.test/apply?id=9 did nothing.',
    userAction: 'Retry later',
  },
  navigation: [
    {url: 'https://listings.test/jobs/123', step: 0},
    {url: 'https://example-corp.myworkdayjobs.com/en-US/careers/job/123/apply', step: 5},
  ],
  conversation: {provider: 'claude', settings: {model: 'haiku'}},
  tokenUsage: {agentTokens: 1200},
  ...patch,
});

test('only applications that the app might fix are reported', () => {
  assert.equal(reportableApplicationFailure(application(), 'running'), true);
  assert.equal(reportableApplicationFailure(application(), 'blocked'), false);
  assert.equal(
    reportableApplicationFailure(application({blocker: undefined, status: 'timeout'}), 'running'),
    true,
  );
  for (const category of ['needs_answer', 'needs_login', 'verification', 'not_eligible'])
    assert.equal(
      reportableApplicationFailure(application({blocker: {category}}), 'running'),
      false,
      category,
    );
  assert.equal(
    reportableApplicationFailure(application({status: 'interrupted'}), 'running'),
    false,
  );
  assert.equal(
    reportableApplicationFailure(application({recordOperation: 'score'}), 'running'),
    false,
  );
  assert.equal(
    reportableApplicationFailure(application({recordOperation: undefined}), 'running'),
    false,
  );
});

test('the event names the applicant system and step but not the employer or the user facts', () => {
  const event = applicationFailureEvent(application(), context);
  assert.equal(event.logger, 'jobloop.application');
  assert.deepEqual(event.fingerprint, [
    'jobloop-application',
    'blocked',
    'technical',
    'myworkdayjobs.com',
    'none',
  ]);
  assert.deepEqual(
    {
      site: event.tags.site,
      form_site: event.tags.form_site,
      category: event.tags.category,
      step: event.tags.step,
      install_id: event.tags.install_id,
    },
    {
      site: 'listings.test',
      form_site: 'myworkdayjobs.com',
      category: 'technical',
      step: 'before_submit',
      install_id: 'install-1',
    },
  );
  assert.equal(event.extra.summary, '');
  assert.equal(event.extra.reason, 'The "…" form Next button at jobs.example.test/… did nothing.');
  assert.equal(event.extra.durationMs, 60000);
  const sent = JSON.stringify(event);
  for (const secret of [
    'example-corp',
    'Example Corp',
    '01.12.2026',
    'valid visa',
    'person@example.com',
    'Senior Engineer',
    'apply?id=9',
  ])
    assert.equal(sent.includes(secret), false, secret);
});

test('the form site is the listing site, a known applicant system or the employer site', () => {
  const at = (url) =>
    applicationFailureEvent(application({navigation: [{url, step: 1}]}), context).tags.form_site;
  assert.equal(at('https://www.listings.test/apply/123'), 'listing_site');
  assert.equal(at('https://jobs.lever.co/example/123/apply'), 'lever.co');
  assert.equal(at('https://careers.example.co.uk/apply'), 'employer_site');
  assert.equal(at('https://example-corp.com/jobs/apply'), 'employer_site');
  assert.equal(
    applicationFailureEvent(application({navigation: [], observations: []}), context).tags
      .form_site,
    'none',
  );
});

test('an application the app ended keeps its scrubbed summary, tool and submit step', () => {
  const event = applicationFailureEvent(
    application({
      status: 'failed',
      blocker: undefined,
      summary: 'Execution stopped: the same operation failed 3 times at https://x.test/a?b=c.',
      toolFailure: {tool: 'browser_interact', message: 'No control "Submit now"', count: 3},
      submission: {outcome: 'validation'},
    }),
    context,
  );
  assert.equal(event.level, 'error');
  assert.equal(event.tags.category, 'none');
  assert.equal(event.tags.code, 'tool:browser_interact');
  assert.equal(event.tags.step, 'submitted_validation');
  assert.equal(
    event.extra.summary,
    'Execution stopped: the same operation failed 3 times at x.test/…',
  );
  assert.equal(event.extra.toolFailure.message, 'No control "…"');
});
