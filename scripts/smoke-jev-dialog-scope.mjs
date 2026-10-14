import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev/browser.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'jev-dialog-scope-'));
const client = new JevBrowser(directory, {
  connection: 'separate',
  headless: true,
  config: async () => ({}),
  choose: async () => {
    throw Error('No model required');
  },
});
const call = async (name, args) =>
  JSON.parse((await client.callTool({name, arguments: args}, 'test')).content[0].text);
const labels = (o) => o.controls.map((c) => c.label);
try {
  const context = await client.context(),
    page = await context.newPage(),
    slot = await client.track(context, page),
    tabId = slot.id;
  // Dialog semantics that are not a layer over the page: a closed <dialog>
  // kept in the layout by CSS, an inline date widget with role="dialog"
  // aria-modal, and a suggestion popup that the location input controls.
  await page.setContent(`
    <style>dialog.kept{display:flex;position:absolute;top:-4000px}</style>
    <form>
      <label>First name<input name="first" required></label>
      <div role="dialog" aria-modal="true" class="calendar"><label>Start date<input name="start"></label></div>
      <label>Location<input id="loc" role="combobox" aria-controls="loc-list" aria-expanded="true" required></label>
      <button type="submit">Submit application</button>
    </form>
    <div role="dialog" style="position:fixed;top:120px;left:20px;background:#fff">
      <ul id="loc-list" role="listbox"><li role="option">Berlin, Germany</li><li role="option">Berlin, OH, USA</li></ul>
    </div>
    <dialog class="kept" aria-modal="true"><button>Close privacy policy</button></dialog>`);
  let observed = await call('browser_jev_observe', {tabId});
  for (const label of ['First name', 'Start date', 'Location', 'Submit application'])
    assert.ok(
      labels(observed).some((l) => l.startsWith(label)),
      `${label} stays in scope: ${labels(observed)}`,
    );
  let form = await call('browser_jev_inspect_form', {tabId});
  assert.deepEqual(
    form.fields.map((f) => f.label),
    ['First name', 'Start date', 'Location'],
  );
  assert.ok(form.submitControls.some((c) => c.label === 'Submit application'));
  // A real modal layer still scopes the page.
  await page.evaluate(() => {
    const d = document.createElement('dialog');
    d.innerHTML = '<label>Code<input name="code"></label><button>Verify</button>';
    document.body.append(d);
    d.showModal();
  });
  observed = await call('browser_jev_observe', {tabId});
  assert.deepEqual(labels(observed), ['Code', 'Verify']);
  form = await call('browser_jev_inspect_form', {tabId});
  assert.deepEqual(
    form.fields.map((f) => f.label),
    ['Code'],
  );
  console.log('JEV_DIALOG_SCOPE_CLOSED_INLINE_POPUP_AND_MODAL_PASS');

  // A hidden file input behind its drop zone, and a dropdown drawn as a plain
  // button without popup markup, are required fields the form lists.
  await page.setContent(`
    <form>
      <div><span>Resume *</span><div role="presentation" tabindex="0">Click to upload or drag and drop here
        <input type="file" style="display:none" required></div></div>
      <div><span>Where will you be working from? *</span>
        <button type="button" onclick="document.querySelector('menu').hidden=false">Select an option</button></div>
      <menu role="listbox" hidden><li role="option" onclick="document.querySelector('button').textContent='Europe';this.parentElement.hidden=true">Europe</li></menu>
      <div><label>Portfolio<input name="portfolio"></label><button type="button">Clear</button></div>
      <button type="submit">Apply  without saving</button>
    </form>`);
  form = await call('browser_jev_inspect_form', {tabId});
  assert.equal(form.uploads.length, 1);
  assert.match(form.uploads[0].label, /Resume\/CV/);
  const picker = form.fields.find((f) => f.type === 'picker');
  assert.equal(picker?.value, 'Select an option');
  assert.equal(picker.filled, false);
  assert.equal(
    form.fields.filter((f) => f.type === 'picker').length,
    1,
    'a Clear button beside a labelled input is not a picker',
  );
  assert.ok(form.missingRequired.some((f) => /Resume/.test(f.label ?? f)));
  observed = await call('browser_jev_observe', {tabId});
  const trigger = observed.clickTargets.find((t) => t.label === 'Select an option');
  await call('browser_jev_click', {tabId, targetId: trigger.targetId});
  observed = await call('browser_jev_observe', {tabId});
  const option = observed.clickTargets.find((t) => t.label === 'Europe');
  await call('browser_jev_click', {tabId, targetId: option.targetId});
  form = await call('browser_jev_inspect_form', {tabId});
  const chosen = form.fields.find((f) => f.type === 'picker');
  assert.equal(chosen.value, 'Europe');
  assert.equal(chosen.filled, true);
  console.log('JEV_DROP_ZONE_UPLOAD_AND_PLAIN_BUTTON_PICKER_PASS');
} finally {
  await client.close();
  await rm(directory, {recursive: true, force: true});
}
