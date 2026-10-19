// Dropdown buttons whose own aria-label repeats only the current answer
// ("No Required"): each control and click target must carry its question so
// two pickers on one page stay distinguishable. Real isolated Chrome; no
// network, model call or submission.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev/browser.mjs';
const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-question-dropdown-'));
const client = new JevBrowser(dir, {
  connection: 'separate',
  headless: true,
  config: async () => ({}),
  choose: async () => {
    throw Error('Model must not be called');
  },
});
const call = async (name, args) =>
  JSON.parse((await client.callTool({name, arguments: args}, 'test')).content[0].text);
// One question labelled with <label for>, one with plain rich text; both
// buttons are named only by their current value.
const field = (id, question, value, labelled) => `<div class="field">
  ${labelled ? `<label for="${id}">` : '<div>'}<div><p><b>${question}</b></p></div><abbr title="required">*</abbr>${labelled ? '</label>' : '</div>'}
  <div><button type="button" id="${id}" aria-haspopup="listbox" aria-label=" ${value} Required">${value}</button></div>
</div>`;
const fixture = `<style>.field{margin:24px}li{padding:6px;cursor:pointer}</style>
<main>
  ${field('work', 'Do you have the right to work in Germany?', 'Yes', true)}
  ${field('ai', 'Do you consent to the use of AI Tools as described above?', 'No', false)}
  <button type="button">Next</button>
</main>`;
try {
  const context = await client.context(),
    page = await context.newPage(),
    slot = await client.track(context, page),
    tabId = slot.id;
  await page.setContent(fixture);
  // A portal listbox opens for the clicked button and sets its answer.
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('[aria-haspopup]'))
      button.onclick = () => {
        document.querySelector('[role=listbox]')?.remove();
        const list = document.createElement('ul');
        list.setAttribute('role', 'listbox');
        list.id = button.id + '-list';
        button.setAttribute('aria-controls', list.id);
        button.setAttribute('aria-expanded', 'true');
        for (const answer of ['Yes', 'No']) {
          const item = document.createElement('li');
          item.setAttribute('role', 'option');
          item.textContent = answer;
          item.onclick = () => {
            button.textContent = answer;
            button.setAttribute('aria-label', ` ${answer} Required`);
            button.setAttribute('aria-expanded', 'false');
            list.remove();
          };
          list.append(item);
        }
        document.body.append(list);
      };
  });
  const observed = await call('browser_observe', {tabId});
  const labels = observed.clickTargets.map((t) => t.label);
  const consent = observed.clickTargets.find((t) => /consent to the use of AI/.test(t.label));
  assert.ok(consent, JSON.stringify(labels));
  assert.ok(
    observed.clickTargets.some((t) => /right to work in Germany/.test(t.label)),
    JSON.stringify(labels),
  );
  assert.ok(!labels.some((l) => /^\s*(Yes|No) Required$/.test(l)), JSON.stringify(labels));
  const control = observed.controls.find((c) => /consent to the use of AI/.test(c.label));
  assert.ok(control, JSON.stringify(observed.controls.map((c) => c.label)));
  const opened = await call('browser_click_target', {tabId, targetId: consent.targetId});
  const yes = opened.clickTargets.find((t) => t.role === 'option' && t.label === 'Yes');
  assert.ok(yes, JSON.stringify(opened.clickTargets));
  const chosen = await call('browser_click_target', {tabId, targetId: yes.targetId});
  assert.notEqual(chosen.status, 'stale');
  assert.equal(await page.locator('#ai').textContent(), 'Yes');
  assert.equal(await page.locator('#work').textContent(), 'Yes');
  console.log('JEV_QUESTION_DROPDOWN_PASS');
} finally {
  await client.close();
  await rm(dir, {recursive: true, force: true});
}
