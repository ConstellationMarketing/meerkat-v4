---
name: Meerkat article fields must be wired through both authed and public paths
description: When adding a new field to article_outlines responses, update storage.ts AND get-article Netlify function AND PublicOpenArticleView mapping — missing any one silently drops the field in that view
type: feedback
---
When adding a new field to the article_outlines response (e.g. translations, new SEO metadata, version), it must be threaded through all three of these layers or it will silently disappear in one view:

1. `client/lib/storage.ts` — used by the **authenticated** DevViewPage/editor path (`getArticleOutlineById`, `getArticleOutlines`).
2. `netlify/functions/get-article.ts` — used by the **public share** path (`/share-article/:articleId`). Even though it does `SELECT *`, the response object is hand-shaped, so new fields must be explicitly added.
3. `client/pages/PublicOpenArticleView.tsx` — re-maps the API response into `ArticleOutline` before passing to `DevViewPageContent`. Also hand-shaped, also silently drops unknown fields.

**Why:** The April 2026 translation feature shipped with only (1) updated. Lindsay reported translations weren't appearing in the public share view; root cause was (2) and (3) dropping the `translations` column. Fix shipped in PR #17 on 2026-04-17.

**How to apply:** Before declaring any new article-response field "done," grep for the field name across all three files. If it's only in storage.ts, the public share view will silently fail in the same way.
