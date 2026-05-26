'use strict';

// Regression test for enforceTaglineLength. Covers four real-world May 2026
// editor reports where a long tagline was sliced at word 7 and shipped as a
// broken sentence (e.g. "Make a.", "lives are at.").

const assert = require('assert');
const { enforceTaglineLength } = require('./pipeline');

function wrap(tagline) {
  return `<h1>Article H1</h1><p><strong>${tagline}</strong></p><h2>Next section</h2><p>body</p>`;
}

function getTagline(html) {
  const m = html.match(/<p><strong>([\s\S]*?)<\/strong><\/p>/);
  return m ? m[1] : null;
}

const cases = [
  {
    name: 'Within cap — keep as-is',
    input: 'Trusted guidance when it matters.',
    expect: 'Trusted guidance when it matters.',
  },
  {
    name: 'Exactly 7 words and complete — keep as-is',
    input: 'Your business built your life. Make plans.',
    expect: 'Your business built your life. Make plans.',
  },
  {
    name: 'Real failure #1 — Oregon estate planning',
    input: 'Your business built your life. Make a meaningful plan that protects everything.',
    expect: 'Your business built your life.',
  },
  {
    name: 'Real failure #2 — Virginia Beach visitation',
    input: 'Your time with your child matters. Protect it with experienced guidance.',
    expect: 'Your time with your child matters.',
  },
  {
    name: 'Real failure #3 — Sabbeth Law (single long sentence, no fitting prefix)',
    input: 'When a truck fails, lives are at risk on every highway.',
    expectDropped: true,
  },
  {
    name: 'Real failure #4 — Sabbeth Law (two short sentences fitting in 4 words)',
    input: 'The stakes are higher. The rules are different and unforgiving.',
    expect: 'The stakes are higher.',
  },
  {
    name: 'No sentence terminator at all and over cap — drop',
    input: 'Justice for families and clients starts here today',
    expectDropped: true,
  },
];

let failed = 0;
for (const c of cases) {
  const result = enforceTaglineLength(wrap(c.input));
  const got = getTagline(result);
  if (c.expectDropped) {
    if (got !== null) {
      console.error(`FAIL: ${c.name}`);
      console.error(`  expected: tagline removed`);
      console.error(`  got:      "${got}"`);
      failed++;
    } else {
      console.log(`PASS: ${c.name}  (dropped)`);
    }
  } else {
    if (got !== c.expect) {
      console.error(`FAIL: ${c.name}`);
      console.error(`  expected: "${c.expect}"`);
      console.error(`  got:      "${got}"`);
      failed++;
    } else {
      console.log(`PASS: ${c.name}  → "${got}"`);
    }
  }
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} tests passed`);
