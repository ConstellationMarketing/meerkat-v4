'use strict';

// Regression test for the sentence splitter behind splitLongParagraphs and
// FAQ truncation. Chouhan "Business Restructuring Attorney Atlanta" (Sept 2026)
// shipped "O.C.G.A. § 14-2-1 et seq." cut into four paragraphs ("O.C.G." /
// "A. § 14-2-1 et seq., ... Act, O." / "C.G.A." / "§ 14-11-100 et seq., ...")
// because every period counted as a sentence end.

const assert = require('assert');
process.env.ANTHROPIC_API_KEY ||= 'test-key';
const { splitSentences, postProcess } = require('./pipeline');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL: ${name}\n  ${err.message}`);
  }
}

const paragraphs = html => [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => m[1]);
const text = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const run = body => postProcess(`<h1>Business Restructuring Attorney Atlanta</h1>${body}`,
  { clientName: 'The Chouhan Law Firm, LLC', website: 'https://www.chouhanlaw.com', isEditMode: false });

const CHOUHAN_4194 = 'Business restructuring in Georgia follows a clear path. Knowing each step helps you plan and '
  + 'reduces stress along the way. In Georgia, how your business is formed affects your options, so the legal '
  + 'structure matters from the start. Under the Georgia Business Corporation Code, O.C.G.A. § 14-2-1 et seq., '
  + 'and the Georgia Limited Liability Company Act, O.C.G.A. § 14-11-100 et seq., the rights and obligations of '
  + 'business owners during a restructuring depend significantly on the entity type, whether a corporation, LLC, '
  + 'or partnership, which is why our document review begins by examining your operating agreements or corporate '
  + 'bylaws alongside your financial records to identify where legal risks and obligations sit before any '
  + 'strategy is built.';

test('Chouhan 4194: the O.C.G.A. citations stay inside one paragraph', () => {
  const out = run(`<h2>What Happens When You Work With Us on Restructuring</h2><p>${CHOUHAN_4194}</p>`);
  const ps = paragraphs(out);
  assert.strictEqual(ps.length, 2, `expected 2 paragraphs, got ${ps.length}: ${JSON.stringify(ps)}`);
  assert.ok(ps[0].endsWith('the legal structure matters from the start.'), ps[0]);
  assert.ok(ps[1].startsWith('Under the Georgia Business Corporation Code, O.C.G.A. § 14-2-1 et seq., and the '
    + 'Georgia Limited Liability Company Act, O.C.G.A. § 14-11-100 et seq., the rights'), ps[1]);
  assert.strictEqual(text(ps.join(' ')), text(CHOUHAN_4194));
});

test('Chouhan 4194: the citation paragraph counts as four sentences', () => {
  assert.strictEqual(splitSentences(CHOUHAN_4194).length, 4);
  assert.strictEqual(splitSentences(CHOUHAN_4194).join(''), CHOUHAN_4194);
});

test('Citation forms are one sentence each', () => {
  for (const s of [
    'Georgia sets the deadline in O.C.G.A. § 9-3-33 for most injury claims.',
    'Ga. Code Ann. § 9-3-33 gives you two years.',
    'Fla. Stat. § 95.11(3) sets a four-year limit.',
    'Federal courts hear the case under 28 U.S.C. § 1332 when the parties are diverse.',
    'The judge ruled in Smith v. Jones that the lease was void.',
    'The court docketed it as Case No. 5 last spring.',
    'Acme Supply, Inc. is the lender on the note.',
    'Bring your records, e.g. bank statements and tax returns.',
  ]) {
    const got = splitSentences(s);
    assert.strictEqual(got.length, 1, `${s} -> ${JSON.stringify(got)}`);
  }
});

test('A real sentence end after an abbreviation still ends the sentence', () => {
  for (const [s, count] of [
    ['The borrower is Chouhan Holdings, Inc. The owner signed the note. Then the lender called.', 3],
    ['The firm is based in Atlanta, Ga. We serve Cobb County too.', 2],
    ['The limit is in § 9-3-33. The court applied it strictly.', 2],
    ['Is your business in trouble? Call today. We can help!', 3],
    ['He said "stop." Then he left.', 2],
  ]) {
    const got = splitSentences(s);
    assert.strictEqual(got.length, count, `${s} -> ${JSON.stringify(got)}`);
  }
});

test('Text after the last terminator is kept, not dropped', () => {
  const body = 'One point matters here. A second point follows it. A third point closes the thought. '
    + 'A fourth point opens the next one. And a trailing clause the model left without a period';
  const out = run(`<h2>Section</h2><p>${body}</p>`);
  assert.ok(out.includes('a trailing clause the model left without a period'), out);
  assert.strictEqual(splitSentences('No terminator anywhere in this text'), null);
});

test('Inline HTML paragraphs split on the same ends and keep the citation and link', () => {
  const body = 'Restructuring starts with a review. <a href="https://www.chouhanlaw.com/contact/">Talk to the firm</a> '
    + 'about your goals. Timing matters for every owner. Under O.C.G.A. § 14-2-1 et seq., <strong>Dr. Patel</strong> '
    + 'and the U.S. lender both get notice.';
  const out = run(`<h2>Section</h2><p>${body}</p>`);
  const ps = paragraphs(out);
  assert.strictEqual(ps.length, 2, JSON.stringify(ps));
  assert.ok(ps[0].includes('<a href="https://www.chouhanlaw.com/contact/">Talk to the firm</a>'), ps[0]);
  assert.ok(ps[1].startsWith('Under O.C.G.A. § 14-2-1 et seq., <strong>Dr. Patel</strong> and the U.S. lender'), ps[1]);
});

test('A paragraph is never cut inside an element that spans a sentence end', () => {
  const body = '<strong>Your first step is a call. Your second step is the review.</strong> The third step is a plan. '
    + 'The fourth step is filing. The fifth step is follow-up.';
  const out = run(`<h2>Section</h2><p>${body}</p>`);
  for (const p of paragraphs(out)) {
    const opens = (p.match(/<strong>/g) || []).length;
    const closes = (p.match(/<\/strong>/g) || []).length;
    assert.strictEqual(opens, closes, `unbalanced paragraph: ${p}`);
  }
  assert.strictEqual(text(paragraphs(out).join(' ')), text(body));
});

console.log(`\n${failed ? `${failed} failed, ` : ''}${passed} test(s) passed`);
if (failed) process.exit(1);
