import { ArticleOutline } from "@/types/article";
import { OutlineTemplate } from "@/lib/templates";
import { supabase } from "@/lib/supabase";
import type { ArticleOutline, ArticleSection } from "@/types/article";

const STORAGE_KEY = "article_outlines";
const TEMPLATES_STORAGE_KEY = "outline_templates";

// Helper functions for extracting title and meta description from content
function extractTextFromHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractFirstTwoParagraphsAndClean(html: string): {
  first: string;
  second: string;
  cleanedHtml: string;
} {
  if (!html) return { first: "", second: "", cleanedHtml: "" };

  const paragraphRegex = /<(?:p|h[1-6])[^>]*>([\s\S]*?)<\/(?:p|h[1-6])>/gi;
  const matches = [];
  const matchInfo = [];
  let match;

  while ((match = paragraphRegex.exec(html)) !== null) {
    const text = extractTextFromHtml(match[1]).trim();
    if (text) {
      matches.push(text);
      matchInfo.push({
        start: match.index,
        end: match.index + match[0].length,
      });
      if (matches.length === 2) break;
    }
  }

  let cleanedHtml = html;
  if (matchInfo.length === 2) {
    cleanedHtml =
      html.substring(0, matchInfo[0].start) + html.substring(matchInfo[1].end);
  } else if (matchInfo.length === 1) {
    cleanedHtml =
      html.substring(0, matchInfo[0].start) + html.substring(matchInfo[0].end);
  }

  return {
    first: matches[0] || "",
    second: matches[1] || "",
    cleanedHtml: cleanedHtml.trim(),
  };
}

// Fallback to localStorage if Supabase is not available
let useSupabase = true;

async function checkSupabaseConnection() {
  try {
    const { error } = await supabase
      .from("article_outlines")
      .select("count", { count: "exact" });
    if (error) {
      console.warn("Supabase article_outlines table error:", error);
      useSupabase = false;
    } else {
      const wasDisabled = !useSupabase;
      console.log("✓ Supabase connection successful");
      useSupabase = true;

      // If Supabase was disabled before, sync localStorage data
      if (wasDisabled) {
        console.log("🔄 Supabase reconnected! Syncing localStorage changes...");
        await syncLocalStorageToSupabase();
      }
    }
  } catch (error) {
    console.warn(
      "Supabase not available, falling back to localStorage:",
      error,
    );
    useSupabase = false;
  }
}

// Track if initial connection check is complete
let connectionCheckPromise = checkSupabaseConnection();

// Export function to check if Supabase is ready
export function isSupabaseAvailable(): boolean {
  return useSupabase;
}

// Export promise that resolves when connection check completes
export function waitForConnectionCheck(): Promise<void> {
  return connectionCheckPromise;
}

// Sync localStorage articles to Supabase when connection is restored
async function syncLocalStorageToSupabase() {
  try {
    const localArticles = getArticleOutlinesLocal();
    if (localArticles.length === 0) {
      console.log("ℹ️ No localStorage articles to sync");
      return;
    }

    console.log(
      `🔄 Syncing ${localArticles.length} articles from localStorage to Supabase...`,
    );

    for (const article of localArticles) {
      // Exclude sections from sync — the V4 pipeline manages the sections
      // column with webhook-format data (name/details/wordCount). localStorage
      // has frontend-format sections that would overwrite the pipeline data.
      const outlineData = {
        id: article.id,
        article_id: article.articleId,
        client_name: article.clientName,
        client_id: article.clientId,
        keyword: article.keyword,
        updated_at: new Date().toISOString(),
        webhook_sent: article.webhookSent || false,
        received_article: article.receivedArticle || null,
        user_id: article.userId || null,
        page_update_type: article["page-update-type"] || null,
        page_url: article["page-url"] || null,
      };

      // Check if article already exists in Supabase
      const { data: existing, error: checkError } = await supabase
        .from("article_outlines")
        .select("id, updated_at")
        .eq("id", article.id);

      if (checkError) {
        console.error(`❌ Error checking article ${article.keyword}:`, checkError);
        continue;
      }

      if (!existing || existing.length === 0) {
        // Do not insert from frontend/local sync. n8n workflow owns creation.
        console.log(
          `⏭️ Skipping insert for '${article.keyword}' (creation handled by n8n)`,
        );
      } else {
        // Article exists - UPDATE it with localStorage version
        const { error: updateError } = await supabase
          .from("article_outlines")
          .update(outlineData)
          .eq("id", article.id);

        if (updateError) {
          console.error(
            `❌ Error syncing '${article.keyword}' to Supabase:`,
            updateError,
          );
        } else {
          console.log(`✅ Successfully synced '${article.keyword}' to Supabase`);
        }
      }
    }

    console.log("✓ Article sync from localStorage to Supabase complete");
  } catch (error) {
    console.error("Error syncing articles to Supabase:", error);
  }
}

// Retry connection check every 10 seconds if it failed
let retryInterval: NodeJS.Timeout | null = null;
function startConnectionRetry() {
  if (useSupabase) return; // Already connected
  if (retryInterval) return; // Already retrying

  console.log("Starting Supabase connection retry...");
  retryInterval = setInterval(async () => {
    await checkSupabaseConnection();
    if (useSupabase && retryInterval) {
      clearInterval(retryInterval);
      retryInterval = null;
      console.log("✓ Supabase reconnected, resuming normal operation");
      // Sync any articles that were saved to localStorage
      await syncLocalStorageToSupabase();
    }
  }, 10000);
}

// Start retry if initial connection failed
setTimeout(() => {
  if (!useSupabase) {
    startConnectionRetry();
  }
}, 1000);

// Columns fetched by article LIST queries. Deliberately excludes the heavy
// columns the list views never display: `translations` (full ES + VI HTML per
// article since the July 2026 backfill) and `cleaned content` (immutable
// pipeline draft). Fetching them via select("*") made list responses balloon
// to hundreds of MB and time out, leaving the sidebar empty. Views that need
// translations or original content re-fetch a single article by id.
const ARTICLE_LIST_COLUMNS = [
  "id",
  "article_id",
  "client_name",
  "client_id",
  "keyword",
  "template",
  "sections",
  "created_at",
  "updated_at",
  "webhook_sent",
  "received_article",
  "schema",
  '"word count"',
  '"flesch score"',
  '"Page URL"',
  '"URL Slug"',
  "user_id",
  "version",
  "title_tag",
  "meta_description",
  "page_update_type",
  "page_url",
].join(", ");

export async function getArticleOutlines(options?: {
  userId?: string;
  userRole?: "admin" | "member";
}): Promise<ArticleOutline[]> {
  console.log(
    "Getting article outlines, useSupabase:",
    useSupabase,
    "userId:",
    options?.userId,
    "role:",
    options?.userRole,
  );

  if (!useSupabase) {
    console.log("Fetching from localStorage");
    return filterArticlesByRole(
      getArticleOutlinesLocal(),
      options?.userId,
      options?.userRole,
    );
  }

  try {
    let data: any[] | null = null;
    let error: any = null;

    // Try to fetch from the articles API endpoint first (uses service role, bypasses RLS)
    try {
      console.log("📡 Fetching articles from /api/articles (service role)...");
      const response = await fetch("/api/articles");
      if (response.ok) {
        data = await response.json();
        console.log("✅ Successfully fetched articles from /api/articles");
      } else {
        console.warn(
          "⚠️ /api/articles returned non-200 status, falling back to direct Supabase",
        );
        const { data: sbData, error: sbError } = await supabase
          .from("article_outlines")
          .select(ARTICLE_LIST_COLUMNS)
          .order("created_at", { ascending: false });
        data = sbData;
        error = sbError;
      }
    } catch (apiError) {
      console.warn(
        "⚠️ /api/articles fetch failed, falling back to direct Supabase:",
        apiError,
      );
      const { data: sbData, error: sbError } = await supabase
        .from("article_outlines")
        .select(ARTICLE_LIST_COLUMNS)
        .order("created_at", { ascending: false });
      data = sbData;
      error = sbError;
    }

    if (error) {
      const errorMsg =
        error instanceof Error
          ? error.message
          : error?.message || JSON.stringify(error);
      console.debug("Supabase fetch error:", errorMsg);
      throw error;
    }

    const normalizeSections = (sections: any[]): ArticleSection[] => {
      if (!Array.isArray(sections)) return [];
      return sections.map((s: any) => ({
        id: s.id || generateId(),
        title: s.title ?? s.Name ?? "",
        description: s.description ?? s.Purpose ?? "",
        content: s.content ?? s.Details ?? "",
      }));
    };

    const findHtmlString = (val: any, depth = 0): string | null => {
      if (!val || depth > 3) return null;
      if (typeof val === "string") {
        if (val.includes("<") && val.length > 20) return val;
        return null;
      }
      if (Array.isArray(val)) {
        for (const v of val) {
          const found = findHtmlString(v, depth + 1);
          if (found) return found;
        }
        return null;
      }
      if (typeof val === "object") {
        for (const k of Object.keys(val)) {
          const found = findHtmlString(val[k], depth + 1);
          if (found) return found;
        }
      }
      return null;
    };

    const normalizeReceived = (raw: any, updatedAt?: string) => {
      if (raw == null) return null;
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          raw = parsed;
        } catch {
          return {
            content: raw,
            title: null,
            meta: null,
            receivedAt: updatedAt || null,
          };
        }
      }
      if (typeof raw !== "object") return null;

      const contentCandidate =
        (raw as any).content ??
        (raw as any).htmlContent ??
        (raw as any).html ??
        findHtmlString(raw);

      return {
        content: typeof contentCandidate === "string" ? contentCandidate : "",
        // Preserved from /api/articles list rows, where the heavy content
        // string is stripped server-side and replaced by this flag.
        hasContent: Boolean((raw as any).hasContent),
        title:
          (raw as any).title ??
          (raw as any).seoTitle ??
          (raw as any).seo_title ??
          null,
        meta:
          (raw as any).meta ??
          (raw as any).seoMetaDescription ??
          (raw as any).seo_meta_description ??
          null,
        receivedAt:
          (raw as any).receivedAt ??
          (raw as any).timestamp ??
          (raw as any).received_at ??
          updatedAt ??
          null,
      };
    };

    const mapped = (data || []).map((row: any, idx: number) => {
      const receivedArticle = normalizeReceived(
        row.received_article,
        row.updated_at,
      );

      const outline = {
        id: row.id,
        articleId: row.article_id,
        clientName: row.client_name,
        clientId: row.client_id,
        keyword: row.keyword,
        template: row.template || undefined,
        sections: normalizeSections(row.sections),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        webhookSent: row.webhook_sent,
        receivedArticle: receivedArticle,
        schema: row.schema || undefined,
        "word count": row["word count"] || undefined,
        "flesch score": row["flesch score"] || undefined,
        "Page URL": row["Page URL"] || undefined,
        "URL Slug": row["URL Slug"] || undefined,
        userId: row.user_id || undefined,
        version: row.version || undefined,
        titleTag: row.title_tag || undefined,
        translations: row.translations || undefined,
      } as ArticleOutline;

      console.log(
        `   [MAP ${idx}] ID: ${row.id}, Keyword: "${row.keyword}", Client: "${row.client_name}", userId (raw): "${row.user_id}", userId (mapped): "${outline.userId}"`,
      );

      return outline;
    });

    // Dedupe by articleId: keep the one with content, otherwise the most recently updated
    const uniqueByArticleId = new Map<string, ArticleOutline>();
    for (const a of mapped) {
      const key = a.articleId || a.id; // fallback to id if articleId missing
      const existing = uniqueByArticleId.get(key);
      if (!existing) {
        uniqueByArticleId.set(key, a);
        continue;
      }
      // hasContent covers list rows served by /api/articles, which strips the
      // heavy content string and sends a hasContent flag instead.
      const existingHasContent = !!(
        existing.receivedArticle?.content ||
        (existing.receivedArticle as any)?.hasContent
      );
      const currentHasContent = !!(
        a.receivedArticle?.content || (a.receivedArticle as any)?.hasContent
      );
      if (currentHasContent && !existingHasContent) {
        uniqueByArticleId.set(key, a);
        continue;
      }
      if (currentHasContent === existingHasContent) {
        const existingTs = existing.updatedAt
          ? new Date(existing.updatedAt).getTime()
          : 0;
        const currentTs = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        if (currentTs > existingTs) uniqueByArticleId.set(key, a);
      }
    }

    const articles = Array.from(uniqueByArticleId.values());
    console.log(
      `Successfully fetched ${articles.length} unique articles from Supabase (from ${(data || []).length} rows)`,
    );
    return filterArticlesByRole(articles, options?.userId, options?.userRole);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);

    // Log network errors at debug level, others at warn
    if (
      errorMessage.includes("Failed to fetch") ||
      errorMessage.includes("Network") ||
      errorMessage.includes("timeout")
    ) {
      console.debug(
        "Transient network error fetching article outlines:",
        errorMessage,
      );
    } else {
      console.warn(
        "Error fetching article outlines from Supabase:",
        errorMessage,
      );
    }

    console.debug("Falling back to localStorage");
    return filterArticlesByRole(
      getArticleOutlinesLocal(),
      options?.userId,
      options?.userRole,
    );
  }
}

// Fetch all articles without role filtering (for public access)
export async function getAllArticlesPublic(): Promise<ArticleOutline[]> {
  console.log("Getting all articles for public access (unfiltered)");

  if (!useSupabase) {
    console.log("Fetching from localStorage");
    return getArticleOutlinesLocal();
  }

  try {
    const { data, error } = await supabase
      .from("article_outlines")
      .select(ARTICLE_LIST_COLUMNS)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Supabase fetch error:", error?.message);
      console.log("Falling back to localStorage");
      return getArticleOutlinesLocal();
    }

    const normalizeSections = (sections: any[]): ArticleSection[] => {
      if (!Array.isArray(sections)) return [];
      return sections.map((s: any) => ({
        id: s.id || generateId(),
        title: s.title ?? s.Name ?? "",
        description: s.description ?? s.Purpose ?? "",
        content: s.content ?? s.Details ?? "",
      }));
    };

    const findHtmlString = (val: any, depth = 0): string | null => {
      if (!val || depth > 3) return null;
      if (typeof val === "string") {
        if (val.includes("<") && val.length > 20) return val;
        return null;
      }
      if (Array.isArray(val)) {
        for (const v of val) {
          const found = findHtmlString(v, depth + 1);
          if (found) return found;
        }
        return null;
      }
      return null;
    };

    const normalizeReceived = (raw: any, updatedAt?: string): any => {
      if (!raw) return null;
      if (typeof raw !== "object") return null;
      const contentCandidate =
        (raw as any).content ??
        (raw as any).htmlContent ??
        (raw as any).html ??
        findHtmlString(raw);

      return {
        content: typeof contentCandidate === "string" ? contentCandidate : "",
        // Preserved from /api/articles list rows, where the heavy content
        // string is stripped server-side and replaced by this flag.
        hasContent: Boolean((raw as any).hasContent),
        title:
          (raw as any).title ??
          (raw as any).seoTitle ??
          (raw as any).seo_title ??
          null,
        meta:
          (raw as any).meta ??
          (raw as any).seoMetaDescription ??
          (raw as any).seo_meta_description ??
          null,
        receivedAt:
          (raw as any).receivedAt ??
          (raw as any).timestamp ??
          (raw as any).received_at ??
          updatedAt ??
          null,
      };
    };

    const mapped = (data || []).map((row: any) => {
      // Parse received_article if it's stored as a string
      let parsedReceivedArticle = row.received_article;
      if (parsedReceivedArticle && typeof parsedReceivedArticle === "string") {
        try {
          parsedReceivedArticle = JSON.parse(parsedReceivedArticle);
        } catch (parseError) {
          console.warn(
            "Could not parse received_article as JSON, using as-is:",
            parseError,
          );
        }
      }

      const receivedArticle = normalizeReceived(
        parsedReceivedArticle,
        row.updated_at,
      );

      return {
        id: row.id,
        articleId: row.article_id,
        clientName: row.client_name,
        clientId: row.client_id,
        keyword: row.keyword,
        template: row.template || undefined,
        sections: normalizeSections(row.sections),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        webhookSent: row.webhook_sent,
        receivedArticle: receivedArticle,
        schema: row.schema || undefined,
        "word count": row["word count"] || undefined,
        "flesch score": row["flesch score"] || undefined,
        "Page URL": row["Page URL"] || undefined,
        "URL Slug": row["URL Slug"] || undefined,
        userId: row.user_id || undefined,
        version: row.version || undefined,
        titleTag: row.title_tag || undefined,
        translations: row.translations || undefined,
      } as ArticleOutline;
    });

    const uniqueByArticleId = new Map<string, ArticleOutline>();
    for (const a of mapped) {
      const key = a.articleId || a.id;
      const existing = uniqueByArticleId.get(key);
      if (!existing) {
        uniqueByArticleId.set(key, a);
        continue;
      }
      // hasContent covers list rows served by /api/articles, which strips the
      // heavy content string and sends a hasContent flag instead.
      const existingHasContent = !!(
        existing.receivedArticle?.content ||
        (existing.receivedArticle as any)?.hasContent
      );
      const currentHasContent = !!(
        a.receivedArticle?.content || (a.receivedArticle as any)?.hasContent
      );
      if (currentHasContent && !existingHasContent) {
        uniqueByArticleId.set(key, a);
        continue;
      }
      if (currentHasContent === existingHasContent) {
        const existingTs = existing.updatedAt
          ? new Date(existing.updatedAt).getTime()
          : 0;
        const currentTs = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        if (currentTs > existingTs) uniqueByArticleId.set(key, a);
      }
    }

    return Array.from(uniqueByArticleId.values());
  } catch (error) {
    console.error("Error fetching articles:", error);
    return getArticleOutlinesLocal();
  }
}

function filterArticlesByRole(
  articles: ArticleOutline[],
  userId?: string,
  userRole?: "admin" | "member",
): ArticleOutline[] {
  console.log(
    `🔐 filterArticlesByRole: userId=${userId}, userRole=${userRole}, total articles=${articles.length}`,
  );

  // ADMIN EXCEPTION: Admins can see all articles from all users (e.g., in admin dashboard)
  if (userRole === "admin") {
    console.log(`✅ User is ADMIN - returning all ${articles.length} articles`);
    articles.forEach((article, idx) => {
      console.log(
        `   [${idx}] Article ID: ${article.id}, Keyword: "${article.keyword}", UserId: "${article.userId || "UNDEFINED"}"`,
      );
    });
    return articles;
  }

  // If we have no userId, the user is not authenticated - return empty
  if (!userId) {
    console.warn(
      "⚠️ CRITICAL: No userId available for filtering. This user should not be able to see articles.",
    );
    return [];
  }

  // STRICT OWNERSHIP: Non-admins only see articles they created
  console.log(`🔍 FILTER ANALYSIS (userId="${userId}"):`);
  articles.forEach((article, idx) => {
    const match = article.userId === userId;
    const symbol = match ? "✅" : "❌";
    console.log(
      `   ${symbol} [${idx}] Article ID: ${article.id}, Keyword: "${article.keyword}", UserId: "${article.userId || "UNDEFINED"}", Match: ${match}`,
    );
  });

  const filtered = articles.filter((article) => article.userId === userId);

  console.log(
    `🔒 Ownership filter: returning ${filtered.length} of ${articles.length} articles (only those owned by ${userId})`,
  );
  return filtered;
}

// Helper to check if user is likely an admin (used in dev/fallback scenarios)
function isLikelyAdmin(userRole?: string): boolean {
  return userRole === "admin" || userRole?.toLowerCase() === "admin";
}

export async function saveArticleOutline(
  outline: ArticleOutline,
): Promise<void> {
  console.log("💾 saveArticleOutline() called - saving outline:", {
    id: outline.id,
    keyword: outline.keyword,
    contentLength: outline.receivedArticle?.content?.length || 0,
  });

  // ALWAYS save to localStorage first (primary source of truth)
  console.log("Step 1: Saving to localStorage...");
  saveArticleOutlineLocal(outline);
  console.log("✅ Saved to localStorage");

  if (!useSupabase) {
    console.log("⚠️ Supabase not available, only saved to localStorage");
    return;
  }

  try {
    const outlineData = {
      id: outline.id,
      article_id: outline.articleId,
      client_name: outline.clientName,
      client_id: outline.clientId,
      keyword: outline.keyword,
      template: outline.template || null,
      updated_at: new Date().toISOString(),
      webhook_sent: outline.webhookSent || false,
      // Note: Do NOT include 'schema' - it's read-only and managed by backend
      received_article: outline.receivedArticle || null,
      user_id: outline.userId || null,
      page_update_type: outline["page-update-type"] || null,
      page_url: outline["page-url"] || null,
    };

    console.log("💾 Saving page configuration to Supabase:", {
      page_update_type: outlineData.page_update_type,
      page_url: outlineData.page_url,
    });

    // Try to select the record (don't use .single() as it throws 406 on 0 rows)
    const { data: existingRecord, error: selectError } = await supabase
      .from("article_outlines")
      .select("id")
      .eq("id", outline.id);

    if (selectError) {
      console.error("Select error:", selectError);
      throw selectError;
    }

    if (existingRecord && existingRecord.length > 0) {
      // Record exists, update it
      console.log("🔄 UPDATING record with ID:", outline.id);
      console.log("📌 received_article being saved:", JSON.stringify(outlineData.received_article, null, 2));

      // Log title and meta specifically for debugging
      if (outlineData.received_article) {
        const ra = outlineData.received_article as any;
        console.log("  ├─ Title type:", typeof ra.title, "Length:", ra.title?.length || 0);
        console.log("  ├─ Title value:", JSON.stringify(ra.title));
        console.log("  ├─ Meta type:", typeof ra.meta, "Length:", ra.meta?.length || 0);
        console.log("  ├─ Meta value:", JSON.stringify(ra.meta));
        console.log("  └─ Content length:", String(ra.content || "").length);
      }

      console.log("📤 Sending update to Supabase with data:", {
        id: outline.id,
        received_article: outlineData.received_article,
        updated_at: outlineData.updated_at,
      });

      const { data: updateResult, error: updateError, count: rowsAffected } = await supabase
        .from("article_outlines")
        .update(outlineData)
        .eq("id", outline.id)
        .select();

      console.log("📥 Update response:", {
        error: updateError,
        rowsAffected,
        resultLength: updateResult?.length,
        errorCode: (updateError as any)?.code,
        errorMessage: (updateError as any)?.message,
        errorDetails: (updateError as any)?.details,
        errorHint: (updateError as any)?.hint,
      });

      if (updateError) {
        console.error("❌ Update error:", updateError);
        throw updateError;
      }

      if (!updateResult || updateResult.length === 0) {
        console.error("🚨 CRITICAL: Update returned no rows!");
        console.error("   This indicates either:");
        console.error("   1. RLS policy is blocking the update");
        console.error("   2. User doesn't have write permission");
        console.error("   3. ID doesn't match");
        console.error("   Looking for ID:", outline.id);

        // Try to verify the record exists and what the user permission is
        const { data: checkData } = await supabase
          .from("article_outlines")
          .select("id, user_id, client_id")
          .eq("id", outline.id);
        console.error("   Record check result:", checkData);

        // Throw an error so the catch block can handle the failure properly
        throw new Error("Update failed: No rows were affected. This may indicate an RLS policy issue or missing permissions.");
      }

      console.log("✅ Successfully saved article to Supabase!", {
        articleId: outline.id,
        keyword: outline.keyword,
        contentLength: outline.receivedArticle?.content?.length || 0,
      });

      // Sync to localStorage again to ensure consistency
      console.log("Step 3: Syncing with localStorage...");
      saveArticleOutlineLocal(outline);
      console.log("✅ Synced to localStorage - data is protected in both places");
      console.log("🔒 Your changes are now safely stored in the cloud.");
    } else {
      // Insert new record so webhook can find it by article_id
      // Include sections on insert — the V4 pipeline will later overwrite with
      // webhook-format sections (name/details/wordCount) after generation.
      const insertData = { ...outlineData, sections: outline.sections };
      console.log("Inserting new article to Supabase:", insertData);
      const { error: insertError } = await supabase
        .from("article_outlines")
        .insert([insertData]);

      if (insertError) {
        console.error("Insert error details:", {
          message: insertError.message,
          code: insertError.code,
          details: insertError.details,
          hint: insertError.hint,
        });
        throw insertError;
      }
      console.log("Successfully created article in Supabase");
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Error saving article outline to Supabase:", errorMsg);
    if (error instanceof Error && "code" in error) {
      console.error("Error details:", {
        code: (error as any).code,
        details: (error as any).details,
        hint: (error as any).hint,
      });
    }

    // Always disable Supabase on any error to be safe, fall back to localStorage
    useSupabase = false;
    console.warn("❌ CRITICAL: Supabase save failed, falling back to localStorage");
    console.warn("Error details:", {
      message: errorMsg,
      code: error instanceof Error && "code" in error ? (error as any).code : "unknown",
      details: error instanceof Error && "details" in error ? (error as any).details : undefined,
    });

    // Re-enable Supabase check after 5 seconds
    setTimeout(() => {
      checkSupabaseConnection();
    }, 5000);

    console.log("⚠️ Saving to localStorage instead - YOUR CHANGES MAY BE LOST IF YOU RELOAD");
    return saveArticleOutlineLocal(outline);
  }
}

export async function deleteArticleOutline(id: string): Promise<void> {
  if (!useSupabase) {
    return deleteArticleOutlineLocal(id);
  }

  try {
    const { error } = await supabase
      .from("article_outlines")
      .delete()
      .eq("id", id);

    if (error) throw error;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("Error deleting article outline from Supabase:", errorMsg);

    // Always disable Supabase on any error to be safe
    useSupabase = false;
    console.warn("Disabling Supabase, falling back to localStorage");

    // Re-enable Supabase check after 5 seconds
    setTimeout(() => {
      checkSupabaseConnection();
    }, 5000);

    return deleteArticleOutlineLocal(id);
  }
}

export async function getArticleOutlineById(
  id: string,
): Promise<ArticleOutline | null> {
  // CRITICAL FIX: Check localStorage FIRST - user edits are only in localStorage until Save button is clicked
  // Supabase is backup/cloud sync
  console.log("📥 getArticleOutlineById() called with ID:", id);

  // ALWAYS check localStorage first - it contains unsaved user edits
  const localData = getArticleOutlineByIdLocal(id);
  if (localData) {
    console.log("✅ FOUND IN LOCALSTORAGE (user edits):", {
      id: localData.id,
      keyword: localData.keyword,
      contentLength: localData.receivedArticle?.content?.length || 0,
      updatedAt: localData.updatedAt,
    });
    // Merge fields from Supabase that localStorage may not have
    // Always refresh server-owned fields from Supabase. Translations are
    // written server-side only, so localStorage can be stale when a NEW language
    // is added after an earlier one was already cached.
    if (useSupabase) {
      try {
        let { data: row } = await supabase
          .from("article_outlines")
          .select("translations, title_tag, version")
          .eq("id", id)
          .maybeSingle();
        if (!row) {
          const res = await supabase
            .from("article_outlines")
            .select("translations, title_tag, version")
            .eq("article_id", id)
            .maybeSingle();
          row = res.data;
        }
        if (row) {
          if (row.translations) {
            // Supabase is the source of truth for translations — always take the
            // latest so a newly completed translation (e.g. a 2nd language)
            // appears instead of being masked by an earlier cached one.
            // (Fixes "Español not showing as Done" after Vietnamese existed.)
            localData.translations = row.translations;
            console.log("✅ Refreshed translations from Supabase into localStorage article");
          }
          if (row.title_tag && !localData.titleTag) {
            localData.titleTag = row.title_tag;
            console.log("✅ Merged titleTag from Supabase into localStorage article:", row.title_tag);
          }
          if (row.version && !localData.version) {
            localData.version = row.version;
            console.log("✅ Merged version from Supabase into localStorage article:", row.version);
          }
        }
      } catch (e) {
        console.debug("Could not fetch metadata from Supabase:", e);
      }
    }
    return localData;
  }

  // If not in localStorage, try Supabase
  if (!useSupabase) {
    console.log("❌ Not found in localStorage, Supabase disabled");
    return null;
  }

  try {
    // Try to find by id first
    let { data, error } = await supabase
      .from("article_outlines")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    // If not found by id, try article_id
    if (!data && !error) {
      console.log(`📥 getArticleOutlineById(${id}) - not found by id, trying article_id...`);
      const { data: data2, error: error2 } = await supabase
        .from("article_outlines")
        .select("*")
        .eq("article_id", id)
        .maybeSingle();
      data = data2;
      error = error2;
      if (data) {
        console.log(`📥 Found by article_id: ${id}`);
      }
    }

    if (error) {
      // Don't log the full error object, just the message - improves readability
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.debug(`[Supabase Query Error for ID: ${id}] ${errorMsg}`);
      throw error;
    }

    if (!data) {
      return null;
    }

    // Parse received_article if it's stored as a string
    let receivedArticle = data.received_article;
    if (receivedArticle && typeof receivedArticle === "string") {
      try {
        receivedArticle = JSON.parse(receivedArticle);
      } catch (parseError) {
        console.warn(
          "Could not parse received_article as JSON, using as-is:",
          parseError,
        );
      }
    }

    const normalizeSections = (sections: any[]): ArticleSection[] => {
      if (!Array.isArray(sections)) return [];
      return sections.map((s: any) => ({
        id: s.id || generateId(),
        title: s.title ?? s.Name ?? "",
        description: s.description ?? s.Purpose ?? "",
        content: s.content ?? s.Details ?? "",
      }));
    };

    const findHtmlString2 = (val: any, depth = 0): string | null => {
      if (!val || depth > 3) return null;
      if (typeof val === "string") {
        if (val.includes("<") && val.length > 20) return val;
        return null;
      }
      if (Array.isArray(val)) {
        for (const v of val) {
          const found = findHtmlString2(v, depth + 1);
          if (found) return found;
        }
        return null;
      }
      if (typeof val === "object") {
        for (const k of Object.keys(val)) {
          const found = findHtmlString2(val[k], depth + 1);
          if (found) return found;
        }
      }
      return null;
    };

    const normalizeReceived = (raw: any, updatedAt?: string) => {
      if (raw == null) return null;
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          raw = parsed;
        } catch {
          return {
            content: raw,
            title: null,
            meta: null,
            receivedAt: updatedAt || null,
          };
        }
      }
      if (typeof raw !== "object") return null;
      const contentCandidate =
        (raw as any).content ??
        (raw as any).htmlContent ??
        (raw as any).html ??
        findHtmlString2(raw);
      return {
        content: typeof contentCandidate === "string" ? contentCandidate : "",
        title:
          (raw as any).title ??
          (raw as any).seoTitle ??
          (raw as any).seo_title ??
          null,
        meta:
          (raw as any).meta ??
          (raw as any).seoMetaDescription ??
          (raw as any).seo_meta_description ??
          null,
        receivedAt:
          (raw as any).receivedAt ??
          (raw as any).timestamp ??
          (raw as any).received_at ??
          updatedAt ??
          null,
      };
    };

    const normalizedReceived = normalizeReceived(receivedArticle, data.updated_at);

    const result = {
      id: data.id,
      articleId: data.article_id,
      clientName: data.client_name,
      clientId: data.client_id,
      keyword: data.keyword,
      template: data.template || undefined,
      sections: normalizeSections(data.sections),
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      webhookSent: data.webhook_sent,
      schema: data["Schema"] || data.schema || undefined,
      "word count": data["word count"] || undefined,
      "flesch score": data["flesch score"] || undefined,
      "Page URL": data["Page URL"] || undefined,
      "URL Slug": data["URL Slug"] || undefined,
      "page-update-type": data.page_update_type || undefined,
      "page-url": data.page_url || undefined,
      receivedArticle: normalizedReceived,
      userId: data.user_id || undefined,
      version: data.version || undefined,
      titleTag: data.title_tag || undefined,
      translations: data.translations || undefined,
      resourcePage: data.resource_page || undefined,
    };

    // Log what was retrieved for debugging
    console.log("📥 Retrieved article from Supabase:", {
      id: data.id,
      pageUpdateType: data.page_update_type,
      pageUrl: data.page_url,
    });

    if (normalizedReceived) {
      console.log("📥 Retrieved article with receivedArticle:", {
        hasTitle: !!normalizedReceived.title,
        title: normalizedReceived.title || "(empty)",
        hasMeta: !!normalizedReceived.meta,
        meta: normalizedReceived.meta || "(empty)",
        contentLength: normalizedReceived.content?.length || 0,
      });
    }

    return result;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : JSON.stringify(error);

    // Check if this is a transient network error vs. a permanent error
    const isNetworkError =
      errorMessage.includes("Failed to fetch") ||
      errorMessage.includes("Network") ||
      errorMessage.includes("timeout") ||
      errorMessage.includes("CORS");

    const isPermanentError =
      errorMessage.includes("401") ||
      errorMessage.includes("403") ||
      errorMessage.includes("Unauthorized") ||
      errorMessage.includes("permission");

    if (isNetworkError) {
      // For transient network errors, silently fall back to local
      // Don't log or disable Supabase - it might recover on next poll
      // This is expected during polling with occasional network glitches
    } else if (isPermanentError) {
      // For permanent errors (auth/permission), disable Supabase and wait for check
      console.error(
        `[Supabase] Permanent error retrieving article outline: ${errorMessage}`,
      );
      useSupabase = false;
      setTimeout(() => {
        checkSupabaseConnection();
      }, 5000);
    } else {
      // For other errors, log at debug level
      console.debug(
        `[Supabase] Error retrieving article outline: ${errorMessage}`,
      );
    }

    return getArticleOutlineByIdLocal(id);
  }
}

export function generateId(): string {
  // Use crypto.randomUUID if available (modern browsers & Node.js)
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback: Create a unique ID using timestamp + higher entropy random
  const timestamp = Date.now().toString(36);
  const randomPart =
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2);
  return `${timestamp}-${randomPart}`;
}

// localStorage fallback functions
function getArticleOutlinesLocal(): ArticleOutline[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    const outlines = data ? JSON.parse(data) : [];
    if (outlines.length > 0) {
      console.log(`📦 localStorage has ${outlines.length} articles:`,
        outlines.map(o => ({
          id: o.id,
          keyword: o.keyword,
          hasContent: !!o.receivedArticle?.content,
          contentLength: o.receivedArticle?.content?.length || 0,
        }))
      );
    }
    return outlines;
  } catch (error) {
    console.error("Error reading from localStorage:", error);
    return [];
  }
}

function saveArticleOutlineLocal(outline: ArticleOutline): void {
  try {
    const outlines = getArticleOutlinesLocal();
    const existingIndex = outlines.findIndex((o) => o.id === outline.id);

    if (existingIndex >= 0) {
      outlines[existingIndex] = outline;
      console.log(`✅ Updated article in localStorage: ${outline.id}`, {
        keyword: outline.keyword,
        contentLength: outline.receivedArticle?.content?.length || 0,
      });
    } else {
      outlines.push(outline);
      console.log(`✅ Added new article to localStorage: ${outline.id}`, {
        keyword: outline.keyword,
        contentLength: outline.receivedArticle?.content?.length || 0,
      });
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(outlines));
    console.log(`📦 localStorage now has ${outlines.length} articles total`);
  } catch (error) {
    console.error("Error saving to localStorage:", error);
  }
}

function deleteArticleOutlineLocal(id: string): void {
  try {
    const outlines = getArticleOutlinesLocal();
    const filtered = outlines.filter((o) => o.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  } catch (error) {
    console.error("Error deleting from localStorage:", error);
  }
}

function getArticleOutlineByIdLocal(id: string): ArticleOutline | null {
  try {
    const outlines = getArticleOutlinesLocal();

    // First, try to find by exact id match
    let found = outlines.find((o) => o.id === id);
    if (found) {
      console.log(`✅ localStorage FOUND by ID: ${id}`, {
        keyword: found.keyword,
        hasContent: !!found.receivedArticle?.content,
        contentLength: found.receivedArticle?.content?.length || 0,
      });
      return found;
    }

    // If not found by ID, try by articleId (in case webhook created new entry)
    found = outlines.find((o) => o.articleId === id);
    if (found) {
      console.log(`✅ localStorage FOUND by articleId: ${id}`, {
        id: found.id,
        keyword: found.keyword,
        hasContent: !!found.receivedArticle?.content,
        contentLength: found.receivedArticle?.content?.length || 0,
      });
      return found;
    }

    console.log(`❌ localStorage NOT FOUND - ID: ${id}`);
    console.log("📋 Available articles in localStorage:", outlines.map(o => ({
      id: o.id,
      articleId: o.articleId,
      keyword: o.keyword,
      hasContent: !!o.receivedArticle?.content,
      contentLength: o.receivedArticle?.content?.length || 0,
    })));
    return null;
  } catch (error) {
    console.error("Error retrieving from localStorage:", error);
    return null;
  }
}

// Template storage functions
function getTemplatesFromLocalStorage(): OutlineTemplate[] {
  try {
    const data = localStorage.getItem(TEMPLATES_STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error("Error reading templates from localStorage:", error);
    return [];
  }
}

function saveTemplatesToLocalStorage(templates: OutlineTemplate[]): void {
  try {
    localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(templates));
  } catch (error) {
    console.error("Error saving templates to localStorage:", error);
  }
}

const normalizeTemplateSections = (sections: any): ArticleSection[] => {
  if (!Array.isArray(sections)) return [];
  return sections.map((s: any) => ({
    id: s.id || generateId(),
    title: s.title ?? "",
    description: s.description ?? "",
    content: s.content ?? "",
    examples: s.examples ?? "",
    targetWordCount:
      typeof s.targetWordCount === "number" && !Number.isNaN(s.targetWordCount)
        ? s.targetWordCount
        : undefined,
  }));
};

export async function getTemplates(): Promise<OutlineTemplate[]> {
  try {
    const { data, error } = await supabase
      .from("templates")
      .select("id, name, description, sections")
      .order("created_at", { ascending: true });

    if (error) throw error;

    const dbTemplates: OutlineTemplate[] = (data || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      sections: normalizeTemplateSections(row.sections),
    }));

    if (dbTemplates.length > 0) {
      return dbTemplates;
    }

    // Empty Supabase response is NOT a signal to write localStorage back to
    // Supabase. RLS, transient errors, and incomplete result sets all return
    // empty without erroring — auto-seeding here used to call saveTemplates,
    // whose destructive "delete IDs not in incoming list" pattern then wiped
    // every template not in the user's local cache. Just return whatever
    // localStorage has and leave Supabase alone.
    return getTemplatesFromLocalStorage();
  } catch (error) {
    console.error("Error fetching templates from Supabase:", error);
    return getTemplatesFromLocalStorage();
  }
}

export interface ArticleRevision {
  id: string;
  article_id: string;
  version_number: number;
  html_content: string;
  created_at: string;
}

export async function getArticleBySlug(
  clientName: string,
  keyword: string,
): Promise<ArticleOutline | null> {
  try {
    console.log("getArticleBySlug - Searching for:", { clientName, keyword });

    // Try localStorage first (most reliable for public shares)
    const outlines = getArticleOutlinesLocal();
    console.log(
      "getArticleBySlug - localStorage has",
      outlines.length,
      "articles",
    );

    const article = outlines.find(
      (o) =>
        o.clientName?.toLowerCase() === clientName.toLowerCase() &&
        o.keyword?.toLowerCase() === keyword.toLowerCase(),
    );

    if (article) {
      console.log("getArticleBySlug - Found in localStorage");
      return article;
    }

    // Fallback to API if not in localStorage
    console.log("getArticleBySlug - Not in localStorage, trying API");
    const url = `/.netlify/functions/get-article?clientName=${encodeURIComponent(clientName)}&keyword=${encodeURIComponent(keyword)}`;

    const response = await fetch(url);
    console.log("getArticleBySlug - API response status:", response.status);

    if (response.ok) {
      try {
        const data = await response.json();
        console.log("getArticleBySlug - API returned article");
        return data.article || null;
      } catch (parseError) {
        console.error(
          "getArticleBySlug - Error parsing API response:",
          parseError,
        );
      }
    }

    return null;
  } catch (error) {
    console.error("Error fetching article by slug:", error);

    // Last resort: try localStorage one more time
    const outlines = getArticleOutlinesLocal();
    return (
      outlines.find(
        (o) =>
          o.clientName?.toLowerCase() === clientName.toLowerCase() &&
          o.keyword?.toLowerCase() === keyword.toLowerCase(),
      ) || null
    );
  }
}

export async function getArticleRevisions(
  articleId: string,
): Promise<ArticleRevision[]> {
  try {
    const response = await fetch(
      `/.netlify/functions/get-article-revisions?article_id=${encodeURIComponent(articleId)}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch revisions (HTTP ${response.status})`);
    }

    const data = await response.json();
    return (data.revisions || []) as ArticleRevision[];
  } catch (error) {
    console.error("Error fetching article revisions:", error);
    return [];
  }
}

// Upsert templates into Supabase. NON-DESTRUCTIVE — only inserts/updates the
// rows in `templates`; never deletes other rows. The previous "delete IDs not
// in incoming list" pattern was the footgun that wiped templates on Apr 27/28
// when a stale UI state was saved. Use deleteTemplate(id) for explicit deletes.
export async function saveTemplates(
  templates: OutlineTemplate[],
): Promise<void> {
  try {
    const payload = templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      sections: t.sections,
    }));

    if (payload.length === 0) {
      // Nothing to upsert. Mirror to localStorage and exit — do NOT issue any
      // Supabase write when given an empty list.
      saveTemplatesToLocalStorage(templates);
      return;
    }

    const { error: upsertError } = await supabase
      .from("templates")
      .upsert(payload, { onConflict: "id" });

    if (upsertError) {
      console.error(
        "Upsert error object:",
        JSON.stringify(upsertError, null, 2),
      );
      console.error("Error details:", {
        message: (upsertError as any)?.message,
        code: (upsertError as any)?.code,
        details: (upsertError as any)?.details,
        hint: (upsertError as any)?.hint,
      });
      throw upsertError;
    }

    saveTemplatesToLocalStorage(templates);
  } catch (error) {
    console.error(
      "Error saving templates to Supabase, falling back to localStorage only:",
      JSON.stringify(error, null, 2),
    );
    saveTemplatesToLocalStorage(templates);
  }
}

// Delete a single template by id. Explicit, scoped, and the ONLY supported
// path for removing templates from Supabase. Settings UI delete button calls
// this directly instead of relying on saveTemplates' prior implicit deletion.
export async function deleteTemplate(id: string): Promise<void> {
  try {
    const { error } = await supabase
      .from("templates")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("Error deleting template from Supabase:", error);
      throw error;
    }

    // Mirror the deletion to localStorage so the cached copy stays in sync.
    const cached = getTemplatesFromLocalStorage();
    saveTemplatesToLocalStorage(cached.filter((t) => t.id !== id));
  } catch (error) {
    console.error(
      "Error deleting template, leaving localStorage untouched:",
      JSON.stringify(error, null, 2),
    );
    throw error;
  }
}
