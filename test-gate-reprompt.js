'use strict';

/**
 * Gate re-prompt tests: an article that fails a retryable quality gate is
 * generated again with the gate's own finding in the prompt, before anyone is
 * asked to look at it. Usage: node test-gate-reprompt.js
 *
 * The Anthropic client and the two Supabase-backed helpers are replaced at
 * require time, so the real pipeline runs end to end with no network.
 */

process.env.SKIP_PUBLISH = '1';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.AUTO_TRANSLATE = '0';

const assert = require('assert');
const Module = require('module');

// ─── Test doubles ──────────────────────────────────────────────────────────
// Every prompt the pipeline sends, in order, so a test can assert what the
// re-prompt actually told the writer.
const promptLog = [];
// What the fake model returns for a section, keyed by whether that call
// carried the gate feedback block.
let firstPassSection = null;
let retrySection = null;

function fakeCreate({ system, messages }) {
  const systemText = Array.isArray(system) ? system.map(s => s.text).join('') : String(system || '');
  const userText = String(messages[0].content);
  promptLog.push({ system: systemText, user: userText });

  const isSection = /section/i.test(systemText) && /word count/i.test(systemText);
  const isRetry = userText.includes('PREVIOUS ATTEMPT AT THIS ARTICLE WAS REJECTED');
  let text;
  if (isSection) {
    const sectionNumber = /Section 1\b/.test(userText) || /"1"/.test(userText) ? 1 : 2;
    text = (isRetry ? retrySection : firstPassSection)(sectionNumber);
  } else {
    // Every non-section stage parses JSON and falls back to a safe default when
    // it cannot, so one inert answer covers external links, internal links,
    // title/meta, review, compliance, schema and slug.
    text = '{}';
  }
  return Promise.resolve({ content: [{ text }] });
}

class FakeAnthropic {
  constructor() {
    this.messages = { create: fakeCreate };
  }
}

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@anthropic-ai/sdk') return FakeAnthropic;
  if (request === './lib/cross-article-dupe-check') {
    return { getPriorClientPhrases: async () => [], checkCrossArticleDuplicates: async () => [] };
  }
  if (request === './lib/supabase') {
    return { upsertArticle: async () => ({}), getArticle: async () => null };
  }
  if (request === './lib/github-publish') return { publishArticle: async () => null };
  return realLoad.apply(this, arguments);
};

const { runPipeline, qualityGate } = require('./pipeline');
const { gateFeedbackBlock, GATE_RETRY_REASONS, gateMaxAttempts } = require('./pipeline');

// ─── Fixtures ──────────────────────────────────────────────────────────────
const FILLER = ('The firm handles these matters across the county and the surrounding courts every week. '
  + 'A lawyer reviews the police report, the charging documents and any video before the first hearing. '
  + 'You get a written plan, a direct phone number and an answer the same day you call. ').repeat(14);

function cleanSection(n) {
  if (n === 1) {
    return `<h1>Springfield Criminal Defense Lawyer</h1>\n<p><strong>Local defense, answered today.</strong></p>\n`
      + `<h2>What a Springfield Charge Means for You</h2>\n<p>${FILLER}</p>`;
  }
  return `<h2>Talk to a Springfield Defense Lawyer Today</h2>\n<p>${FILLER}</p>`;
}

// Same article, except section 2 ships the brief's own placeholder heading —
// the exact leak the scaffold gate exists to catch.
function scaffoldSection(n) {
  if (n === 1) return cleanSection(1);
  return `<h2>Soft CTA</h2>\n<p>${FILLER}</p>`;
}

function payload(overrides = {}) {
  return {
    articleid: 'test-article-1',
    clientName: 'Test Defense Firm',
    clientInfo: 'Springfield, IL criminal defense firm. https://example-firm.test/contact/',
    website: 'https://example-firm.test',
    keyword: 'Springfield Criminal Defense Lawyer',
    template: 'supporting',
    sections: [
      { sectionNumber: 1, name: 'H1 + Intro', details: 'Open the page.', wordCount: 80 },
      { sectionNumber: 2, name: 'CTA', details: 'Close the page.', wordCount: 60 },
    ],
    ...overrides,
  };
}

// ─── Runner ────────────────────────────────────────────────────────────────
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function warningsOf(result) { return result.articleRecord.format_warnings || []; }

test('a gate failure followed by a pass ends as success with attempts=2', async () => {
  firstPassSection = scaffoldSection;
  retrySection = cleanSection;
  promptLog.length = 0;

  const result = await runPipeline(payload());

  assert.strictEqual(result.attempts, 2, 'expected exactly one re-prompt');
  assert.strictEqual(result.gateReason, null, 'expected the second attempt to clear the gate');
  const warnings = warningsOf(result);
  assert.ok(
    warnings.some(w => w === 'QUALITY: regenerated 2 times to clear the scaffold-text-leaked gate — no editor action needed'),
    `expected the heal to be recorded on the row, got: ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    !warnings.some(w => w.startsWith('QUALITY (')),
    'a healed article must not carry a gate-failure warning',
  );
});

test('the re-prompt hands the writer the gate finding, not just a retry', async () => {
  firstPassSection = scaffoldSection;
  retrySection = cleanSection;
  promptLog.length = 0;

  await runPipeline(payload());

  const retryPrompts = promptLog.filter(p => p.user.includes('PREVIOUS ATTEMPT AT THIS ARTICLE WAS REJECTED'));
  assert.ok(retryPrompts.length >= 2, `expected every section of the retry to carry the finding, got ${retryPrompts.length}`);
  assert.ok(
    retryPrompts[0].user.includes('(scaffold-text-leaked)'),
    'the re-prompt must name the gate that rejected the draft',
  );
  assert.ok(
    retryPrompts[0].user.includes('Soft CTA'),
    'the re-prompt must quote the offending text back to the writer',
  );
  assert.ok(
    promptLog.slice(0, 2).every(p => !p.user.includes('PREVIOUS ATTEMPT')),
    'the first attempt must not carry a rejection block',
  );
});

test('a triple failure ends as failed with the same editor copy as today', async () => {
  firstPassSection = scaffoldSection;
  retrySection = scaffoldSection;
  promptLog.length = 0;

  const result = await runPipeline(payload());

  assert.strictEqual(result.attempts, 3, 'expected the initial generation plus two re-prompts');
  assert.strictEqual(result.gateReason, 'scaffold-text-leaked');
  const warnings = warningsOf(result);
  assert.strictEqual(
    warnings[0],
    'QUALITY (scaffold-text-leaked): saved despite gate — needs editor review',
    'the editor-facing copy for an unhealed article must be unchanged',
  );
  assert.ok(
    warnings.includes('QUALITY: regenerated 3 times, gate still failing'),
    `expected the attempt count on the row, got: ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    warnings.some(w => w.startsWith('QUALITY: SCAFFOLD:')),
    'the gate findings must still reach the editor',
  );
});

test('GATE_MAX_ATTEMPTS=1 restores the old single-generation behaviour', async () => {
  firstPassSection = scaffoldSection;
  retrySection = cleanSection;
  process.env.GATE_MAX_ATTEMPTS = '1';
  try {
    const result = await runPipeline(payload());
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.gateReason, 'scaffold-text-leaked');
    assert.strictEqual(
      warningsOf(result)[0],
      'QUALITY (scaffold-text-leaked): saved despite gate — needs editor review',
    );
    assert.ok(
      !warningsOf(result).some(w => w.includes('regenerated')),
      'a single generation must not claim it was regenerated',
    );
  } finally {
    delete process.env.GATE_MAX_ATTEMPTS;
  }
});

test('gateMaxAttempts defaults to 3 and ignores junk', () => {
  delete process.env.GATE_MAX_ATTEMPTS;
  assert.strictEqual(gateMaxAttempts(), 3);
  process.env.GATE_MAX_ATTEMPTS = 'banana';
  assert.strictEqual(gateMaxAttempts(), 3);
  process.env.GATE_MAX_ATTEMPTS = '0';
  assert.strictEqual(gateMaxAttempts(), 3);
  process.env.GATE_MAX_ATTEMPTS = '2';
  assert.strictEqual(gateMaxAttempts(), 2);
  delete process.env.GATE_MAX_ATTEMPTS;
});

test('only model-miss gates are re-prompted', () => {
  // Every reason the gate can return, split into the two buckets on purpose:
  // a reason absent from the retry list must never burn a second generation.
  for (const reason of ['missing-original-content', 'scaffold-text-leaked', 'below-word-count',
    'majority-sections-failed', 'placeholder-content', 'missing-h1']) {
    assert.ok(GATE_RETRY_REASONS.includes(reason), `${reason} should be re-promptable`);
  }
  assert.ok(!GATE_RETRY_REASONS.includes('supabase-error'));
  assert.ok(!GATE_RETRY_REASONS.includes(undefined));
});

test('the feedback block is empty without a finding and specific with one', () => {
  assert.strictEqual(gateFeedbackBlock(null), '');
  assert.strictEqual(gateFeedbackBlock({}), '');
  const block = gateFeedbackBlock({
    reason: 'missing-original-content',
    issues: ['Missing original heading: Categories of Criminal Offenses', 'Missing original link: misdemeanor (/misdemeanor/)'],
  });
  assert.ok(block.includes('(missing-original-content)'));
  assert.ok(block.includes('reproduce it exactly'));
  assert.ok(block.includes('Missing original heading: Categories of Criminal Offenses'));
  assert.ok(block.includes('Missing original link: misdemeanor (/misdemeanor/)'));
  // A gate can produce dozens of findings; the prompt stays readable.
  const many = gateFeedbackBlock({ reason: 'scaffold-text-leaked', issues: Array.from({ length: 40 }, (_, i) => `issue ${i}`) });
  assert.ok(!many.includes('issue 12'), 'findings should be capped at 12');
});

test('the advisory gate itself is unchanged', () => {
  const short = qualityGate('<h1>x</h1><p>tiny</p>', [{ sectionNumber: 1 }], 'supporting', 10, []);
  assert.strictEqual(short.pass, false);
  assert.strictEqual(short.reason, 'below-word-count');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${err.message}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} of ${tests.length} test(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} tests passed.`);
})();
