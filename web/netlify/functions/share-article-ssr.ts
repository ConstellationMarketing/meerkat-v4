/**
 * Server-rendered public article view.
 *
 * Routed to from netlify.toml:
 *   /share-article/:articleId          -> English (no lang segment)
 *   /share-article/:articleId/:lang    -> :lang in {es, vi}
 *
 * Returns a complete standalone HTML page with the translated article baked
 * into the response - provable with `curl` on the URL, which is the explicit
 * requirement from the language-URL task (so that downstream consumers like
 * the Divi publish automation, social previews, and search crawlers see the
 * correct language without running JavaScript).
 *
 * The React app (PublicOpenArticleView.tsx) still exists for local dev (Vite
 * doesn't honor netlify.toml redirects). In production this function wins
 * because the redirect uses force = true + status 200.
 *
 * Data model:
 *   meerkat.article_outlines.received_article (JSONB) -> English source
 *     .content (HTML), .title, .meta
 *   meerkat.article_outlines.translations (JSONB)     -> per-lang
 *     [lang]: { status, content, title, meta, slug, translated_at }
 *
 * Fallback behavior:
 *   - lang requested but no translation yet -> render English with a notice
 *   - article missing -> 404
 *   - unsupported lang -> 404 (NOT a silent fallback - better signal)
 */

import { createClient } from "@supabase/supabase-js";

type Lang = "en" | "es" | "vi";

const LANG_CONFIG: Record<Lang, { label: string; htmlLang: string }> = {
  en: { label: "English", htmlLang: "en" },
  es: { label: "Español", htmlLang: "es" },
  vi: { label: "Tiếng Việt", htmlLang: "vi" },
};

const SUPPORTED_LANGS: Lang[] = ["en", "es", "vi"];

function createSupabaseClient() {
  const supabaseUrl =
    process.env.VITE_SUPABASE_URL || "https://cwligyakhxevopxiksdm.supabase.co";
  const supabaseKey =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    "";
  return createClient(supabaseUrl, supabaseKey, { db: { schema: "meerkat" } });
}

function escapeHtml(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: unknown): string {
  return escapeHtml(s);
}

/**
 * received_article may be stored as a JSON object OR as a JSON-encoded string
 * (legacy rows). Normalize both shapes to { content, title, meta }.
 */
function parseReceived(raw: unknown): {
  content: string;
  title: string;
  meta: string;
} {
  let obj: any = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { content: raw, title: "", meta: "" };
    }
  }
  if (!obj || typeof obj !== "object") {
    return { content: "", title: "", meta: "" };
  }
  return {
    content: typeof obj.content === "string" ? obj.content : "",
    title: typeof obj.title === "string" ? obj.title : "",
    meta: typeof obj.meta === "string" ? obj.meta : "",
  };
}

function pathFor(articleId: string, lang: Lang): string {
  return lang === "en"
    ? `/share-article/${encodeURIComponent(articleId)}`
    : `/share-article/${encodeURIComponent(articleId)}/${lang}`;
}

function renderTranslationsBar(
  articleId: string,
  active: Lang,
  available: Set<Lang>,
): string {
  return SUPPORTED_LANGS.map((lang) => {
    const has = lang === "en" || available.has(lang);
    const cfg = LANG_CONFIG[lang];
    if (!has && lang !== active) return "";
    const isActive = lang === active;
    const href = pathFor(articleId, lang);
    return `<a
      href="${escapeAttr(href)}"
      class="lang-pill${isActive ? " lang-pill--active" : ""}"
      ${isActive ? 'aria-current="page"' : ""}
    >${escapeHtml(cfg.label)}</a>`;
  }).join("\n");
}

function renderField(label: string, value: string): string {
  if (!value) return "";
  return `<div class="field"><div class="field-label">${escapeHtml(
    label,
  )}</div><div class="field-value">${escapeHtml(value)}</div></div>`;
}

function copyBtn(target: string): string {
  return `<button type="button" class="copy-btn" data-target="${target}" onclick="copySection(this)"><span>Copy</span></button>`;
}

function renderInfoPanels(opts: {
  keyword: string;
  clientName: string;
  pageUrl: string;
  urlSlug: string;
  contentType: string;
  wordCount: string;
  version: string;
  title: string;
  meta: string;
  schema: string;
}): string {
  const fields = [
    renderField("Keyword", opts.keyword),
    renderField("Client Name", opts.clientName),
    renderField("Page URL", opts.pageUrl),
    renderField("URL Slug", opts.urlSlug),
    renderField("Content Type", opts.contentType),
    renderField("Word Count", opts.wordCount),
    renderField("Version", opts.version),
  ].join("");

  const metadataPanel = fields
    ? `<section class="info-panel"><div class="panel-head"><h2>Metadata</h2>${copyBtn(
        "copy-metadata",
      )}</div><div id="copy-metadata" class="panel-body"><div class="field-grid">${fields}</div></div></section>`
    : "";

  const seoBody =
    (opts.title
      ? `<div class="seo-row"><div class="field-label">Title Tag <span class="count">${opts.title.length} chars</span></div><div class="field-value">${escapeHtml(
          opts.title,
        )}</div></div>`
      : "") +
    (opts.meta
      ? `<div class="seo-row"><div class="field-label">Meta Description <span class="count">${opts.meta.length} chars</span></div><div class="field-value">${escapeHtml(
          opts.meta,
        )}</div></div>`
      : "");

  const seoPanel =
    opts.title || opts.meta
      ? `<section class="info-panel"><div class="panel-head"><h2>SEO Information</h2>${copyBtn(
          "copy-seo",
        )}</div><div id="copy-seo" class="panel-body">${seoBody}</div></section>`
      : "";

  const schemaPanel = opts.schema
    ? `<section class="info-panel"><div class="panel-head"><h2>Schema</h2>${copyBtn(
        "copy-schema",
      )}</div><div id="copy-schema" class="panel-body"><pre class="schema">${escapeHtml(
        opts.schema,
      )}</pre></div></section>`
    : "";

  return metadataPanel + seoPanel + schemaPanel;
}

function renderPage(opts: {
  articleId: string;
  lang: Lang;
  title: string;
  meta: string;
  content: string;
  available: Set<Lang>;
  fallbackNotice: string | null;
  keyword: string;
  clientName: string;
  pageUrl: string;
  urlSlug: string;
  contentType: string;
  wordCount: string;
  version: string;
  schema: string;
}): string {
  const cfg = LANG_CONFIG[opts.lang];
  const canonical = pathFor(opts.articleId, opts.lang);

  const hreflangs = SUPPORTED_LANGS.filter(
    (l) => l === "en" || opts.available.has(l),
  )
    .map(
      (l) =>
        `<link rel="alternate" hreflang="${LANG_CONFIG[l].htmlLang}" href="${escapeAttr(
          pathFor(opts.articleId, l),
        )}">`,
    )
    .join("\n  ");

  return `<!DOCTYPE html>
<html lang="${escapeAttr(cfg.htmlLang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  ${opts.meta ? `<meta name="description" content="${escapeAttr(opts.meta)}">` : ""}
  ${opts.meta ? `<meta property="og:description" content="${escapeAttr(opts.meta)}">` : ""}
  <meta property="og:title" content="${escapeAttr(opts.title)}">
  <meta property="og:locale" content="${escapeAttr(cfg.htmlLang)}">
  <link rel="canonical" href="${escapeAttr(canonical)}">
  ${hreflangs}
  <style>
    :root {
      --fg: #1a1a1a;
      --muted: #6b7280;
      --border: #e5e7eb;
      --accent: #2563eb;
      --notice-bg: #fff7ed;
      --notice-border: #fed7aa;
      --pill-bg: #f3f4f6;
      --pill-fg: #4b5563;
      --pill-active-bg: #2563eb;
      --pill-active-fg: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--fg);
      line-height: 1.6;
      background: #fff;
    }
    .container { max-width: 760px; margin: 0 auto; padding: 24px 20px 80px; }
    header {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      padding: 8px 0 16px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .lang-pill {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 9999px;
      background: var(--pill-bg);
      color: var(--pill-fg);
      font-size: 13px;
      font-weight: 500;
      text-decoration: none;
      transition: background 0.15s, color 0.15s;
    }
    .lang-pill:hover { background: #e5e7eb; }
    .lang-pill--active {
      background: var(--pill-active-bg);
      color: var(--pill-active-fg);
    }
    .lang-pill--active:hover { background: var(--pill-active-bg); }
    h1 {
      font-size: 32px;
      line-height: 1.25;
      margin: 0 0 16px;
      font-weight: 700;
    }
    article :is(h2, h3, h4) { line-height: 1.3; margin: 32px 0 12px; }
    article h2 { font-size: 24px; }
    article h3 { font-size: 19px; }
    article p { margin: 0 0 16px; }
    article ul, article ol { margin: 0 0 16px 1.5em; }
    article li { margin-bottom: 6px; }
    article a { color: var(--accent); }
    article img { max-width: 100%; height: auto; }
    article table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    article th, article td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
    .notice {
      background: var(--notice-bg);
      border: 1px solid var(--notice-border);
      border-radius: 6px;
      padding: 12px 16px;
      margin: 0 0 24px;
      font-size: 14px;
      color: #92400e;
    }
    footer {
      margin-top: 64px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
    footer a { color: var(--muted); }
    .info-panel { border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; margin: 0 0 16px; background: #fafafa; }
    .info-panel h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0; }
    .panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
    .full-article-head { margin: 24px 0 12px; }
    .copy-btn {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      padding: 4px 12px;
      border-radius: 9999px;
      border: 1px solid var(--border);
      background: #fff;
      color: var(--pill-fg);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .copy-btn:hover { background: var(--pill-bg); }
    .copy-btn.copied { background: #ecfdf5; border-color: #6ee7b7; color: #047857; }
    .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px 24px; }
    .field-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; color: var(--muted); margin-bottom: 2px; }
    .field-value { font-size: 14px; color: var(--fg); word-break: break-word; }
    .seo-row { margin-bottom: 12px; }
    .seo-row:last-child { margin-bottom: 0; }
    .count { text-transform: none; letter-spacing: 0; color: var(--accent); font-weight: 500; margin-left: 6px; }
    pre.schema { background: #f3f4f6; border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto; font-size: 12px; line-height: 1.5; margin: 0; white-space: pre-wrap; word-break: break-word; }
    .full-article-label { font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      ${renderTranslationsBar(opts.articleId, opts.lang, opts.available)}
    </header>
    ${opts.fallbackNotice ? `<div class="notice">${escapeHtml(opts.fallbackNotice)}</div>` : ""}
    ${renderInfoPanels(opts)}
    <div class="panel-head full-article-head"><div class="full-article-label">Full Article</div>${copyBtn(
      "copy-article",
    )}</div>
    <article id="copy-article">
      <h1>${escapeHtml(opts.title)}</h1>
      ${opts.content /* trusted HTML from the editor pipeline */}
    </article>
    <footer>
      <span>Powered by Meerkat</span>
      <a href="/edit/${escapeAttr(opts.articleId)}">Open in editor</a>
    </footer>
  </div>
  <script>
    function copySection(btn) {
      var id = btn.getAttribute('data-target');
      var el = id ? document.getElementById(id) : null;
      var text = el ? (el.innerText || el.textContent || '') : '';
      var span = btn.querySelector('span');
      var orig = span ? span.textContent : 'Copy';
      function done() {
        if (span) span.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(function () {
          if (span) span.textContent = orig;
          btn.classList.remove('copied');
        }, 1500);
      }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
        done();
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else {
        fallback();
      }
    }
  </script>
</body>
</html>`;
}

function readLangFromEvent(event: any): Lang | "invalid" {
  const qs = event.queryStringParameters || {};
  const rawLang =
    qs.lang ||
    event.path?.match(/\/share-article\/[^/]+\/([^/?#]+)$/)?.[1];

  if (!rawLang) return "en";
  const lang = String(rawLang).toLowerCase();
  if (SUPPORTED_LANGS.includes(lang as Lang)) return lang as Lang;
  return "invalid";
}

function readArticleIdFromEvent(event: any): string | null {
  const qs = event.queryStringParameters || {};
  if (qs.id) return String(qs.id);
  const m = event.path?.match(/\/share-article\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export const handler = async (event: any) => {
  const articleId = readArticleIdFromEvent(event);
  if (!articleId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Missing article id",
    };
  }

  const lang = readLangFromEvent(event);
  if (lang === "invalid") {
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Unsupported language",
    };
  }

  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from("article_outlines")
    .select("*")
    .eq("article_id", articleId)
    .maybeSingle();

  if (error) {
    console.error("[share-article-ssr] supabase error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Failed to load article",
    };
  }

  if (!data) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "Article not found",
    };
  }

  const translations = (data as any).translations || {};
  const available = new Set<Lang>();
  for (const code of ["es", "vi"] as const) {
    if (translations?.[code]?.status === "complete" && translations[code]?.content) {
      available.add(code);
    }
  }

  const englishReceived = parseReceived((data as any).received_article);
  const englishTitle =
    englishReceived.title ||
    (data as any).title_tag ||
    (data as any).seo_title ||
    (data as any).keyword ||
    "Article";
  const englishMeta =
    englishReceived.meta ||
    (data as any).meta_description ||
    (data as any).seo_meta_description ||
    "";
  const englishContent =
    englishReceived.content ||
    (data as any)["cleaned content"] ||
    (data as any).html_content ||
    "";

  let title = englishTitle;
  let meta = englishMeta;
  let content = englishContent;
  let fallbackNotice: string | null = null;

  if (lang !== "en") {
    const t = translations?.[lang];
    if (t && t.status === "complete" && t.content) {
      title = t.title || englishTitle;
      meta = t.meta || englishMeta;
      content = t.content;
    } else {
      fallbackNotice = `${LANG_CONFIG[lang].label} translation is not available yet - showing the English version.`;
    }
  }

  const tForSlug = lang !== "en" ? (translations as any)?.[lang] : null;
  const urlSlug =
    (tForSlug && tForSlug.slug) || (data as any)["URL Slug"] || "";

  let schemaStr = "";
  const rawSchema = (data as any).schema ?? (data as any)["Schema"];
  if (rawSchema != null && rawSchema !== "") {
    try {
      schemaStr = JSON.stringify(
        typeof rawSchema === "string" ? JSON.parse(rawSchema) : rawSchema,
        null,
        2,
      );
    } catch {
      schemaStr = String(rawSchema);
    }
  }

  const html = renderPage({
    articleId,
    lang,
    title,
    meta,
    content,
    available,
    fallbackNotice,
    keyword: (data as any).keyword || "",
    clientName: (data as any).client_name || "",
    pageUrl: (data as any)["Page URL"] || "",
    urlSlug,
    contentType: (data as any).template || "",
    wordCount:
      (data as any)["word count"] != null
        ? String((data as any)["word count"])
        : "",
    version: (data as any).version || "",
    schema: schemaStr,
  });

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=120, stale-while-revalidate=600",
      Vary: "Accept-Language",
    },
    body: html,
  };
};
