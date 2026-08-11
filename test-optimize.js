'use strict';

const {
  parseChangeReport, htmlToText, extractRecommendations,
  htmlToBlockText, extractPageSections, buildEditSections, minimumWordCount,
} = require('./lib/optimize');

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

test('htmlToBlockText keeps paragraph breaks and renders list items as bullets', () => {
  equal(
    htmlToBlockText('<p>First para.</p><p>Second para.</p><ul><li>One</li><li>Two</li></ul>'),
    'First para.\nSecond para.\n- One\n- Two'
  );
});

// A miniature but structurally realistic client page: theme chrome around a
// content region with H1, intro, real H2 sections, and widget headings.
const PAGE = `<html><head><title>t</title><style>.x{}</style></head><body>
<header><h2>Site Menu</h2><a href="/">Home</a></header>
<nav><h2>Practice Areas</h2></nav>
<div id="main">
  <span>Home » Estate Planning</span>
  <h1 class="entry-title">What Happens Without an Estate Plan</h1>
  <p>Intro sentence one about intestacy. Intro sentence two.</p>
  <h2>How the State Handles It</h2>
  <p>State intestacy law controls the estate and applies automatically to every case the court sees.</p>
  <h2>The Probate Court's Role</h2>
  <p>The court appoints an administrator and supervises each required step of the estate process closely.</p>
  <h2>Related Posts</h2><p>Ten suggested articles with long teaser text that should never count as page content here.</p>
  <h2>Empty Widget</h2><p>tiny</p>
</div>
<footer><h2>Contact</h2><p>555-1234</p></footer>
</body></html>`;

test('extractPageSections parses H1, intro, and real H2 sections; drops chrome and widgets', () => {
  const parsed = extractPageSections(PAGE);
  equal(parsed.h1, 'What Happens Without an Estate Plan');
  equal(parsed.sections.map(s => s.heading), ["How the State Handles It", "The Probate Court's Role"]);
  equal(parsed.hasFaq, false);
  equal(parsed.hasCta, false);
});

test('extractPageSections starts intro after the H1, excluding breadcrumbs', () => {
  const parsed = extractPageSections(PAGE);
  equal(parsed.intro.text, 'Intro sentence one about intestacy. Intro sentence two.');
});

test('extractPageSections detects FAQ and CTA headings', () => {
  const html = '<h1>T</h1><p>i</p>'
    + '<h2>Frequently Asked Questions</h2><p>Answers to the questions readers ask us most often about this legal topic.</p>'
    + '<h2>Contact Our Team</h2><p>Reach out to schedule a consultation with our attorneys about your estate today.</p>';
  const parsed = extractPageSections(html);
  equal(parsed.hasFaq, true);
  equal(parsed.hasCta, true);
});

test('extractPageSections flags a trailing prose CTA without a CTA heading', () => {
  const html = '<h1>T</h1><p>i</p>'
    + '<h2>Section One</h2><p>Body text that is long enough to be treated as a real content section here.</p>'
    + '<h2>Planning Ahead</h2><p>Planning matters. Contact our firm to schedule a consultation about your options.</p>';
  equal(extractPageSections(html).hasCta, true);
});

test('buildEditSections maps parsed sections to numbered edit jobs sized to the original', () => {
  const parsed = extractPageSections(PAGE);
  const jobs = buildEditSections(parsed, []);
  equal(jobs.map(j => j.mode), ['edit', 'edit', 'edit', 'add', 'add']);
  equal(jobs.map(j => j.sectionNumber), [1, 2, 3, 4, 5]);
  equal(jobs[0].originalText.startsWith('# What Happens Without an Estate Plan'), true);
  equal(jobs[1].originalText.startsWith('## How the State Handles It'), true);
  equal(jobs[3].name, 'CTA');
  equal(jobs[4].name, 'FAQ');
});

test('buildEditSections reuses the house template briefs for added CTA/FAQ', () => {
  const parsed = extractPageSections(PAGE);
  const jobs = buildEditSections(parsed, [
    { name: 'CTA', details: 'House CTA brief', wordCount: 90 },
    { name: 'FAQ', details: 'House FAQ brief', wordCount: 300 },
  ]);
  const cta = jobs.find(j => j.name === 'CTA');
  const faq = jobs.find(j => j.name === 'FAQ');
  equal(cta.details, 'House CTA brief');
  equal(faq.details, 'House FAQ brief');
  equal(faq.wordCount, 300);
});

test('buildEditSections skips CTA/FAQ jobs when the page already has them', () => {
  const html = '<h1>T</h1><p>intro text here</p>'
    + '<h2>Body Section</h2><p>Long enough body text for this section to count as real page content today.</p>'
    + '<h2>FAQ</h2><p>Question and answer content long enough to register as a real section of the page.</p>'
    + '<h2>Contact Us</h2><p>Call our office to schedule a consultation and speak with one of our attorneys.</p>';
  const jobs = buildEditSections(extractPageSections(html), []);
  equal(jobs.filter(j => j.mode === 'add').length, 0);
});

test('extractPageSections yields the fallback signal on an unstructured page', () => {
  const parsed = extractPageSections('<h1>Thin</h1><p>One line of text and nothing else.</p>');
  equal(parsed.sections.length, 0);
});

test('extractPageSections strips head, hero buttons, and badge/location widget sections', () => {
  const html = '<head><title>Speed Up Your Visa - ATT LAW</title></head>'
    + '<h1>Real Heading</h1><p>GET IN TOUCH</p><p>GET IN TOUCH NOW</p><p>A real intro sentence about the topic follows here.</p>'
    + '<h2>As Featured In:</h2><p>Boston Globe and several other outlets have covered this firm many times before.</p>'
    + '<h2>Office Locations</h2><p>Austin office at 100 Main St, Houston office at 200 Elm St, and a Dallas office too.</p>'
    + '<h2>Real Section</h2><p>Long enough body text for this section to count as genuine page content today.</p>';
  const parsed = extractPageSections(html);
  equal(parsed.intro.text, 'A real intro sentence about the topic follows here.');
  equal(parsed.sections.map(s => s.heading), ['Real Section']);
});

test('extractPageSections keeps a substantive Categories of Criminal Offenses section', () => {
  const html = '<h1>What Is Considered a Criminal Offense in Illinois?</h1><p>An introduction with enough context for the reader.</p>'
    + '<h2>Categories of Criminal Offenses</h2><p>Illinois recognizes felony classes, misdemeanor classes, and sentencing ranges that affect the possible consequences in each case.</p>'
    + '<h2>How Charges Begin</h2><p>A criminal case may begin after an investigation, an arrest, or the filing of a charging document by prosecutors.</p>';
  const parsed = extractPageSections(html);
  equal(parsed.sections.map(s => s.heading), ['Categories of Criminal Offenses', 'How Charges Begin']);
});

test('extractPageSections preserves existing internal links in section markdown', () => {
  const html = '<h1>Criminal Defense</h1><p>An introduction with enough context for the reader.</p>'
    + '<h2>Your Options</h2><p>Read our <a href="https://libertylaw.com/criminal-defense/">criminal defense practice page</a> or <a href="/contact/">contact us</a> to discuss your case.</p>'
    + '<h2>What Happens Next</h2><p>The next steps depend on the charge, the available evidence, and the procedural posture of the case.</p>';
  const parsed = extractPageSections(html);
  equal(parsed.sections[0].text, 'Read our [criminal defense practice page](https://libertylaw.com/criminal-defense/) or [contact us](/contact/) to discuss your case.');
});

test('edit-mode word gate keeps pages that started at 1000+ words above 1000', () => {
  equal(minimumWordCount(1120, true), 1000);
  equal(minimumWordCount(1600, true), 1280);
  equal(minimumWordCount(900, true), 720);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed; ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} test(s) passed`);
