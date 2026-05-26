'use strict';

// Regression test for the "no H2 after tagline" structural check
// in lib/format-checker.js. Covers May 2026 editor reports where
// the section-writer emitted H1 + tagline + intro body (skipping
// section 2's H2 entirely), leaving the tagline orphaned.

const assert = require('assert');
const { checkAndFixFormat } = require('./lib/format-checker');

const cases = [
  {
    name: 'Canonical practice page — tagline followed immediately by H2',
    input:
      '<h1>Divorce Lawyer St Louis</h1>' +
      '<p><strong>Trusted guidance when it matters.</strong></p>' +
      '<h2>What divorce in Missouri involves</h2>' +
      '<p>Body...</p>',
    expectStructureWarning: false,
  },
  {
    name: 'No tagline at all — check is silent (some supporting pages omit it)',
    input:
      '<h1>Article H1</h1>' +
      '<h2>First section</h2>' +
      '<p>Body...</p>',
    expectStructureWarning: false,
  },
  {
    name: 'Tagline followed by intro paragraphs before any H2 (May failure mode)',
    input:
      '<h1>Article H1</h1>' +
      '<p><strong>Tagline goes here.</strong></p>' +
      '<p>Intro paragraph one with body content.</p>' +
      '<p>Intro paragraph two.</p>' +
      '<h2>What you need to know</h2>' +
      '<p>Body...</p>',
    expectStructureWarning: true,
  },
  {
    name: 'Tagline with whitespace before the H2 — still passes',
    input:
      '<h1>Title</h1>' +
      '<p><strong>Tagline.</strong></p>\n\n  \n' +
      '<h2>Heading</h2>' +
      '<p>Body...</p>',
    expectStructureWarning: false,
  },
];

let failed = 0;
for (const c of cases) {
  const { warnings } = checkAndFixFormat(c.input);
  const has = warnings.some(w => w.startsWith('STRUCTURE: No <h2> follows the tagline'));
  if (has !== c.expectStructureWarning) {
    console.error(`FAIL: ${c.name}`);
    console.error(`  expected structure warning: ${c.expectStructureWarning}`);
    console.error(`  got warnings: ${JSON.stringify(warnings)}`);
    failed++;
  } else {
    console.log(`PASS: ${c.name}  (warning=${has})`);
  }
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} tests passed`);
