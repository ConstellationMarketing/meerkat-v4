'use strict';

const GITHUB_API = 'https://api.github.com';
const REPO = 'ConstellationMarketing/internal';
const BRANCH = 'main';
const BASE_PATH = 'meerkat';

const SHARED_STYLES = `
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap">
  <style>
    :root {
      --background: #faf6f6;
      --foreground: #0E3057;
      --card: #ffffff;
      --primary: #4fbc85;
      --primary-light: #78d5a5;
      --muted: #f3f4f4;
      --muted-foreground: #687684;
      --border: #e5e7e8;
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', ui-sans-serif, system-ui; background: var(--background); color: var(--foreground); max-width: 860px; margin: 0 auto; padding: 32px 24px; line-height: 1.7; }
    h1, h2, h3, h4 { font-family: 'Poppins', ui-sans-serif, system-ui; color: var(--foreground); font-weight: 600; margin: 1.5em 0 0.5em; }
    h1 { font-size: 1.75rem; }
    h2 { font-size: 1.35rem; }
    h3 { font-size: 1.1rem; }
    p { margin-bottom: 1em; }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .meta-bar { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; margin-bottom: 40px; font-size: 13px; }
    .meta-bar h2 { font-size: 14px; font-weight: 600; color: var(--muted-foreground); text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 16px; font-family: 'Inter', ui-sans-serif; }
    .meta-bar table { border-collapse: collapse; width: 100%; }
    .meta-bar td { padding: 5px 12px 5px 0; font-size: 13px; }
    .meta-bar td:first-child { font-weight: 500; color: var(--muted-foreground); white-space: nowrap; width: 110px; }
    .meta-bar td:last-child { color: var(--foreground); }
    .meta-badge { display: inline-block; background: var(--muted); color: var(--foreground); border-radius: 6px; padding: 2px 8px; font-size: 12px; font-weight: 500; }
    .meta-badge.green { background: #e8f7f0; color: #2a7a54; }
    .meta-badge.yellow { background: #fef9e6; color: #8a6d00; }
    .meta-badge.red { background: #fde8e8; color: #8a1f1f; }
  </style>`;

function buildArticleHtml({ clientName, keyword, articleId, fleschScore, wordCount, pageUrl, htmlContent }) {
  const readabilityLabel = fleschScore >= 70 ? 'Good' : fleschScore >= 50 ? 'Fair' : 'Difficult';
  const badgeClass = fleschScore >= 70 ? 'green' : fleschScore >= 50 ? 'yellow' : 'red';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${clientName} — ${keyword}</title>
${SHARED_STYLES}
</head>
<body>
<div class="meta-bar">
  <h2>Meerkat &mdash; Claude Output Preview</h2>
  <table>
    <tr><td>Client</td><td>${clientName}</td></tr>
    <tr><td>Keyword</td><td>${keyword}</td></tr>
    <tr><td>Article ID</td><td><span class="meta-badge">${articleId}</span></td></tr>
    <tr><td>Flesch Score</td><td><span class="meta-badge ${badgeClass}">${fleschScore} — ${readabilityLabel}</span></td></tr>
    <tr><td>Word Count</td><td>${wordCount}</td></tr>
    <tr><td>Page URL</td><td>${pageUrl ? `<a href="${pageUrl}" target="_blank">${pageUrl}</a>` : '&mdash;'}</td></tr>
  </table>
</div>
${htmlContent}
</body>
</html>`;
}

const MAX_COMMIT_ATTEMPTS = 3;

// Every commit to the site repo starts a deploy there, and a newer push
// cancels the one in flight. Publishing used to make three Contents-API
// commits per page (page, manifest, index) - the last two often with no
// change - so a translation backlog kept the site from ever finishing a
// deploy (2026-10-13). commitFiles() writes all of a publish's files as one
// commit, and none at all when nothing changed.
async function githubRequest(method, path, body) {
  const res = await fetch(`${GITHUB_API}/repos/${REPO}/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 404 && method === 'GET') return null;
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${path} failed (${res.status}): ${data?.message || 'unknown error'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function getManifest(ref) {
  const file = await githubRequest('GET', `contents/${BASE_PATH}/articles.json?ref=${ref}`);
  if (!file || !file.content) return [];
  return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
}

/**
 * Commit files to BRANCH as a single commit. `buildFiles(ref)` returns
 * { path: content } built from the repo at commit `ref`; it is re-run if
 * another push lands first, so read-modify-write files (the manifest) never
 * drop a concurrent update. Returns false when the files already match.
 */
async function commitFiles(message, buildFiles) {
  for (let attempt = 1; ; attempt++) {
    const ref = await githubRequest('GET', `git/ref/heads/${BRANCH}`);
    const parent = ref.object.sha;
    const { tree } = await githubRequest('GET', `git/commits/${parent}`);
    const files = await buildFiles(parent);

    const newTree = await githubRequest('POST', 'git/trees', {
      base_tree: tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
    });
    if (newTree.sha === tree.sha) return false; // nothing changed - no commit, no deploy

    const commit = await githubRequest('POST', 'git/commits', { message, tree: newTree.sha, parents: [parent] });
    try {
      await githubRequest('PATCH', `git/refs/heads/${BRANCH}`, { sha: commit.sha });
      return true;
    } catch (err) {
      // 422 = not a fast-forward: someone else pushed. Rebuild on the new head.
      if (err.status !== 422 || attempt >= MAX_COMMIT_ATTEMPTS) throw err;
    }
  }
}

const LANG_LABELS = { es: '🇪🇸 Español', vi: '🇻🇳 Tiếng Việt' };
const ALL_LANGS = ['es', 'vi'];

function buildTranslationCell(article) {
  const t = article.translations || {};

  const doneLinks = ALL_LANGS
    .filter(lang => t[lang] === 'complete')
    .map(lang => `<a href="/meerkat/${article.slug}/${lang}/" class="lang-link">${LANG_LABELS[lang]}</a>`)
    .join(' ');

  // Always show the Translate button
  const translateBtn = `
    <span class="translate-wrap">
      <button class="translate-btn" onclick="toggleDropdown(this,'${article.articleId}','${article.slug}')">Translate &#9662;</button>
      <div class="lang-dropdown"></div>
    </span>`;

  return `${doneLinks}${doneLinks && translateBtn ? ' ' : ''}${translateBtn}`;
}

function buildIndexHtml(articles) {
  const apiUrl = process.env.TRANSLATE_API_URL || 'https://meerkat-api.goconstellation.com';

  const sorted = [...articles].sort((a, b) => new Date(b.date) - new Date(a.date));

  const rows = sorted.map(a => `
      <tr data-article-id="${a.articleId}" data-slug="${a.slug}">
        <td><a href="/meerkat/${a.slug}/">${a.title}</a></td>
        <td>${a.clientName}</td>
        <td>${a.date}</td>
        <td><a href="/meerkat/${a.slug}/" class="view-link">View &rarr;</a></td>
        <td class="translation-cell">${buildTranslationCell(a)}</td>
      </tr>`).join('');

  const emptyRow = `<tr><td colspan="5" class="empty">No articles yet — check back after the first article runs.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Meerkat — Generated Articles</title>
${SHARED_STYLES}
<style>
  body { max-width: 1100px; }
  .page-header { margin-bottom: 32px; }
  .page-header h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .page-header p { color: var(--muted-foreground); font-size: 14px; margin: 0; }
  .table-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  thead { background: var(--muted); }
  th { text-align: left; padding: 12px 16px; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted-foreground); border-bottom: 1px solid var(--border); }
  td { padding: 14px 16px; border-bottom: 1px solid var(--border); color: var(--foreground); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--muted); }
  .view-link { font-weight: 500; color: var(--primary); }
  .empty { color: var(--muted-foreground); font-style: italic; text-align: center; padding: 40px 16px; }
  .translation-cell { white-space: nowrap; }
  .lang-link { display: inline-block; font-size: 12px; font-weight: 500; color: var(--primary); background: #e8f7f0; border-radius: 6px; padding: 2px 8px; margin-right: 4px; text-decoration: none; }
  .lang-link:hover { background: #cdefdf; text-decoration: none; }
  .lang-pending { display: inline-block; font-size: 12px; color: var(--muted-foreground); background: var(--muted); border-radius: 6px; padding: 2px 8px; margin-right: 4px; }
  .translate-wrap { position: relative; display: inline-block; }
  .translate-btn { font-size: 12px; font-weight: 500; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; cursor: pointer; color: var(--foreground); }
  .translate-btn:hover { background: var(--muted); }
  .translate-btn:disabled { opacity: 0.5; cursor: default; }
  .lang-dropdown { display: none; position: absolute; top: calc(100% + 4px); left: 0; background: var(--card); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.1); z-index: 100; min-width: 150px; overflow: hidden; }
  .lang-dropdown.open { display: block; }
  .lang-dropdown button { display: block; width: 100%; text-align: left; padding: 9px 14px; font-size: 13px; font-weight: 500; background: none; border: none; cursor: pointer; color: var(--foreground); }
  .lang-dropdown button:hover { background: var(--muted); }
  .lang-dropdown button:not(:last-child) { border-bottom: 1px solid var(--border); }
  .lang-translating { display: inline-block; font-size: 12px; color: var(--muted-foreground); background: var(--muted); border-radius: 6px; padding: 2px 8px; margin-right: 4px; }
</style>
</head>
<body>
<div class="page-header">
  <h1>Meerkat — Generated Articles</h1>
  <p>${articles.length} article${articles.length !== 1 ? 's' : ''} generated</p>
</div>
<div class="table-card">
  <table>
    <thead>
      <tr>
        <th>Article</th>
        <th>Client</th>
        <th>Date</th>
        <th>View</th>
        <th>Translations</th>
      </tr>
    </thead>
    <tbody>${rows || emptyRow}
    </tbody>
  </table>
</div>
<script>
const API = '${apiUrl}';
const LANG_LABELS = { es: '🇪🇸 Español', vi: '🇻🇳 Tiếng Việt' };
const ALL_LANGS = ['es', 'vi'];

// Close any open dropdown when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.translate-wrap')) {
    document.querySelectorAll('.lang-dropdown.open').forEach(d => d.classList.remove('open'));
  }
});

function toggleDropdown(btn, articleId, slug) {
  const wrap = btn.closest('.translate-wrap');
  const dropdown = wrap.querySelector('.lang-dropdown');
  const cell = btn.closest('.translation-cell');

  // Always show all languages — allows re-translation
  dropdown.innerHTML = '';
  ALL_LANGS.forEach(lang => {
    const b = document.createElement('button');
    b.textContent = LANG_LABELS[lang];
    b.onclick = () => startTranslation(articleId, slug, lang, cell, wrap);
    dropdown.appendChild(b);
  });

  if (dropdown.children.length === 0) { wrap.remove(); return; }

  // Toggle open/close
  const isOpen = dropdown.classList.contains('open');
  document.querySelectorAll('.lang-dropdown.open').forEach(d => d.classList.remove('open'));
  if (!isOpen) dropdown.classList.add('open');
}

async function startTranslation(articleId, slug, lang, cell, wrap) {
  // Close dropdown
  wrap.querySelector('.lang-dropdown').classList.remove('open');

  // Remove existing link for this language if re-translating
  Array.from(cell.querySelectorAll('.lang-link')).forEach(el => {
    if (el.getAttribute('href').includes('/' + lang + '/')) el.remove();
  });

  // Show translating badge
  const badge = document.createElement('span');
  badge.className = 'lang-translating';
  badge.dataset.lang = lang;
  badge.textContent = LANG_LABELS[lang] + ' — translating…';
  cell.insertBefore(badge, wrap);

  try {
    const res = await fetch(API + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ articleId, language: lang })
    });
    if (!res.ok) throw new Error('Request failed');
    pollStatus(articleId, slug, lang, cell, badge);
  } catch(e) {
    badge.textContent = LANG_LABELS[lang] + ' — error, retry';
    badge.style.cursor = 'pointer';
    badge.onclick = () => { badge.remove(); };
  }
}

function pollStatus(articleId, slug, lang, cell, badge) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(API + '/translate/status?articleId=' + encodeURIComponent(articleId) + '&language=' + lang);
      const data = await res.json();
      if (data.status === 'complete') {
        clearInterval(interval);
        const link = document.createElement('a');
        link.href = '/meerkat/' + slug + '/' + lang + '/';
        link.className = 'lang-link';
        link.textContent = LANG_LABELS[lang];
        badge.replaceWith(link);
      }
    } catch(e) { /* keep polling */ }
  }, 5000);
}
</script>
</body>
</html>`;
}

async function publishArticle({ articleId, clientName, keyword, slug, htmlContent, fleschScore, wordCount, pageUrl, userId }) {
  if (!process.env.GITHUB_TOKEN) {
    console.log('[Publish] GITHUB_TOKEN not set — skipping publish');
    return null;
  }

  const date = new Date().toISOString().split('T')[0];
  const articlePath = `${BASE_PATH}/${slug}/index.html`;
  const manifestPath = `${BASE_PATH}/articles.json`;
  const indexPath = `${BASE_PATH}/index.html`;
  const styledHtml = buildArticleHtml({ clientName, keyword, articleId, fleschScore, wordCount, pageUrl, htmlContent });

  let count = 0;
  const committed = await commitFiles(`Add article: ${keyword} (${clientName})`, async (ref) => {
    // Remove existing entry for this articleId if regenerating — preserve translation status
    let articles = await getManifest(ref);
    const existing_entry = articles.find(a => a.articleId === articleId);
    articles = articles.filter(a => a.articleId !== articleId);
    articles.push({
      articleId,
      clientName,
      title: keyword,
      slug,
      date,
      userId: userId || '',
      pageUrl,
      translations: existing_entry?.translations || {},
    });
    count = articles.length;
    return {
      [articlePath]: styledHtml,
      [manifestPath]: JSON.stringify(articles, null, 2),
      [indexPath]: buildIndexHtml(articles),
    };
  });
  console.log(committed
    ? `[Publish] Pushed article + index (${count} articles): ${articlePath}`
    : `[Publish] No changes for ${articlePath} — nothing committed`);

  const articleUrl = `https://internal.goconstellation.com/meerkat/${slug}/`;
  console.log(`[Publish] Live at: ${articleUrl}`);
  return articleUrl;
}

/**
 * Publish a translated article page and update the manifest + index.
 */
async function publishTranslation({ articleId, language, config, slug, clientName, keyword, translatedTitle, translatedHtml }) {
  if (!process.env.GITHUB_TOKEN) {
    console.log('[Translate] GITHUB_TOKEN not set — skipping publish');
    return null;
  }

  const translatedPath = `${BASE_PATH}/${slug}/${language}/index.html`;
  const manifestPath = `${BASE_PATH}/articles.json`;
  const indexPath = `${BASE_PATH}/index.html`;

  const pageTitle = translatedTitle || `${clientName} — ${keyword} (${config.label})`;

  // Build the translated page HTML (same meta bar, translated content)
  const styledHtml = `<!DOCTYPE html>
<html lang="${config.htmlLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pageTitle}</title>
${SHARED_STYLES}
</head>
<body>
<div class="meta-bar">
  <h2>Meerkat &mdash; ${config.label} Translation</h2>
  <table>
    <tr><td>Client</td><td>${clientName}</td></tr>
    <tr><td>Keyword</td><td>${keyword}</td></tr>
    <tr><td>Article ID</td><td><span class="meta-badge">${articleId}</span></td></tr>
    <tr><td>Language</td><td><span class="meta-badge">${config.label}</span></td></tr>
    <tr><td>English</td><td><a href="/meerkat/${slug}/">View English version &rarr;</a></td></tr>
  </table>
</div>
${translatedHtml}
</body>
</html>`;

  const committed = await commitFiles(`Add translation: ${keyword} (${config.name})`, async (ref) => {
    const files = { [translatedPath]: styledHtml };
    // Articles that were never published in English aren't in the manifest;
    // their manifest and index would be unchanged, so leave them out.
    const articles = await getManifest(ref);
    const entry = articles.find(a => a.articleId === articleId);
    if (entry && entry.translations?.[language] !== 'complete') {
      entry.translations = { ...entry.translations, [language]: 'complete' };
      files[manifestPath] = JSON.stringify(articles, null, 2);
      files[indexPath] = buildIndexHtml(articles);
    }
    return files;
  });
  console.log(committed
    ? `[Translate] Pushed: ${translatedPath}`
    : `[Translate] No changes for ${translatedPath} — nothing committed`);
  return `https://internal.goconstellation.com/meerkat/${slug}/${language}/`;
}

/**
 * Fetch the current manifest and rebuild the index HTML in place.
 * Use to apply index UI changes to existing articles without regenerating them.
 */
async function rebuildIndex() {
  if (!process.env.GITHUB_TOKEN) {
    console.log('[RebuildIndex] GITHUB_TOKEN not set — skipping');
    return;
  }

  const indexPath = `${BASE_PATH}/index.html`;

  await commitFiles('Rebuild index: add Translate buttons', async (ref) => {
    const articles = await getManifest(ref);
    console.log(`[RebuildIndex] ${articles.length} articles in manifest`);
    return { [indexPath]: buildIndexHtml(articles) };
  });

  console.log('[RebuildIndex] Done — index updated');
}

module.exports = { publishArticle, publishTranslation, rebuildIndex };
