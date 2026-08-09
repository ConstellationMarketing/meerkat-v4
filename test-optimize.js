'use strict';

const { parseChangeReport, htmlToText, extractRecommendations } = require('./lib/optimize');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}: ${err.message}`);
  }
}

function equal(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

test('parseChangeReport parses good sentinels', () => {
  equal(parseChangeReport('<<<BULLETS>>>\nExpanded the intro\nAdded an FAQ\n<<<END_BULLETS>>>'), {
    bullets: ['Expanded the intro', 'Added an FAQ'],
  });
});

test('parseChangeReport rejects missing sentinels', () => {
  equal(parseChangeReport('Expanded the intro'), { bullets: [] });
});

test('parseChangeReport rejects empty body', () => {
  equal(parseChangeReport('<<<BULLETS>>>\n\n<<<END_BULLETS>>>'), { bullets: [] });
});

test('parseChangeReport strips list markers', () => {
  equal(parseChangeReport('<<<BULLETS>>>\n- One\n* Two\n1. Three\n<<<END_BULLETS>>>'), {
    bullets: ['One', 'Two', 'Three'],
  });
});

test('htmlToText strips tags', () => {
  equal(htmlToText('<h1>Title</h1><p>Body</p>'), 'Title Body');
});

test('htmlToText drops script and style blocks', () => {
  equal(htmlToText('<style>.x { color: red; }</style><p>Keep</p><script>alert(1)</script>'), 'Keep');
});

test('htmlToText decodes supported entities', () => {
  equal(htmlToText('&amp; &lt; &gt; &quot; &#39; &nbsp;'), '& < > " \'');
});

test('htmlToText collapses whitespace', () => {
  equal(htmlToText('  Alpha\n\t Beta   Gamma  '), 'Alpha Beta Gamma');
});

test('extractRecommendations collects failed checks with fixes, merging shared fix texts', () => {
  const ocb = {
    raw: {
      checks: {
        A1: { status: 'fail', fix: 'Shorten the title.', detail: 'x' },
        A2: { status: 'fail', fix: 'Shorten the title.', detail: 'y' },
        A5: { status: 'fail', fix: 'Rewrite the meta.', detail: 'z' },
        A4: { status: 'pass', detail: '' },
        B9: { status: 'fail', detail: 'no fix text here' },
        _error: { status: 'na', detail: 'checks blew up' },
      },
    },
  };
  equal(extractRecommendations(ocb), [
    { checks: ['A1', 'A2'], fix: 'Shorten the title.' },
    { checks: ['A5'], fix: 'Rewrite the meta.' },
  ]);
});

test('extractRecommendations is empty on null OCB, missing checks, or all-pass', () => {
  equal(extractRecommendations(null), []);
  equal(extractRecommendations({ decision: 'NEW CONTENT', raw: {} }), []);
  equal(extractRecommendations({ raw: { checks: { A1: { status: 'pass' } } } }), []);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed; ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} test(s) passed`);
