'use strict';

// Unit tests for single-commit publishing to the internal site repo
// (2026-10-13: three commits per translation, two of them often empty, kept
// that repo's deploys cancelling each other).
//  - a translation is one commit, page + manifest + index together
//  - re-publishing identical content makes no commit
//  - a translation of an article missing from the manifest commits only the page
//  - a push that lands mid-publish is rebased onto, not overwritten
//
// Run: node test-github-publish.js

const assert = require('assert');
const crypto = require('crypto');

process.env.GITHUB_TOKEN = 'test-token';
const { publishArticle, publishTranslation } = require('./lib/github-publish');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); failed++; }
}

// In-memory GitHub: commits hold a full { path: content } snapshot, and a
// tree's sha is a hash of its snapshot (identical content = identical sha).
function fakeGitHub(initialFiles = {}) {
  const sha = (x) => crypto.createHash('sha1').update(JSON.stringify(x)).digest('hex');
  const trees = {};
  const commits = {};
  const tree0 = sha(initialFiles);
  trees[tree0] = initialFiles;
  const c0 = sha(['root', tree0]);
  commits[c0] = { tree: tree0, message: 'root' };
  const gh = { head: c0, commits, log: [], beforeRefUpdate: null };

  const json = (status, body) => ({ status, ok: status < 400, json: async () => body });

  gh.fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const path = url.replace(/^.*\/repos\/[^/]+\/[^/]+\//, '');
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (method === 'GET' && path.startsWith('git/ref/heads/')) return json(200, { object: { sha: gh.head } });
    if (method === 'GET' && path.startsWith('git/commits/')) {
      const c = commits[path.split('/')[2]];
      return json(200, { tree: { sha: c.tree } });
    }
    if (method === 'GET' && path.startsWith('contents/')) {
      const [p, query] = path.slice('contents/'.length).split('?ref=');
      const content = trees[commits[query].tree][p];
      if (content === undefined) return json(404, { message: 'Not Found' });
      return json(200, { content: Buffer.from(content).toString('base64') });
    }
    if (method === 'POST' && path === 'git/trees') {
      const files = { ...trees[body.base_tree] };
      for (const e of body.tree) files[e.path] = e.content;
      const t = sha(files);
      trees[t] = files;
      return json(201, { sha: t });
    }
    if (method === 'POST' && path === 'git/commits') {
      const c = sha([body.parents, body.tree, body.message]);
      commits[c] = { tree: body.tree, message: body.message, parent: body.parents[0] };
      return json(201, { sha: c });
    }
    if (method === 'PATCH' && path.startsWith('git/refs/heads/')) {
      if (gh.beforeRefUpdate) { const f = gh.beforeRefUpdate; gh.beforeRefUpdate = null; f(); }
      if (commits[body.sha].parent !== gh.head) return json(422, { message: 'Update is not a fast forward' });
      gh.head = body.sha;
      gh.log.push(commits[body.sha].message);
      return json(200, { object: { sha: body.sha } });
    }
    throw new Error(`fake GitHub: unhandled ${method} ${path}`);
  };
  gh.files = () => trees[commits[gh.head].tree];
  // Simulate another pusher (e.g. a person editing the site) landing a commit.
  gh.pushOther = (path, content) => {
    const files = { ...gh.files(), [path]: content };
    const t = sha(files);
    trees[t] = files;
    const c = sha([gh.head, t, 'other']);
    commits[c] = { tree: t, message: 'other push', parent: gh.head };
    gh.head = c;
    gh.log.push('other push');
  };
  return gh;
}

const manifestWith = (...articles) => JSON.stringify(articles, null, 2);
const ES = { name: 'Spanish', label: 'Español', htmlLang: 'es' };
const translation = (over = {}) => ({
  articleId: 'a1', language: 'es', config: ES, slug: 'dui-lawyer', clientName: 'Acme Law',
  keyword: 'DUI Lawyer', translatedTitle: 'Abogado DUI', translatedHtml: '<p>Hola</p>', ...over,
});

(async () => {
  await check('a translation is one commit with page, manifest and index', async () => {
    const gh = fakeGitHub({ 'meerkat/articles.json': manifestWith({ articleId: 'a1', slug: 'dui-lawyer', title: 'DUI Lawyer', translations: {} }) });
    global.fetch = gh.fetch;
    await publishTranslation(translation());
    assert.deepStrictEqual(gh.log, ['Add translation: DUI Lawyer (Spanish)']);
    const files = gh.files();
    assert.ok(files['meerkat/dui-lawyer/es/index.html'].includes('<p>Hola</p>'));
    assert.strictEqual(JSON.parse(files['meerkat/articles.json'])[0].translations.es, 'complete');
    assert.ok(files['meerkat/index.html'], 'index written');
  });

  await check('re-publishing an identical translation makes no commit', async () => {
    const gh = fakeGitHub({ 'meerkat/articles.json': manifestWith({ articleId: 'a1', slug: 'dui-lawyer', title: 'DUI Lawyer', translations: {} }) });
    global.fetch = gh.fetch;
    await publishTranslation(translation());
    await publishTranslation(translation());
    assert.strictEqual(gh.log.length, 1);
  });

  await check('an article missing from the manifest commits only its page', async () => {
    const manifest = manifestWith({ articleId: 'other', slug: 'x', title: 'X', translations: {} });
    const gh = fakeGitHub({ 'meerkat/articles.json': manifest });
    global.fetch = gh.fetch;
    await publishTranslation(translation());
    assert.strictEqual(gh.log.length, 1);
    assert.strictEqual(gh.files()['meerkat/articles.json'], manifest);
    assert.strictEqual(gh.files()['meerkat/index.html'], undefined);
  });

  await check('a push landing mid-publish is kept, not overwritten', async () => {
    const gh = fakeGitHub({ 'meerkat/articles.json': manifestWith({ articleId: 'a1', slug: 'dui-lawyer', title: 'DUI Lawyer', translations: {} }) });
    global.fetch = gh.fetch;
    // The Vietnamese translation lands between our read and our ref update.
    gh.beforeRefUpdate = () => {
      const m = JSON.parse(gh.files()['meerkat/articles.json']);
      m[0].translations.vi = 'complete';
      gh.pushOther('meerkat/articles.json', JSON.stringify(m, null, 2));
    };
    await publishTranslation(translation());
    assert.deepStrictEqual(gh.log, ['other push', 'Add translation: DUI Lawyer (Spanish)']);
    const t = JSON.parse(gh.files()['meerkat/articles.json'])[0].translations;
    assert.deepStrictEqual(t, { vi: 'complete', es: 'complete' });
  });

  await check('a new article is one commit and keeps existing translation status', async () => {
    const gh = fakeGitHub({ 'meerkat/articles.json': manifestWith({ articleId: 'a1', slug: 'dui-lawyer', title: 'Old', translations: { es: 'complete' } }) });
    global.fetch = gh.fetch;
    await publishArticle({ articleId: 'a1', clientName: 'Acme Law', keyword: 'DUI Lawyer', slug: 'dui-lawyer', htmlContent: '<p>Hi</p>', fleschScore: 60, wordCount: 1200, pageUrl: '' });
    assert.deepStrictEqual(gh.log, ['Add article: DUI Lawyer (Acme Law)']);
    const m = JSON.parse(gh.files()['meerkat/articles.json']);
    assert.strictEqual(m.length, 1);
    assert.deepStrictEqual(m[0].translations, { es: 'complete' });
  });

  await check('GitHub errors surface instead of passing silently', async () => {
    global.fetch = async () => ({ status: 401, ok: false, json: async () => ({ message: 'Bad credentials' }) });
    await assert.rejects(publishTranslation(translation()), /401.*Bad credentials/);
  });

  if (failed) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
  console.log('\nAll tests passed');
})();
