---
name: Meerkat translation workflow and Lindsay context
type: project
description: Web team translation workflow, Lindsay as stakeholder, open decisions flagged to her on 2026-04-16
---
**Lindsay is the web team stakeholder** who coordinates the editor-to-web handoff on Meerkat. Feedback from her about translation/SEO/workflow carries the web team's voice.

**Workflow as of 2026-04-16:** editor finishes an article → shares the `/share-article/:articleId` URL (the "public view") with the web team → web team toggles the Translate button on that URL → copies slug, title tag, meta description, and body content into their CMS. The translation feature's job is to produce all four fields at once and make them individually copy-able.

**Open decisions flagged to Lindsay in the 2026-04-16 handoff message, awaiting her response:**

1. **Should the Translate button be removed from the editor view?** I left it on both editor and public. Her note ("available from the public view, not the editor view") could be read literally. If she confirms literal reading, remove from editor.
2. **Trigger auth:** currently anyone with the `/share-article/:articleId` URL can trigger a translation (shared-secret trust model, no auth). She hasn't raised concerns but this is worth confirming if abuse surfaces.
3. **Slug translation form:** I went with URL-safe ASCII (lowercase, hyphens, no accents). Based on her listing slug among copy-able elements.
4. **No backfill policy:** old translations (body-only) show English for title/meta/slug until re-translated. Re-translate to refresh.

**Why:** These decisions shape the translation feature's scope and UX. Future changes to Meerkat translation should check whether Lindsay has weighed in before adjusting.

**How to apply:** When Lindsay sends new translation/workflow feedback, check this memory for prior decisions and whether they're now settled. When touching `TranslationControls` or `DevViewPageContent.tsx` SEO/metadata panels, keep the per-field fallback to English intact — it's load-bearing for older translations.

**2026-04-17 follow-up bug fix (PR #17):** Lindsay reported translations completed but produced no visible change in public share view. Root cause: translation data was reaching Supabase but the `/share-article/:articleId` path (`PublicOpenArticleView` → `get-article` Netlify function) was silently dropping the `translations` column at two layers of hand-shaped object mapping. The authed DevViewPage path worked because it goes through `storage.ts`, which already maps translations. Fixed by adding `translations: data.translations` to `netlify/functions/get-article.ts` response and `translations: data.article.translations` to `PublicOpenArticleView.tsx` outline mapping. Eli replied to Lindsay's thread same day. See feedback memory `feedback_meerkat_article_fields_two_paths.md` for the general lesson.
