import test from 'node:test';
import assert from 'node:assert/strict';
import {neverCompany, neverItems, withNever} from '../src/simple/facts.js';

test('the never-apply list is one elimination rule', () => {
  const rules = withNever('Hold if not stated: Remote within the EU', ['Acme', 'Globex GmbH']);
  assert.equal(
    rules,
    'Hold if not stated: Remote within the EU\nAccept if not stated: Never apply to: Acme, Globex GmbH',
  );
  assert.deepEqual(neverItems(rules), ['Acme', 'Globex GmbH']);
  assert.equal(withNever(rules, []), 'Hold if not stated: Remote within the EU');
});
test('company names match regardless of case and legal suffix', () => {
  const items = ['Acme', 'Globex GmbH', 'Trendyol'];
  assert.ok(neverCompany('ACME Inc.', items));
  assert.ok(neverCompany('Globex', items));
  assert.ok(neverCompany('Acme Games Studio', items));
  assert.ok(neverCompany('Trendyol Teknoloji A.Ş.', items));
  assert.ok(!neverCompany('Acmeville', items));
  assert.ok(!neverCompany('', items));
  assert.ok(!neverCompany('Initech', items));
});
