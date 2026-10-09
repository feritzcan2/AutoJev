import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ageLabel, elapsedLabel} from '../src/activity.js';

test('activity age labels do not fabricate timestamps', () => {
  const start = Date.parse('2026-01-01T10:00:00Z'),
    at = new Date(start).toISOString();
  assert.equal(ageLabel(at, start + 12000), 'Son bildirim: 12 saniye önce');
  assert.equal(ageLabel(null), 'Henüz işlem bildirimi yok');
  assert.equal(ageLabel('not a date'), 'Güncelleme zamanı bilinmiyor');
});

test('running turns count up from their start', () => {
  const start = Date.parse('2026-01-01T10:00:00Z'),
    at = new Date(start).toISOString();
  assert.equal(elapsedLabel(at, start + 42000), '42 saniyedir çalışıyor');
  assert.equal(elapsedLabel(at, start + 5 * 60000), '5 dakikadır çalışıyor');
  assert.equal(elapsedLabel(at, start + 2 * 3600000), '2 saattir çalışıyor');
});
