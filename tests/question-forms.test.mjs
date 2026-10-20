import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceDatabase} from '../app/workspaces/database.mjs';
import {AutomationStore} from '../app/automation/store.mjs';
import {normalizeFields, validateAnswers, quickAnswer} from '../app/automation/question-forms.mjs';
import {validate} from '../app/agents/tool-schema.mjs';
import {startTestServer} from './helpers/tool-server.mjs';
import {automationWorkflow} from '../app/automation/worker.mjs';
import {automationTools as tools} from '../app/automation/tools.mjs';
const fields = [
  {id: 'permit', label: 'Çalışma iznin var mı?', type: 'boolean'},
  {id: 'salary', label: 'Maaş', type: 'number'},
  {id: 'days', label: 'Günler', type: 'multiselect', options: ['Pazartesi', 'Salı']},
];
test('forms validate explicit false, zero and choice answers; no inferred consent or unknown fields', () => {
  const f = normalizeFields(fields);
  assert.deepEqual(validateAnswers(f, {permit: false, salary: 0, days: ['Salı']}).values, {
    permit: false,
    salary: 0,
    days: ['Salı'],
  });
  for (const bad of [
    {salary: 10, days: ['Salı']},
    {permit: 'yes', salary: 10, days: ['Salı']},
    {permit: true, salary: 10, days: ['Friday']},
    {permit: true, salary: 10, days: ['Salı'], extra: true},
  ])
    assert.throws(() => validateAnswers(f, bad));
  assert.throws(() => normalizeFields([...fields, fields[0]]));
  assert.throws(() =>
    validateAnswers(normalizeFields([{id: 'date', label: 'Tarih', type: 'date'}]), {
      date: '2026-02-30',
    }),
  );
  validate(tools.find((t) => t.name === 'ask_workspace_question').inputSchema, {
    text: 'Başvuruyu tamamlayalım',
    fields,
  });
  validate({type: 'object', properties: {}, additionalProperties: false}, {});
});
test('structured answers remain candidate-scoped, preserve readable evidence and reject double answers', async () => {
  const core = new WorkspaceDatabase(':memory:'),
    s = new AutomationStore(core),
    p = s.create('job-search'),
    other = s.create('custom'),
    run = s.begin(p.id, 'interview');
  const flow = automationWorkflow({
      db: s,
      run,
      signal: new AbortController().signal,
      browser: {},
      report: () => {},
    }),
    mcp = await startTestServer(core, flow),
    token = mcp.grant(p.id, run.id);
  try {
    const response = await fetch(mcp.endpoint, {
      method: 'POST',
      headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'ask_workspace_question',
          arguments: {text: 'İki bilgi', fields: fields.slice(0, 2)},
        },
      }),
    });
    const result = (await response.json()).result;
    assert.notEqual(result.isError, true);
    const q = s.get(p.id).questions[0];
    assert.equal(q.fields.length, 2);
    assert.throws(() => s.answerQuestion(other.id, q.id, {permit: true, salary: 70000}));
    assert.throws(() => s.answerQuestion(p.id, q.id, '   '));
    s.answerQuestion(p.id, q.id, {permit: false, salary: 70000});
    assert.match(s.get(p.id).questions[0].answer, /No/);
    assert.equal(s.get(p.id).questions[0].answerValues.salary, 70000);
    assert.throws(() => s.answerQuestion(p.id, q.id, {permit: true, salary: 1}));
    const legacy = s.askQuestion(p.id, {text: 'Legacy?'});
    s.answerQuestion(p.id, legacy.id, 'Normal text');
    assert.equal(s.get(p.id).questions.at(-1).answer, 'Normal text');
  } finally {
    await mcp.close();
    core.close();
  }
});

test('a form accepts a free-text reply without fabricating structured answers', () => {
  const core = new WorkspaceDatabase(':memory:'),
    s = new AutomationStore(core);
  try {
    const p = s.create('job-search'),
      q = s.askQuestion(p.id, {text: 'Details', fields});
    const result = s.answerQuestion(p.id, q.id, 'İznim var, maaş beklentimi henüz belirlemedim.');
    assert.equal(result.answerValues, null);
    assert.equal(s.get(p.id).questions[0].fields.length, 3);
    assert.match(s.get(p.id).questions[0].answer, /henüz belirlemedim/);
    assert.throws(() => s.answerQuestion(p.id, q.id, 'Again'));
  } finally {
    core.close();
  }
});

test('an instruction replaces the answer and is marked as an instruction', () => {
  const core = new WorkspaceDatabase(':memory:'),
    s = new AutomationStore(core);
  try {
    const p = s.create('job-search'),
      q = s.askQuestion(p.id, {text: 'Cover letter file?', fields});
    assert.throws(() => s.answerQuestion(p.id, q.id, {instruction: '   '}));
    const result = s.answerQuestion(p.id, q.id, {instruction: 'Write a cover letter from my CV.'});
    assert.equal(result.instruction, true);
    assert.equal(result.answerValues, null);
    assert.equal(result.answer, 'Write a cover letter from my CV.');
    assert.match(s.messages(p.id).at(-1).text, /Instruction: Write a cover letter/);
  } finally {
    core.close();
  }
});

test('notification answers fill the stored form and reach the question hook', () => {
  const core = new WorkspaceDatabase(':memory:'),
    s = new AutomationStore(core),
    asked = [];
  s.questionAsked = (id, question) => asked.push([id, question.id]);
  try {
    const p = s.create('job-search'),
      ask = (text, fields) => s.askQuestion(p.id, {text, ...(fields ? {fields} : {})}),
      free = ask('Notice period?'),
      permit = ask('Work permit?', [{id: 'permit', label: 'Permit', type: 'boolean'}]),
      salary = ask('Salary?', [{id: 'salary', label: 'Salary', type: 'number'}]),
      level = ask('Level?', [{id: 'level', label: 'Level', type: 'select', options: ['A', 'B']}]);
    assert.deepEqual(
      asked.map(([, id]) => id),
      [free.id, permit.id, salary.id, level.id],
    );
    s.answerQuestion(p.id, free.id, quickAnswer(free).reply('Three months'));
    const choice = quickAnswer(permit);
    assert.deepEqual(choice.options, ['Yes', 'No']);
    assert.equal(s.answerQuestion(p.id, permit.id, choice.choose('No')).answerValues.permit, false);
    assert.throws(() => s.answerQuestion(p.id, salary.id, quickAnswer(salary).reply(' ')));
    assert.equal(
      s.answerQuestion(p.id, salary.id, quickAnswer(salary).reply('65000')).answerValues.salary,
      65000,
    );
    assert.equal(
      s.answerQuestion(p.id, level.id, quickAnswer(level).choose('B')).answerValues.level,
      'B',
    );
    assert.equal(s.get(p.id).questions[0].answer, 'Three months');
    // Larger forms and cover letters stay in the window.
    assert.equal(quickAnswer({fields}), null);
    assert.equal(quickAnswer({coverLetter: {path: 'letter.pdf'}}), null);
    assert.equal(
      quickAnswer({fields: [{id: 'x', label: 'X', type: 'select', options: ['1', '2', '3', '4']}]}),
      null,
    );
  } finally {
    core.close();
  }
});
