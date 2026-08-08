'use strict';

const { parseChangeReport, htmlToText } = require('./lib/optimize');

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

if (failed > 0) {
  console.error(`\n${failed} test(s) failed; ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} test(s) passed`);
