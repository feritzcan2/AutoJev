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
  let observed = await call('browser_observe', {tabId});
  for (const label of ['First name', 'Start date', 'Location', 'Submit application'])
    assert.ok(
      labels(observed).some((l) => l.startsWith(label)),
      `${label} stays in scope: ${labels(observed)}`,
    );
  let form = await call('browser_inspect_form', {tabId});
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
  observed = await call('browser_observe', {tabId});
  assert.deepEqual(labels(observed), ['Code', 'Verify']);
  form = await call('browser_inspect_form', {tabId});
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
  form = await call('browser_inspect_form', {tabId});
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
  observed = await call('browser_observe', {tabId});
  const trigger = observed.clickTargets.find((t) => t.label === 'Select an option');
  await call('browser_click_target', {tabId, targetId: trigger.targetId});
  observed = await call('browser_observe', {tabId});
  const option = observed.clickTargets.find((t) => t.label === 'Europe');
  await call('browser_click_target', {tabId, targetId: option.targetId});
  form = await call('browser_inspect_form', {tabId});
  const chosen = form.fields.find((f) => f.type === 'picker');
  assert.equal(chosen.value, 'Europe');
  assert.equal(chosen.filled, true);
  console.log('JEV_DROP_ZONE_UPLOAD_AND_PLAIN_BUTTON_PICKER_PASS');

  // A styled checkbox draws its box over a transparent native input and puts
  // its text after it; a dropdown hides the page behind its open list.
  await page.setContent(`
    <div id="app"><form>
      <label id="country-label">Country of residence *</label>
      <div role="combobox" tabindex="0" aria-labelledby="country-label" aria-haspopup="listbox"
        aria-expanded="false" aria-controls="countries">Germany</div>
      <div><span style="position:relative;display:inline-block;width:20px;height:20px;border:1px solid #333">
        <input type="checkbox" style="opacity:0;position:absolute;inset:0;margin:0"
          onchange="document.querySelector('#go').disabled=!this.checked"></span>
        <p style="display:inline">By registering, I agree to the <a href="#terms">Terms of Use</a>.</p></div>
      <button id="go" type="button" disabled>Create account</button>
    </form></div>
    <ul id="countries" role="listbox" hidden style="position:fixed;top:0;left:0;max-height:120px;overflow:auto;margin:0"></ul>
    <script>
      const box = document.querySelector('[role=combobox]'), list = document.querySelector('#countries');
      for (const name of ['Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Argentina', 'Armenia',
        'Australia', 'Austria', 'Belgium', 'Brazil', 'Canada', 'Chile', 'France', 'Germany', 'Poland']) {
        const li = document.createElement('li');
        li.role = 'option';
        li.textContent = name;
        li.style.height = '24px';
        li.onclick = () => {
          box.textContent = name;
          box.setAttribute('aria-expanded', 'false');
          list.hidden = true;
          document.querySelector('#app').removeAttribute('aria-hidden');
        };
        list.append(li);
      }
      box.onclick = () => {
        box.setAttribute('aria-expanded', 'true');
        list.hidden = false;
        document.querySelector('#app').setAttribute('aria-hidden', 'true');
      };
    </script>`);
  form = await call('browser_inspect_form', {tabId});
  const consent = form.fields.find((f) => f.type === 'checkbox');
  assert.match(consent?.question ?? '', /^By registering, I agree to the Terms of Use/);
  const country = form.fields.find((f) => f.type === 'combobox');
  const picked = await call('browser_autocomplete', {
    tabId,
    controlId: country.controlId,
    option: 'Poland',
  });
  assert.equal(picked.status, 'ready', JSON.stringify(picked.message));
  assert.equal(picked.selection?.actual, 'Poland');
  await call('browser_click_target', {
    tabId,
    targetId: (await call('browser_observe', {tabId})).clickTargets.find(
      (t) => t.role === 'checkbox',
    ).targetId,
  });
  assert.equal(await page.evaluate(() => document.querySelector('#go').disabled), false);
  console.log('JEV_TRANSPARENT_CHECKBOX_AND_ARIA_HIDDEN_DROPDOWN_PASS');

  // The element that names a checkbox (aria-labelledby, not a <label>) is
  // laid over the input and draws its box; clicking it toggles the input.
  await page.setContent(`
    <form><div style="position:relative;padding:4px">
      <input type="checkbox" required id="legal" aria-labelledby="legal-text"
        style="position:absolute;top:4px;left:4px;width:20px;height:20px;margin:0"
        onchange="document.querySelector('#send').disabled=!this.checked">
      <div id="legal-text" style="position:relative;padding-left:28px;min-height:20px;background:#fff"
        onclick="const box=document.querySelector('#legal');box.checked=!box.checked;box.dispatchEvent(new Event('change'))">
        <span aria-hidden="true" style="position:absolute;left:0;top:0;width:18px;height:18px;border:1px solid #333"></span>
        I have read and understood the information regarding the processing of personal data.
      </div></div>
      <button id="send" type="button" disabled>Send</button>
    </form>`);
  form = await call('browser_inspect_form', {tabId});
  const legal = form.fields.find((f) => f.type === 'checkbox');
  assert.match(legal?.question ?? '', /^I have read and understood/);
  const ticked = await call('browser_select_choice', {
    tabId,
    controlId: legal.options[0].controlId,
  });
  assert.equal(ticked.status, 'ready', JSON.stringify(ticked.message));
  assert.equal(ticked.selection?.verified, true);
  assert.equal(await page.evaluate(() => document.querySelector('#send').disabled), false);
  console.log('JEV_CHECKBOX_DRAWN_BY_ITS_NAME_ELEMENT_PASS');
} finally {
  await client.close();
  await rm(directory, {recursive: true, force: true});
}
