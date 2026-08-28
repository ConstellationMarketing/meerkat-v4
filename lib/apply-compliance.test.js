'use strict';

// Run with: node --test lib/apply-compliance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCompliance } = require('./apply-compliance');

const HTML = '<p>Under Mo. Rev. Stat. 559.036 the court may act. Our expert team can help.</p>';

test('applies a normal reader-facing replacement', () => {
  const out = applyCompliance(HTML, {
    violations: [{ term: 'expert', replacement: 'knowledgeable', category: 'Superlatives', excerpt: '' }],
    total: 1,
  });
  assert.equal(out.changesApplied, 1);
  assert.match(out.htmlContent, /knowledgeable team/);
});

test('refuses an editor-note replacement instead of publishing it', () => {
  const out = applyCompliance(HTML, {
    violations: [
      { term: 'Mo. Rev. Stat. 559.036', replacement: 'Verify or remove the specific section number', category: 'Statute Accuracy', excerpt: '' },
      { term: 'expert', replacement: 'knowledgeable', category: 'Superlatives', excerpt: '' },
    ],
    total: 2,
  });
  // The instruction text must not reach the body; the safe replacement still applies.
  assert.doesNotMatch(out.htmlContent, /Verify or remove/i);
  assert.match(out.htmlContent, /Mo\. Rev\. Stat\. 559\.036/);
  assert.match(out.htmlContent, /knowledgeable team/);
  assert.equal(out.changesApplied, 1);
});

test('still honors [REMOVE]', () => {
  const out = applyCompliance('<p>We are the best firm.</p>', {
    violations: [{ term: 'best', replacement: '[REMOVE]', category: 'Superlatives', excerpt: '' }],
    total: 1,
  });
  assert.doesNotMatch(out.htmlContent, /best/);
});
