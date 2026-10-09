import test from 'node:test';
import assert from 'node:assert/strict';
import {JevBrowser} from '../app/jev-browser.mjs';
import {JevCdpTransport} from '../app/jev-cdp.mjs';

test('destroyed CDP targets retire ownership, attachments and per-tab metadata', () => {
  const browser = new JevBrowser('/unused', {connection: 'test'});
  const tab = (id) => ({id, openerId: 'home', page: {url: () => `https://example.test/${id}`}});
  browser.tabs.set('dead', tab('dead'));
  browser.tabs.set('parent', {
    ...tab('parent'),
    openedFrames: new Map([['https://example.test/frame', 'dead']]),
  });
  browser.urlHashes.set('dead', 'hash');
  browser.automationTabs.set('dead', 'source');
  browser.automationRuns.set('dead', 'run');
  browser.automationWorkspaces.set('dead', 'workspace');
  browser.automationSources.set('dead', 'https://example.test/');
  const transport = new JevCdpTransport({});
  browser.transport = transport;
  transport.owned.add('dead');
  transport.attached.add('dead');
  transport.onTargetDestroyed = (id) => browser.forgetTab(id);
  const forwarded = [];
  transport.onmessage = (message) => forwarded.push(message);
  transport.receive({method: 'Target.targetDestroyed', params: {targetId: 'dead'}});
  assert.equal(transport.owned.size, 0);
  assert.equal(transport.attached.size, 0);
  for (const map of [
    browser.tabs,
    browser.urlHashes,
    browser.automationTabs,
    browser.automationRuns,
    browser.automationWorkspaces,
    browser.automationSources,
  ])
    assert.equal(map.has('dead'), false);
  assert.equal(browser.tabs.get('parent').openedFrames.size, 0);
  assert.equal(forwarded.length, 1);
});
