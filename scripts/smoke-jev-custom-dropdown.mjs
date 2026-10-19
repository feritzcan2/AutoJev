// Custom dropdowns without a native SELECT: an ARIA select-only combobox and a
// labelled button (aria-haspopup) whose portal popup is a tree with a search
// box, a full-page backdrop and a sticky header. Real isolated Chrome; no
// network, model call or submission.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {JevBrowser} from '../app/jev/browser.mjs';
import {controlState} from './jev-control-state.mjs';
const remember = controlState();
const dir = await mkdtemp(path.join(os.tmpdir(), 'jev-custom-dropdown-'));
const client = new JevBrowser(dir, {
  connection: 'separate',
  headless: true,
  config: async () => ({}),
  choose: async () => {
    throw Error('Model must not be called');
  },
});
const call = async (name, args) =>
  remember(JSON.parse((await client.callTool({name, arguments: args}, 'test')).content[0].text));
const countries = ['Austria', 'Belgium', 'Croatia', 'Denmark', 'France', 'Germany', 'Italy'];
const fixture = `<style>
  header{position:sticky;top:0;height:90px;background:#eee;z-index:5}
  .field{margin:24px;width:400px}
  .required label::after{content:" *"}
  .trigger{border:1px solid #888;padding:10px;min-height:20px;cursor:pointer}
  .trigger [data-placeholder]:empty::before{content:attr(data-placeholder);color:#999}
  [role=option],[role=treeitem]{padding:6px;cursor:pointer}
  .backdrop{position:fixed;inset:0;z-index:20}
  .panel{position:fixed;left:24px;top:200px;width:400px;background:white;border:1px solid;z-index:21}
  .spacer{height:1400px}
</style>
<header>Sticky header</header>
<form onsubmit="event.preventDefault();window.submits++">
  <div class="field"><label id="permit-label">Work permit</label>
    <div id="permit" class="trigger" role="combobox" tabindex="0" aria-labelledby="permit-label"
      aria-required="true" aria-haspopup="listbox" aria-controls="permit-list" aria-expanded="false">
      <span data-placeholder="Select"></span></div></div>
  <div class="field"><label id="relocate-label">Open to relocation?</label>
    <div id="relocate" class="trigger" role="combobox" tabindex="0" aria-labelledby="relocate-label"
      aria-controls="relocate-list" aria-expanded="false"><span data-placeholder="Select"></span></div></div>
  <div class="spacer"></div>
  <div class="field required"><label id="country-label">Country</label>
    <div id="country" class="trigger" role="button" tabindex="0" aria-haspopup="true"
      aria-labelledby="country-label" aria-expanded="false"><span data-placeholder="Select"></span></div></div>
  <button type="button" aria-haspopup="menu">Account</button>
  <div role="button" aria-haspopup="true" tabindex="0">More</div>
  <button type="submit">Apply</button>
</form>
<ul role="listbox" id="permit-list" hidden><li role="option">Yes</li><li role="option">No</li></ul>
<ul role="listbox" id="relocate-list" hidden><li role="option">Yes</li><li role="option">No</li></ul>`;
try {
  const context = await client.context(),
    page = await context.newPage(),
    slot = await client.track(context, page),
    tabId = slot.id;
  const reset = async () => {
    await page.setContent(fixture);
    await page.evaluate((countries) => {
      window.submits = 0;
      // Select-only comboboxes with an aria-controls listbox.
      for (const id of ['permit', 'relocate']) {
        const trigger = document.getElementById(id),
          list = document.getElementById(id + '-list');
        trigger.onclick = () => {
          list.hidden = !list.hidden;
          trigger.setAttribute('aria-expanded', String(!list.hidden));
          const r = trigger.getBoundingClientRect();
          Object.assign(list.style, {position: 'fixed', left: r.left + 'px', top: r.bottom + 'px'});
        };
        for (const option of list.children)
          option.onclick = () => {
            trigger.firstElementChild.textContent = option.textContent;
            list.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
          };
      }
      // Button trigger: portal popup labelled by the same label, no aria-controls,
      // a backdrop over the page and a search box filtering a virtualized tree.
      const country = document.getElementById('country');
      const close = () => {
        document.querySelectorAll('.backdrop,.panel').forEach((e) => e.remove());
        country.setAttribute('aria-expanded', 'false');
      };
      country.onclick = () => {
        const backdrop = document.createElement('div'),
          panel = document.createElement('div');
        backdrop.className = 'backdrop';
        backdrop.onclick = close;
        panel.className = 'panel';
        panel.innerHTML =
          '<input type="search" role="combobox" aria-controls="country-tree" placeholder="Search"><div role="tree" id="country-tree" aria-labelledby="country-label"></div>';
        document.body.append(backdrop, panel);
        const search = panel.querySelector('input'),
          tree = panel.querySelector('[role=tree]');
        const render = () => {
          tree.replaceChildren(
            ...countries
              .filter((c) => c.toLowerCase().includes(search.value.toLowerCase()))
              .slice(0, 3)
              .map((c) => {
                const item = document.createElement('div');
                item.setAttribute('role', 'treeitem');
                item.innerHTML = `<span><span>${c}</span></span>`;
                item.onclick = () => {
                  country.firstElementChild.textContent = c;
                  close();
                };
                return item;
              }),
          );
        };
        search.oninput = render;
        render();
        country.setAttribute('aria-expanded', 'true');
        search.focus();
      };
    }, countries);
    return call('browser_observe', {tabId});
  };
  let observed = await reset();
  let form = await call('browser_inspect_form', {tabId});
  const missing = form.missingRequired.map((f) => f.label);
  assert.deepEqual(missing, ['Work permit', 'Country'], JSON.stringify(form.missingRequired));
  assert.ok(form.missingRequired.every((f) => f.type === 'combobox'));
  const relocate = form.fields.find((f) => f.label === 'Open to relocation?');
  assert.equal(relocate.filled, false);
  assert.equal(relocate.required, undefined);
  assert.ok(!form.fields.some((f) => ['Account', 'More'].includes(f.label)));
  const control = (result, label) => result.controls.find((c) => c.label === label);
  assert.equal(control(observed, 'Work permit').autocomplete, true);
  assert.equal(control(observed, 'Country').autocomplete, true);
  assert.equal(control(observed, 'Country').required, true);
  // Exact option through the combobox; verified from the trigger caption.
  let result = await call('browser_autocomplete', {
    tabId,
    controlId: control(observed, 'Work permit').controlId,
    option: 'Yes',
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.deepEqual(result.selection, {label: 'Yes', actual: 'Yes', verified: true});
  // The country trigger sits under the sticky header: reveal must clear it,
  // and text goes into the popup's search box to reach a virtualized option.
  await page.evaluate(() => {
    const r = document.getElementById('country').getBoundingClientRect();
    scrollBy(0, r.top - 40);
  });
  result = await call('browser_autocomplete', {
    tabId,
    controlId: control(result, 'Country').controlId,
    text: 'Germ',
    option: 'Germany',
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.deepEqual(result.selection, {label: 'Germany', actual: 'Germany', verified: true});
  form = await call('browser_inspect_form', {tabId});
  assert.deepEqual(form.missingRequired, []);
  // An option missing from a list without a search query is not guessed.
  result = await call('browser_autocomplete', {
    tabId,
    controlId: control(result, 'Open to relocation?').controlId,
    option: 'Maybe',
  });
  assert.equal(result.status, 'needs_selection');
  assert.deepEqual(result.suggestions, ['Yes', 'No']);
  // Native-select operations on a custom dropdown use the same popup path.
  observed = await reset();
  result = await call('browser_list_options', {
    tabId,
    controlId: control(observed, 'Open to relocation?').controlId,
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.deepEqual(result.suggestions, ['Yes', 'No']);
  result = await call('browser_choose_option', {
    tabId,
    controlId: control(result, 'Open to relocation?').controlId,
    option: 'No',
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.equal(result.selection.verified, true);
  // A click-opened popup exposes its options as click targets, even while a
  // backdrop covers the trigger; the trigger stays usable by controlId.
  await page.evaluate(() => document.getElementById('country').scrollIntoView({block: 'center'}));
  observed = await call('browser_observe', {tabId});
  const trigger = observed.clickTargets.find((t) => t.label === 'Country');
  result = await call('browser_click_target', {tabId, targetId: trigger.targetId});
  const options = result.clickTargets.filter((t) => t.role === 'option').map((t) => t.label);
  assert.deepEqual(options, ['Austria', 'Belgium', 'Croatia']);
  result = await call('browser_autocomplete', {
    tabId,
    controlId: control(result, 'Country').controlId,
    option: 'Belgium',
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.equal(await page.locator('#country').innerText(), 'Belgium');
  assert.equal(await page.evaluate(() => window.submits), 0);
  // A search text for a list without a search box does not block the wanted option.
  observed = await reset();
  result = await call('browser_autocomplete', {
    tabId,
    controlId: control(observed, 'Open to relocation?').controlId,
    text: 'No',
    option: 'No',
  });
  assert.equal(result.status, 'ready', JSON.stringify(result).slice(0, 600));
  assert.equal(result.selection?.verified, true, JSON.stringify(result).slice(0, 600));
  // Compound field: one label over an amount input and an unlabelled currency
  // trigger (its aria-labelledby points nowhere). The trigger takes the field's
  // label and required; a neighbouring field's label is never borrowed. Error
  // text shown in the field after a failed submit marks it in missingRequired.
  await page.setContent(`<form onsubmit="event.preventDefault()">
    <div class="field"><div><label for="salary-group">Desired salary</label></div>
      <div id="salary-group">
        <span><input id="salary" type="tel" role="spinbutton" required></span>
        <span><div id="currency" role="button" aria-haspopup="true" tabindex="0"
          aria-labelledby="currency-label" aria-describedby="currency-message">
          <span data-placeholder="Select"></span></div></span></div>
      <p id="salary-error" hidden><span>Error</span>
        <span class="message error">Both fields are required</span></p></div>
    <div class="row"><div><label for="first">First name *</label><input id="first"></div>
      <div><input id="nickname"></div></div>
    <div><label for="email">Email</label><input id="email" aria-describedby="email-help email-error">
      <span id="email-help">Work address</span><span id="email-error" role="alert"></span></div>
    <button type="submit">Apply</button></form>`);
  await call('browser_observe', {tabId});
  form = await call('browser_inspect_form', {tabId});
  const salary = form.fields.filter((f) => f.label === 'Desired salary');
  assert.deepEqual(
    salary.map((f) => [f.type, f.required, f.filled]),
    [
      ['spinbutton', true, false],
      ['combobox', true, false],
    ],
    JSON.stringify(form.fields),
  );
  assert.ok(!form.fields.some((f) => f.label === 'First name *' && f.required !== true));
  assert.equal(form.fields.filter((f) => f.label === 'First name *').length, 1);
  assert.deepEqual(
    form.missingRequired.map((f) => [f.label, f.type]),
    [
      ['Desired salary', 'spinbutton'],
      ['Desired salary', 'combobox'],
      ['First name *', 'text'],
    ],
  );
  await page.fill('#salary', '70000');
  await page.fill('#first', 'Ada');
  await page.fill('#email', 'ada@');
  await page.evaluate(() => {
    document.getElementById('salary-error').hidden = false;
    document.getElementById('email').setAttribute('aria-invalid', 'true');
    document.getElementById('email-error').textContent = 'Enter a valid email address';
  });
  form = await call('browser_inspect_form', {tabId});
  const missingCurrency = form.missingRequired.find((f) => f.type === 'combobox');
  assert.equal(missingCurrency?.label, 'Desired salary', JSON.stringify(form.missingRequired));
  assert.equal(missingCurrency.validationMessage, 'Both fields are required');
  assert.equal(
    form.missingRequired.find((f) => f.label === 'Email')?.validationMessage,
    'Enter a valid email address',
  );
  assert.ok(!form.missingRequired.some((f) => f.label === 'First name *'));
  // A long virtualized list without a search box renders ~15 options at a
  // time. Listing and selecting scroll the popup list instead of giving up.
  await page.setContent(`<style>#cur-list{height:240px;overflow:auto;position:relative}
    #cur-list [role=option]{position:absolute;left:0;right:0;height:24px;cursor:pointer}</style>
    <label id="cur-label">Currency</label>
    <div id="cur" role="combobox" tabindex="0" aria-labelledby="cur-label" aria-haspopup="listbox"
      aria-controls="cur-list" aria-expanded="false" style="border:1px solid;padding:8px">Select</div>
    <div role="listbox" id="cur-list" hidden><div id="cur-pad"></div></div>`);
  await page.evaluate(() => {
    const codes = Array.from({length: 160}, (_, n) => 'C' + String(n).padStart(3, '0'));
    codes[97] = 'EUR €';
    const trigger = document.getElementById('cur'),
      list = document.getElementById('cur-list'),
      pad = document.getElementById('cur-pad');
    pad.style.height = codes.length * 24 + 'px';
    const render = () => {
      for (const n of [...list.querySelectorAll('[role=option]')]) n.remove();
      const first = Math.floor(list.scrollTop / 24);
      for (let i = first; i < Math.min(codes.length, first + 15); i++) {
        const item = document.createElement('div');
        item.setAttribute('role', 'option');
        item.style.top = i * 24 + 'px';
        item.textContent = codes[i];
        item.onclick = () => {
          trigger.textContent = codes[i];
          list.hidden = true;
          trigger.setAttribute('aria-expanded', 'false');
        };
        list.append(item);
      }
    };
    list.onscroll = render;
    trigger.onclick = () => {
      list.hidden = !list.hidden;
      trigger.setAttribute('aria-expanded', String(!list.hidden));
      render();
    };
  });
  observed = await call('browser_observe', {tabId});
  result = await call('browser_list_options', {
    tabId,
    controlId: control(observed, 'Currency').controlId,
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.equal(result.optionCount, 160, JSON.stringify(result).slice(0, 400));
  assert.ok(result.suggestions.includes('EUR €'));
  observed = await call('browser_observe', {tabId});
  result = await call('browser_autocomplete', {
    tabId,
    controlId: control(observed, 'Currency').controlId,
    option: 'EUR €',
  });
  assert.equal(result.status, 'ready', JSON.stringify(result).slice(0, 600));
  assert.equal(result.selection.verified, true);
  assert.equal(await page.locator('#cur').innerText(), 'EUR €');
  console.log('JEV_CUSTOM_DROPDOWN_REQUIRED_SELECT_SEARCH_BACKDROP_PASS');
} finally {
  await client.close();
  await rm(dir, {recursive: true, force: true});
}
