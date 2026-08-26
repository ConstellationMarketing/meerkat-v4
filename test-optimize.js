'use strict';

const fs = require('fs');
const path = require('path');
const {
  parseChangeReport, htmlToText, extractRecommendations,
  htmlToBlockText, extractPageSections, buildEditSections, minimumWordCount,
  buildPreservationRequirements, preservationIssues, failureRecord, missingSectionSource,
} = require('./lib/optimize');
const { mergeOptimizeItems } = require('./routes/os-api');
process.env.ANTHROPIC_API_KEY ||= 'test-key';
const {
  preservationReviewPreamble, qualityGate, shouldPublishExternally, applyDestructiveLinkTransforms,
  buildReviewPrompts, stripPhoneNumbers, postProcess, keepBestPreserved,
} = require('./pipeline');
const { compileArticle, convertToHTML } = require('./lib/article-compiler');
const { applyCompliance } = require('./lib/apply-compliance');

let passed = 0;
let failed = 0;

const optimizeSectionPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'optimize-section.md'), 'utf8');

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

test('optimization prompt preserves absent openings and original heading levels', () => {
  equal(optimizeSectionPrompt.includes('If the current opening has no tagline or introduction, do not add either one.'), true);
  equal(optimizeSectionPrompt.includes('Make sure 2-4 sentences of introduction follow'), false);
  equal(optimizeSectionPrompt.includes('starts with the exact ## or ### heading marker shown in CURRENT CONTENT'), true);
});

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

test('extractPageSections preserves substantive H3 sections and their levels', () => {
  const html = '<h1>THE CLUB</h1>'
    + '<h3>The Name</h3><p>Majestic Soccer Club began with international and domestic players in Atlanta more than four decades ago.</p>'
    + '<h3>The Foundation</h3><p>The team rebuilt around a small core and steadily added stronger players over several seasons.</p>'
    + '<h2>Our Accomplishments</h2><p>The club earned league and cup honors across multiple decades of competitive play.</p>';
  const parsed = extractPageSections(html);
  equal(parsed.sections.map(section => [section.level, section.heading]), [
    [3, 'The Name'],
    [3, 'The Foundation'],
    [2, 'Our Accomplishments'],
  ]);
});

test('buildEditSections keeps an H1-only opening instead of inventing an introduction', () => {
  const parsed = extractPageSections('<h1>THE CLUB</h1><h3>The Name</h3><p>This section has enough original body copy to count as page content today.</p>');
  const [opening, section] = buildEditSections(parsed, []);
  equal(opening.wordCount, 1);
  equal(opening.details.includes('Do not add'), true);
  equal(section.originalText.startsWith('### The Name'), true);
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

test('buildEditSections maps only original sections to numbered edit jobs', () => {
  const parsed = extractPageSections(PAGE);
  const jobs = buildEditSections(parsed, []);
  equal(jobs.map(j => j.mode), ['edit', 'edit', 'edit']);
  equal(jobs.map(j => j.sectionNumber), [1, 2, 3]);
  equal(jobs[0].originalText.startsWith('# What Happens Without an Estate Plan'), true);
  equal(jobs[1].originalText.startsWith('## How the State Handles It'), true);
});

test('buildEditSections never appends house CTA or FAQ sections to an optimization', () => {
  const parsed = extractPageSections(PAGE);
  const jobs = buildEditSections(parsed, [
    { name: 'CTA', details: 'House CTA brief', wordCount: 90 },
    { name: 'FAQ', details: 'House FAQ brief', wordCount: 300 },
  ]);
  equal(jobs.some(job => job.mode === 'add'), false);
  equal(jobs.some(job => job.name === 'CTA' || job.name === 'FAQ'), false);
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

test('edit-mode word gate never allows fewer than 1000 words', () => {
  equal(minimumWordCount(1120, true), 1000);
  equal(minimumWordCount(1600, true), 1280);
  equal(minimumWordCount(900, true), 1000);
});

test('short edit pages receive enough section target to land in the full-marks word band', () => {
  const parsed = {
    h1: 'What Is Considered a Criminal Offense in Illinois?',
    intro: { text: 'Short opening.', words: 76 },
    sections: [
      { heading: 'Categories of Criminal Offenses', text: 'x', words: 227 },
      { heading: 'Legal Consequences', text: 'y', words: 205 },
      { heading: 'How an Attorney Can Help', text: 'z', words: 107 },
    ],
    hasFaq: false,
    hasCta: true,
    totalWords: 615,
  };
  const jobs = buildEditSections(parsed, []);
  equal(jobs.reduce((total, job) => total + job.wordCount, 0), 1550);
  equal(jobs.slice(0, 4).map(job => job.name), [
    'Page opening',
    'Categories of Criminal Offenses',
    'Legal Consequences',
    'How an Attorney Can Help',
  ]);
});

test('OS optimize merge retains immutable batch item identity', () => {
  equal(mergeOptimizeItems([
    { os_batch_item_id: 'item-42', url: 'https://example.com', guidance: 'keep' },
  ], [{ keyword: 'Fees', clientName: 'Alpha Engine Folder' }], 'user-1'), [{
    keyword: 'Fees',
    clientName: 'Alpha Engine Folder',
    os_batch_item_id: 'item-42',
    url: 'https://example.com',
    guidance: 'keep',
    userId: 'user-1',
  }]);
});

test('failure records retain immutable OS batch item identity', () => {
  const record = failureRecord('article-1', {
    os_batch_item_id: 'item-42', keyword: 'Fees', clientName: 'Alpha Engine Folder',
  }, 'Fetch failed', '2026-08-11T00:00:00.000Z');
  equal(record, {
    articleId: 'article-1',
    osBatchItemId: 'item-42',
    keyword: 'Fees',
    clientName: 'Alpha Engine Folder',
    error: 'Fetch failed',
    timestamp: '2026-08-11T00:00:00.000Z',
  });
});

test('preservation text normalization decodes numeric entities', () => {
  const requirements = buildPreservationRequirements('<h1>What to Do if You&#x2019;re Arrested</h1><p>Body.</p>');
  equal(preservationIssues('<h1>What to Do if You’re Arrested</h1><p>Body.</p>', requirements), []);
});

test('edit mode retains phone links through deterministic post-processing', () => {
  const source = '<p>Call <a href="tel:6304494800">(630) 449-4800</a>.</p>';
  equal(stripPhoneNumbers(source, true), source);
  equal(stripPhoneNumbers(source, false).includes('(630) 449-4800'), false);
});

test('preservation requirements exclude article metadata and sidebar chrome', () => {
  const source = '<article>'
    + '<section><a href="/category/criminal-law/">Criminal Law</a><h1>Arrested in Illinois</h1></section>'
    + '<section><div><div class="prose"><p>Read the <a href="/rights/">rights guide</a>.</p><h2>What to Do</h2><p>Stay calm.</p></div>'
    + '<a href="/contact/">Contact Us</a></div>'
    + '<aside><h2>Recent Posts</h2><a href="/old-post/">Old Post</a></aside></section>'
    + '</article>';
  equal(buildPreservationRequirements(source), {
    headings: ['Arrested in Illinois', 'What to Do'],
    links: [
      { anchor: 'rights guide', href: '/rights/' },
      { anchor: 'Contact Us', href: '/contact/' },
    ],
  });
});

test('preservation requirements protect original H3 headings', () => {
  const source = '<main><h1>THE CLUB</h1><h3>The Name</h3><p>Original body.</p><h2>Alumni</h2><p>Members.</p></main>';
  const requirements = buildPreservationRequirements(source);
  equal(requirements.headings, ['THE CLUB', 'The Name', 'Alumni']);
  equal(preservationIssues('<h1>THE CLUB</h1><h2>Alumni</h2><p>Members.</p>', requirements), [
    'Missing original heading: The Name',
  ]);
});

test('preservation requirements include links from short CTA sections', () => {
  const source = '<main><h1>Criminal Offense</h1><p>Intro.</p>'
    + '<h2>Legal Consequences</h2><p>The consequences may depend on the charge, prior history, available evidence, and final resolution.</p>'
    + '<h2>Contact Us</h2><p><a href=/contact/>Call Today</a></p></main>';
  const requirements = buildPreservationRequirements(source, extractPageSections(source));
  equal(requirements.headings, ['Criminal Offense', 'Legal Consequences', 'Contact Us']);
  equal(requirements.links, [
    { anchor: 'Call Today', href: '/contact/' },
  ]);
});

test('preservation checks exact case and duplicate counts', () => {
  const requirements = {
    headings: ['Criminal Offense', 'Criminal Offense'],
    links: [
      { anchor: 'Call Today', href: '/contact/' },
      { anchor: 'Call Today', href: '/contact/' },
    ],
  };
  equal(preservationIssues(
    '<h1>criminal offense</h1><h2>Criminal Offense</h2><a href="/contact/">call today</a>',
    requirements,
  ), [
    'Missing original heading: Criminal Offense',
    'Missing original link: Call Today (/contact/)',
    'Missing original link: Call Today (/contact/)',
  ]);
});

test('preservation requirements reject missing original headings and links', () => {
  const source = '<h1>Criminal Offense</h1><p>Intro.</p>'
    + '<h2>Categories of Criminal Offenses</h2><p>Read about a <a href="/misdemeanor/">misdemeanor</a> and how Illinois classifies criminal charges by severity and possible consequences.</p>'
    + '<h2>Legal Consequences</h2><p>The consequences may depend on the charge, prior history, available evidence, and the final resolution.</p>';
  const requirements = buildPreservationRequirements(source, extractPageSections(source));
  equal(preservationIssues(
    '<h1>Criminal Offense</h1><h2>Legal Consequences</h2><p>Read about a misdemeanor.</p>',
    requirements,
  ), [
    'Missing original heading: Categories of Criminal Offenses',
    'Missing original link: misdemeanor (/misdemeanor/)',
  ]);
  equal(preservationIssues(source, requirements), []);
});

test('edit mode skips destructive link transforms', () => {
  const source = '<h2>Contact Us</h2><p>'
    + '<a href="https://firm.com/">Home Link</a> '
    + '<a href="https://firm.com/">Duplicate Home Link</a> '
    + '<a href="https://justia.com/page">Directory Link</a></p>';
  equal(applyDestructiveLinkTransforms(source, 'https://firm.com', true), source);
  const changed = applyDestructiveLinkTransforms(source, 'https://firm.com', false);
  equal(changed.includes('Duplicate Home Link</a>'), false);
  equal(changed.includes('Directory Link</a>'), false);
  equal(changed.includes('href="https://firm.com/contact"'), true);
});

test('external publish requires a passed quality gate and successful Supabase upsert', () => {
  equal(shouldPublishExternally({ skipPublish: false, skipExternal: false, qcPass: true, supabaseError: null }), true);
  equal(shouldPublishExternally({ skipPublish: false, skipExternal: false, qcPass: false, supabaseError: 'Quality gate failed' }), false);
  equal(shouldPublishExternally({ skipPublish: false, skipExternal: false, qcPass: true, supabaseError: 'Supabase failed' }), false);
  equal(shouldPublishExternally({ skipPublish: true, skipExternal: false, qcPass: true, supabaseError: null }), false);
  equal(shouldPublishExternally({ skipPublish: false, skipExternal: true, qcPass: true, supabaseError: null }), false);
});

test('quality gate blocks edit output that drops preserved content', () => {
  const result = qualityGate(
    '<h1>Criminal Offense</h1><h2>Legal Consequences</h2><p>body</p>',
    [{ sectionNumber: 1 }],
    'Practice Page',
    1100,
    [],
    900,
    true,
    {
      headings: ['Criminal Offense', 'Categories of Criminal Offenses', 'Legal Consequences'],
      links: [{ anchor: 'misdemeanor', href: '/misdemeanor/' }],
    },
  );
  equal(result.reason, 'missing-original-content');
  equal(result.issues, [
    'Missing original heading: Categories of Criminal Offenses',
    'Missing original link: misdemeanor (/misdemeanor/)',
  ]);
});

const PRESERVED_DRAFT = '<h1>What To Do if You are Arrested</h1><h2>Your Rights</h2>'
  + '<p>Call <a href="/contact/">Contact Us</a> to discuss the charge.</p>';
const ARRESTED_PAGE = {
  headings: ['What To Do if You are Arrested', 'Your Rights'],
  links: [{ anchor: 'Contact Us', href: '/contact/' }],
};

test('a preserved edit draft under the word target is saved with a warning, not discarded', () => {
  const result = qualityGate(PRESERVED_DRAFT, [{ sectionNumber: 1 }], 'Practice Page', 998, [], 572, true, ARRESTED_PAGE);
  equal(result.pass, true);
  equal(result.issues, ['Word count 998 below minimum 1000 (edit-preservation gate for 572 target)']);
});

test('an edit draft shorter than the live page it replaces still fails', () => {
  const result = qualityGate(PRESERVED_DRAFT, [{ sectionNumber: 1 }], 'Practice Page', 500, [], 572, true, ARRESTED_PAGE);
  equal(result.pass, false);
  equal(result.reason, 'below-word-count');
});

test('a short edit draft that also lost content reports the lost content', () => {
  const result = qualityGate('<h1>What To Do if You are Arrested</h1><p>body</p>', [{ sectionNumber: 1 }], 'Practice Page', 400, [], 572, true, ARRESTED_PAGE);
  equal(result.reason, 'missing-original-content');
});

test('an edit draft with no known original length still fails hard on word count', () => {
  const result = qualityGate(PRESERVED_DRAFT, [{ sectionNumber: 1 }], 'Practice Page', 998, [], null, true, ARRESTED_PAGE);
  equal(result.pass, false);
  equal(result.reason, 'below-word-count');
});

test('compose-mode drafts still fail hard on word count', () => {
  const result = qualityGate('<h1>Title</h1><p>body</p>', [{ sectionNumber: 1 }], 'Practice Page', 500, [], 2007, false, null);
  equal(result.pass, false);
  equal(result.reason, 'below-word-count');
});

test('optimization prompts preserve exact headings and links through proofreading', () => {
  const sectionPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'optimize-section.md'), 'utf8');
  const reviewPrompt = fs.readFileSync(path.join(__dirname, 'prompts', 'article-review.md'), 'utf8');
  equal(sectionPrompt.includes('Keep the existing heading text exactly'), true);
  equal(reviewPrompt.includes('preserved original link'), true);
  equal(reviewPrompt.includes('article agreement'), true);
});

test('edit review system overrides heading rename rules', () => {
  const prompts = buildReviewPrompts({
    system: 'Rewrite generic H2 headings and remove duplicate H2 headings.',
    user: 'Review article.',
  }, true, {
    headings: ['Criminal Offense', 'Legal Consequences'],
    links: [],
  });
  equal(prompts.system.startsWith('EDIT-MODE OVERRIDE:'), true);
  equal(prompts.system.includes('Never remove or rename any heading listed in ORIGINAL CONTENT'), true);
  equal(prompts.user.includes('Legal Consequences'), true);
});

// Regression: batch opt-2026-08-12-57171e3e failed the preservation gate on the
// libertylawfirm.net arrest page even though the model returned the section's
// links verbatim. The deterministic chain, not the model, was eating them.
test('edit-mode post-processing keeps every original link in a CTA section', () => {
  const opening = [
    '# What to Do if You’re Arrested in Illinois',
    '',
    'Facing an arrest can be terrifying. If you are arrested in DuPage County, Illinois, it helps to understand your rights and responsibilities before anything else happens. [Liberty Law](/) can guide you through the process.',
  ].join('\n');
  const section = [
    '## Additional Considerations in DuPage County',
    '',
    'Most criminal cases in DuPage County are handled at the courthouse in Wheaton. It is important to hire an attorney who has experience arguing cases in DuPage County.',
    '',
    'A skilled criminal defense lawyer at [Liberty Law](/) can help guide you through the criminal justice system and arrest process.',
    '',
    'If you require personalized legal advice, please [contact us](/contact/) or call [(630) 449-4800](tel:6304494800). We can help with your specific situation.',
    '',
    '[Contact Us](/contact/)',
  ].join('\n');
  const processed = postProcess(compileArticle([opening, section]), {
    clientName: 'Liberty Law',
    lockKw: null,
    website: 'https://libertylawfirm.net',
    isEditMode: true,
  });
  equal(preservationIssues(processed, {
    headings: ['What to Do if You’re Arrested in Illinois', 'Additional Considerations in DuPage County'],
    links: [
      { anchor: 'Liberty Law', href: '/' },
      { anchor: 'Liberty Law', href: '/' },
      { anchor: 'contact us', href: '/contact/' },
      { anchor: '(630) 449-4800', href: 'tel:6304494800' },
      { anchor: 'Contact Us', href: '/contact/' },
    ],
  }), []);
});

// The structural reviewer is a whole-article LLM rewrite. When it returns an
// article that lost protected content, the pre-review draft is the better one:
// its only defect is unfixed formatting, which is not a batch-failing offense.
test('review result is discarded when it loses protected content', () => {
  const preservation = { headings: ['Contact Our Firm'], links: [{ anchor: 'contact us', href: '/contact/' }] };
  const before = '<h2>Contact Our Firm</h2><p>Please <a href="/contact/">contact us</a> today.</p>';
  const reviewed = '<h2>Contact Our Firm</h2><p>Please reach out today.</p>';
  equal(keepBestPreserved(before, reviewed, preservation, 'structural review'), before);
});

test('review result is kept when it preserves protected content', () => {
  const preservation = { headings: ['Contact Our Firm'], links: [{ anchor: 'contact us', href: '/contact/' }] };
  const before = '<h2>Contact Our Firm</h2><p>Please  <a href="/contact/">contact us</a>  today.</p>';
  const reviewed = '<h2>Contact Our Firm</h2><p>Please <a href="/contact/">contact us</a> today.</p>';
  equal(keepBestPreserved(before, reviewed, preservation, 'structural review'), reviewed);
});

test('review result is kept unchanged when there is nothing to preserve', () => {
  equal(keepBestPreserved('<p>a</p>', '<p>b</p>', null, 'structural review'), '<p>b</p>');
});

// Batch opt-2026-08-12-c4f585ef lost "Your Responsibilities After the Arrest"
// even though the section editor returned it: the model wrote the heading and
// its body as one block, and the compiler put the whole block inside the <h2>.
test('compiler splits a heading from body text that follows it without a blank line', () => {
  const html = convertToHTML('## Your Responsibilities After the Arrest\nOnce processed, you have duties:\n- Attend all court dates\n- Comply with bail conditions');
  equal(html.includes('<h2>Your Responsibilities After the Arrest</h2>'), true);
  equal(html.includes('<li>Attend all court dates</li>'), true);
  equal(/<h2>[^<]*<li>/.test(html), false);
});

test('compiler keeps a heading alone when nothing follows it', () => {
  equal(convertToHTML('## Standalone Heading'), '<h2>Standalone Heading</h2>');
  equal(convertToHTML('# Page Title\n\nBody sentence here.'), '<h1>Page Title</h1>\n\n<p>Body sentence here.</p>');
});

// Batch opt-2026-08-12-a03803a9: every deterministic loss was fixed, and the
// only remaining failure was the section editor silently dropping the
// standalone "[Contact Us](/contact/)" line at the end of its section.
test('missingSectionSource names the markdown the edit dropped', () => {
  const original = '## Additional Considerations\nCall [Liberty Law](/) today.\n\n[Contact Us](/contact/)';
  const output = '## Additional Considerations\nCall [Liberty Law](/) today.';
  equal(missingSectionSource(original, output), ['link [Contact Us](/contact/)']);
});

test('missingSectionSource tolerates re-typeset punctuation and reordering', () => {
  const original = "## What to Do if You’re Arrested\nSee [contact us](/contact/) and [Liberty Law](/).";
  const output = "## What to Do if You're Arrested\nSee [Liberty Law](/) and [contact us](/contact/).";
  equal(missingSectionSource(original, output), []);
});

test('missingSectionSource flags a heading the edit renamed', () => {
  equal(missingSectionSource('## Your Responsibilities After the Arrest\nBody.', '## After the Arrest\nBody.'),
    ['heading "Your Responsibilities After the Arrest"']);
});

test('htmlToText survives out-of-range numeric entities', () => {
  equal(htmlToText('<p>Fee&#1114112;schedule &#x110000; here</p>').includes('schedule'), true);
});

test('compliance replacements survive a > inside an attribute value', () => {
  const { htmlContent } = applyCompliance(
    '<p><a title="x > y" href="/guarantee/">guarantee</a></p>',
    { violations: [{ term: 'guarantee', replacement: 'work toward' }] }
  );
  equal(htmlContent.includes('href="/guarantee/"'), true);
  equal(htmlContent.includes('title="x > y"'), true);
  equal(htmlContent.includes('>work toward</a>'), true);
});

// A bare "<" in prose ("resolve in < 5 years") must not start a pseudo-tag
// that swallows the text up to the next real tag and hides it from rewriting.
test('compliance replacements survive a stray < in body text', () => {
  const { htmlContent } = applyCompliance(
    '<p>Cases resolve in < 5 years and we guarantee results.</p><p>Call us.</p>',
    { violations: [{ term: 'guarantee', replacement: 'work toward' }] }
  );
  equal(htmlContent.includes('work toward'), true);
  equal(htmlContent.includes('guarantee'), false);
  equal(htmlContent.includes('< 5 years'), true);
});

test('FAQ truncation never leaves an inline element unclosed', () => {
  const out = postProcess(
    '<h1>T</h1><h2>FAQ</h2><h3>Q?</h3>'
    + '<p><a href="/x">First one here. Second one here. Third one here.</a> Fourth one here.</p>',
    { clientName: 'Firm', website: 'https://x.com', isEditMode: false }
  );
  equal((out.match(/<a /g) || []).length, (out.match(/<\/a>/g) || []).length);
});

test('compliance replacements never rewrite HTML attributes', () => {
  const { htmlContent } = applyCompliance(
    '<p>We <a href="/guarantee/" title="guarantee">guarantee</a> results.</p>',
    { violations: [{ term: 'guarantee', replacement: 'work toward' }] }
  );
  equal(htmlContent.includes('href="/guarantee/"'), true);
  equal(htmlContent.includes('title="guarantee"'), true);
  equal(htmlContent.includes('>work toward</a>'), true);
});

// deduplicatePhrases and truncateFAQAnswers both used to rebuild a paragraph
// from its tag-stripped text, which silently deleted every link inside it.
test('phrase dedup keeps links while removing the repeated word', () => {
  const out = postProcess(
    '<h1>Arrested in Illinois</h1>\n<p>Our our team at <a href="/">Liberty Law</a> can help you today, so please <a href="/contact/">contact us</a> about your case.</p>',
    { clientName: 'Liberty Law', website: 'https://libertylawfirm.net', isEditMode: true }
  );
  equal(out.includes('Our our'), false);
  equal(preservationIssues(out, {
    headings: [],
    links: [{ anchor: 'Liberty Law', href: '/' }, { anchor: 'contact us', href: '/contact/' }],
  }), []);
});

test('FAQ truncation keeps links inside the sentences it retains', () => {
  const out = postProcess(
    '<h1>Arrested in Illinois</h1><h2>FAQ</h2><h3>Who should I call?</h3>'
    + '<p>Call <a href="/contact/">contact us</a> right away. A lawyer can review the arrest. '
    + 'Bail terms vary by county. Court dates are set later.</p>',
    { clientName: 'Liberty Law', website: 'https://libertylawfirm.net', isEditMode: false }
  );
  equal(out.includes('Court dates are set later'), false);
  equal(out.includes('<a href="/contact/">contact us</a>'), true);
});

test('FAQ truncation is skipped in edit mode so the live page keeps its answers', () => {
  const answer = '<p>Call <a href="/contact/">contact us</a> right away. A lawyer can review the arrest. '
    + 'Bail terms vary by county. Court dates are set later.</p>';
  const out = postProcess(
    '<h1>Arrested in Illinois</h1><h2>FAQ</h2><h3>Who should I call?</h3>' + answer,
    { clientName: 'Liberty Law', website: 'https://libertylawfirm.net', isEditMode: true }
  );
  equal(out.includes('Court dates are set later'), true);
});

test('FAQ truncation counts abbreviations as one sentence when markup is present', () => {
  const out = postProcess(
    '<h1>Arrested in Illinois</h1><h2>FAQ</h2><h3>Who reviews the file?</h3>'
    + '<p>Dr. Smith reviews the intake with <a href="/contact/">our team</a>. '
    + 'A lawyer then reads the police report. '
    + 'Bail terms vary by county. Court dates are set later.</p>',
    { clientName: 'Liberty Law', website: 'https://libertylawfirm.net', isEditMode: false }
  );
  equal(out.includes('<a href="/contact/">our team</a>'), true);
  equal(out.includes('A lawyer then reads the police report.'), true);
  equal(out.includes('Bail terms vary by county'), false);
});

test('FAQ truncation falls back to text when abbreviations break the HTML split', () => {
  const out = postProcess(
    '<h1>Arrested in Illinois</h1><h2>FAQ</h2><h3>Who reviews the file?</h3>'
    + '<p>Dr. Smith reviews the intake with you. A lawyer then reads the police report. '
    + 'Bail terms vary by county. Court dates are set later.</p>',
    { clientName: 'Liberty Law', website: 'https://libertylawfirm.net', isEditMode: false }
  );
  equal(out.includes('Dr. Smith reviews the intake with you.'), true);
  equal(out.includes('A lawyer then reads the police report.'), true);
  equal(out.includes('Court dates are set later'), false);
});

// The generators rewrite ’ as ', – as -, and … as ... . That is typography, not
// lost content, and it must not fail the preservation gate.
test('preservation tolerates typographic punctuation swaps', () => {
  const requirements = buildPreservationRequirements(
    '<h1>What to Do if You’re Arrested</h1><h2>Fees – What to Expect</h2>'
    + '<p><a href="/contact/">Let’s talk</a></p>'
  );
  equal(preservationIssues(
    "<h1>What to Do if You're Arrested</h1><h2>Fees - What to Expect</h2>"
    + '<p><a href="/contact/">Let\'s talk</a></p>',
    requirements
  ), []);
});

test('preservation still rejects genuinely different heading text', () => {
  const requirements = buildPreservationRequirements('<h1>What to Do if You’re Arrested</h1>');
  equal(preservationIssues('<h1>What to Do After an Arrest</h1>', requirements).length, 1);
});

test('review preamble lists the exact original content that must survive', () => {
  const preamble = preservationReviewPreamble({
    headings: ['Criminal Offense', 'Categories of Criminal Offenses'],
    links: [{ anchor: 'misdemeanor', href: '/misdemeanor/' }],
  });
  equal(preamble.includes('Categories of Criminal Offenses'), true);
  equal(preamble.includes('misdemeanor -> /misdemeanor/'), true);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed; ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} test(s) passed`);
