'use strict';

// Unit tests for the reconciler's staleness decision (needsTranslation) in
// lib/translate-queue.js — the rule that keeps ES/VI translations in sync
// with English edits (July 2026 auto-translation work).
//
// Run: node test-translate-queue.js

const assert = require('assert');
const { needsTranslation } = require('./lib/translate-queue');

const NOW = Date.parse('2026-07-10T12:00:00Z');
const iso = (offsetMin) => new Date(NOW + offsetMin * 60 * 1000).toISOString();

let passed = 0;
function t(name, actual, expected) {
  assert.strictEqual(actual, expected, name);
  console.log(`  ✓ ${name}`);
  passed++;
}

console.log('needsTranslation:');

// Missing translation → always needed
t('missing translation is needed', needsTranslation(undefined, Date.parse(iso(-60)), NOW), true);
t('missing translation needed even without updated_at', needsTranslation(null, null, NOW), true);

// Complete translations
t(
  'complete + article edited AFTER translation → stale',
  needsTranslation({ status: 'complete', translated_at: iso(-120) }, Date.parse(iso(-30)), NOW),
  true
);
t(
  'complete + article edited BEFORE translation → fresh',
  needsTranslation({ status: 'complete', translated_at: iso(-30) }, Date.parse(iso(-120)), NOW),
  false
);
t(
  'complete + no updated_at → fresh (nothing to compare)',
  needsTranslation({ status: 'complete', translated_at: iso(-30) }, null, NOW),
  false
);
t(
  'complete legacy (no translated_at) → left alone',
  needsTranslation({ status: 'complete' }, Date.parse(iso(-30)), NOW),
  false
);

// Pending translations
t(
  'pending stuck > 30 min → retry',
  needsTranslation({ status: 'pending', queued_at: iso(-45), attempts: 0 }, Date.parse(iso(-120)), NOW),
  true
);
t(
  'pending recent (< 30 min) → leave running',
  needsTranslation({ status: 'pending', queued_at: iso(-5), attempts: 0 }, Date.parse(iso(-120)), NOW),
  false
);
t(
  'pending legacy (no queued_at) → retry',
  needsTranslation({ status: 'pending' }, Date.parse(iso(-120)), NOW),
  true
);
t(
  'pending stuck but attempts exhausted → give up',
  needsTranslation({ status: 'pending', queued_at: iso(-45), attempts: 3 }, Date.parse(iso(-120)), NOW),
  false
);

// Failed translations
t(
  'failed with attempts left → retry',
  needsTranslation({ status: 'failed', failed_at: iso(-10), attempts: 1 }, Date.parse(iso(-120)), NOW),
  true
);
t(
  'failed with attempts exhausted → give up',
  needsTranslation({ status: 'failed', failed_at: iso(-10), attempts: 3 }, Date.parse(iso(-120)), NOW),
  false
);
t(
  'failed + edited since failure → retry even if attempts exhausted',
  needsTranslation({ status: 'failed', failed_at: iso(-60), attempts: 3 }, Date.parse(iso(-10)), NOW),
  true
);

console.log(`\n${passed} tests passed.`);
