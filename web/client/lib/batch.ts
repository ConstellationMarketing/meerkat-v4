/**
 * Batch generation API client — calls V4 backend batch endpoints, plus
 * helpers that query Supabase directly for the batch list / article list
 * (read-only, same pattern as Settings.tsx querying templates).
 */

import { supabase } from "@/lib/supabase";

const BATCH_API_URL =
  import.meta.env.VITE_TRANSLATE_API_URL || "https://meerkat-api.goconstellation.com";

export interface BatchArticle {
  keyword: string;
  clientName: string;
  template?: string;
}

export interface BatchStartResponse {
  status: string;
  batchId: string;
  totalArticles: number;
  message: string;
}

export interface BatchStatus {
  id: string;
  batch_id: string;
  created_by: string | null;
  created_at: string;
  status: "pending" | "queued" | "processing" | "completed" | "failed" | "cancelled" | "orphaned";
  total_articles: number;
  completed_count: number;
  failed_count: number;
  current_keyword: string | null;
  csv_data: BatchArticle[] | null;
  errors: BatchError[];
}

export interface BatchError {
  articleId: string;
  keyword: string;
  clientName: string;
  error: string;
  timestamp: string;
}

/** Start a batch generation run */
export async function startBatch(
  articles: BatchArticle[],
  userId: string | null,
): Promise<BatchStartResponse> {
  const res = await fetch(`${BATCH_API_URL}/batch/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articles, userId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Batch start failed: ${res.status}`);
  }

  return res.json();
}

/** Poll batch status */
export async function getBatchStatus(
  batchId: string,
): Promise<BatchStatus> {
  const res = await fetch(
    `${BATCH_API_URL}/batch/status?batchId=${encodeURIComponent(batchId)}`,
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Status check failed: ${res.status}`);
  }

  return res.json();
}

/** Cancel a running batch */
export async function cancelBatch(batchId: string): Promise<void> {
  const res = await fetch(`${BATCH_API_URL}/batch/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Cancel failed: ${res.status}`);
  }
}

/**
 * Retry failed articles from a batch.
 *
 * @param batchId
 * @param articleKeywords  Optional subset of failed keywords to retry. If
 *                         omitted, every failed article in the batch is
 *                         retried (backend default).
 */
export async function retryBatch(
  batchId: string,
  articleKeywords?: string[],
): Promise<void> {
  const body: { batchId: string; articleKeywords?: string[] } = { batchId };
  if (articleKeywords && articleKeywords.length > 0) {
    body.articleKeywords = articleKeywords;
  }

  const res = await fetch(`${BATCH_API_URL}/batch/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Retry failed: ${res.status}`);
  }
}

/**
 * List all batches, most recent first. Reads directly from Supabase. Used by
 * the BatchGenerateTab list view (the canonical home for batch management).
 */
export async function listBatches(): Promise<BatchStatus[]> {
  const { data, error } = await supabase
    .from("batch_jobs")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list batches: ${error.message}`);
  return (data || []) as BatchStatus[];
}

export interface BatchTemplate {
  id: string;
  name: string;
  sections: unknown[];
}

/**
 * List all templates for client-side validation. Same query the backend
 * runs for fuzzy resolution — returns id, name, and sections so the
 * upload validation table can show "X resolves to <id>" before the user
 * commits.
 */
export async function listTemplates(): Promise<BatchTemplate[]> {
  const { data, error } = await supabase
    .from("templates")
    .select("id, name, sections");
  if (error) throw new Error(`Failed to list templates: ${error.message}`);
  return (data || []) as BatchTemplate[];
}

const normalizeTemplateAlias = (s: string | null | undefined): string =>
  (s || "")
    .toString()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Build an alias → canonical-id lookup. Mirrors the backend resolution in
 * meerkatv4 server.js so the frontend validation table shows the same
 * resolved template the backend will use.
 */
export function buildTemplateAliasMap(
  templates: BatchTemplate[],
): Record<string, string> {
  const m: Record<string, string> = {};
  for (const t of templates) {
    if (!t.id) continue;
    [t.id, t.name].forEach((alias) => {
      const k = normalizeTemplateAlias(alias);
      if (k) m[k] = t.id;
    });
  }
  return m;
}

export function resolveTemplateAlias(
  input: string | null | undefined,
  aliasMap: Record<string, string>,
): string | null {
  const candidate = input && input.trim() ? input : "practice-page";
  return aliasMap[normalizeTemplateAlias(candidate)] || null;
}

const normalizeClientAlias = (s: string | null | undefined): string =>
  (s || "")
    .toString()
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Build an alias → canonical client-name lookup. Mirrors the backend
 * resolution in meerkatv4 server.js so the validation table shows the same
 * resolved client the backend will use. Punctuation differences ("Robert R
 * Hopkins" vs "Robert R. Hopkins") collapse to the same key.
 */
export function buildClientAliasMap(
  folders: { name: string }[],
): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of folders) {
    const k = normalizeClientAlias(f.name);
    if (k) m[k] = f.name;
  }
  return m;
}

export function resolveClientAlias(
  input: string | null | undefined,
  aliasMap: Record<string, string>,
): string | null {
  return aliasMap[normalizeClientAlias(input)] || null;
}

export interface BatchArticleRow {
  article_id: string;
  keyword: string;
  client_name: string | null;
  template: string | null;
  word_count: number | null;
  created_at: string;
}

/**
 * List articles for a given batch with pagination. The batch list view
 * expands a row to show its articles inline; for batches with hundreds of
 * articles we paginate (default 25 per page). Returns the page plus the
 * total count so the UI can show "X of Y" and a Load More button.
 */
export async function listArticlesForBatch(
  batchId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ articles: BatchArticleRow[]; total: number }> {
  const limit = opts.limit ?? 25;
  const offset = opts.offset ?? 0;
  const { data, error, count } = await supabase
    .from("article_outlines")
    .select(
      'article_id, keyword, client_name, template, "word count", created_at',
      { count: "exact" },
    )
    .eq("batch_id", batchId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`Failed to list articles for batch: ${error.message}`);
  return {
    articles: (data || []).map((r: any) => ({
      article_id: r.article_id,
      keyword: r.keyword,
      client_name: r.client_name,
      template: r.template,
      word_count: r["word count"],
      created_at: r.created_at,
    })),
    total: count || 0,
  };
}

/** Parse CSV text into BatchArticle array */
export function parseCSV(text: string): {
  articles: BatchArticle[];
  errors: string[];
} {
  const lines = text.trim().split("\n");
  if (lines.length < 2) {
    return { articles: [], errors: ["CSV must have a header row and at least one data row"] };
  }

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const keywordIdx = headers.indexOf("keyword");
  const clientIdx = headers.indexOf("clientname");
  const templateIdx = headers.indexOf("template");

  const errors: string[] = [];
  if (keywordIdx === -1) errors.push('Missing required column: "keyword"');
  if (clientIdx === -1) errors.push('Missing required column: "clientName"');
  if (errors.length > 0) return { articles: [], errors };

  const articles: BatchArticle[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle quoted CSV fields. Supports the standard `""` escape inside a
    // quoted field (e.g. `"He said ""hi"""` decodes to `He said "hi"`). Without
    // this, a keyword containing a quote character splits or terminates early.
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        if (inQuotes && line[j + 1] === '"') {
          // Escaped quote inside a quoted field — emit a literal `"` and skip
          // the second one.
          current += '"';
          j++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
        fields.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    fields.push(current.trim());

    const keyword = fields[keywordIdx] || "";
    const clientName = fields[clientIdx] || "";
    const template = templateIdx >= 0 ? fields[templateIdx] || "practice-page" : "practice-page";

    if (!keyword) {
      errors.push(`Row ${i + 1}: missing keyword`);
      continue;
    }
    if (!clientName) {
      errors.push(`Row ${i + 1}: missing clientName`);
      continue;
    }

    articles.push({ keyword, clientName, template });
  }

  return { articles, errors };
}
