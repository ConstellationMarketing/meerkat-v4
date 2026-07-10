import { Handler } from "@netlify/functions";
import { supabase } from "../../server/supabase";

const TRANSLATE_API_URL =
  process.env.TRANSLATE_API_URL ||
  process.env.VITE_TRANSLATE_API_URL ||
  "https://meerkat-api.goconstellation.com";

// Ping the VPS translate queue after a successful save. The queue debounces
// per article (30s of quiet), so calling this on every autosave is cheap.
// Never throws — a failed ping must not fail the save.
async function pingTranslateQueue(articleId: string | null | undefined) {
  if (!articleId) return;
  try {
    await fetch(`${TRANSLATE_API_URL}/translate/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articleId }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    console.warn(
      `⚠️ translate queue ping failed for ${articleId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export const handler: Handler = async (event) => {
  const method = event.httpMethod;

  // Accept both POST and PATCH methods
  if (method !== "POST" && method !== "PATCH") {
    return {
      statusCode: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  try {
    // Handle POST requests from ArticleEditor (update html_content and create revisions)
    if (method === "POST") {
      const {
        id,
        html_content,
        received_article,
        create_revision,
        word_count,
        flesch_score,
        schema,
      } = body;

      console.log("📬 Update article request received:", {
        id,
        hasHtmlContent: !!html_content,
        hasReceivedArticle: !!received_article,
        receivedArticleTitle: received_article?.title,
        receivedArticleMeta: received_article?.meta,
      });

      if (!id || html_content === undefined) {
        return {
          statusCode: 400,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: "Missing required fields: id, html_content",
          }),
        };
      }

      // If create_revision is true, save current version first
      if (create_revision) {
        try {
          console.log(`📌 Attempting to create revision for outline ID: ${id}`);

          // Get current article to save as revision
          const { data: currentData, error: fetchError } = await supabase
            .from("article_outlines")
            .select("received_article, article_id")
            .eq("id", id)
            .single();

          if (fetchError) {
            console.warn(
              "❌ Failed to fetch article for revision:",
              fetchError,
            );
          }

          console.log("📊 Current data:", {
            hasContent: !!currentData?.received_article?.content,
            articleId: currentData?.article_id,
            contentLength: currentData?.received_article?.content?.length,
          });

          if (
            currentData?.received_article?.content &&
            currentData?.article_id
          ) {
            // Get the next version number
            const { data: revisions, error: revisionQueryError } =
              await supabase
                .from("article_revisions")
                .select("version_number")
                .eq("article_id", currentData.article_id)
                .order("version_number", { ascending: false })
                .limit(1);

            if (revisionQueryError) {
              console.warn(
                "❌ Failed to fetch existing revisions:",
                revisionQueryError,
              );
            }

            const nextVersion = (revisions?.[0]?.version_number || 0) + 1;

            console.log(
              `📝 Creating revision ${nextVersion} for article ${currentData.article_id}`,
            );

            // Create revision
            const { error: insertError } = await supabase
              .from("article_revisions")
              .insert([
                {
                  article_id: currentData.article_id,
                  html_content: currentData.received_article.content,
                  version_number: nextVersion,
                  created_at: new Date().toISOString(),
                },
              ]);

            if (insertError) {
              console.error("❌ Failed to insert revision:", insertError);
            } else {
              console.log(
                `✅ Revision ${nextVersion} created successfully for article ${currentData.article_id}`,
              );
            }
          } else {
            console.warn(
              "⚠️ Could not create revision: missing article_id or content",
              {
                articleId: currentData?.article_id,
                hasContent: !!currentData?.received_article?.content,
              },
            );
          }
        } catch (revisionError) {
          console.error("❌ Exception while creating revision:", revisionError);
          // Don't fail the update if revision creation fails
        }
      }

      // Update the article with calculated metrics
      // Ensure received_article properly merges all fields
      const mergedArticle = {
        ...body.received_article,
        content: html_content,
      };

      console.log("📝 Merging article data:", {
        hasTitle: !!mergedArticle.title,
        hasMeta: !!mergedArticle.meta,
        contentLength: html_content.length,
      });

      const updatePayload: Record<string, unknown> = {
        received_article: mergedArticle,
        updated_at: new Date().toISOString(),
      };

      // Include optional metrics if provided
      if (word_count !== undefined) {
        updatePayload["word count"] = word_count;
      }
      if (flesch_score !== undefined) {
        updatePayload["flesch score"] = flesch_score;
      }
      if (schema !== undefined) {
        updatePayload.schema = schema;
      }

      console.log("🔄 Updating Supabase with payload:", {
        id,
        hasReceivedArticle: !!updatePayload.received_article,
        receivedArticleTitle: (updatePayload.received_article as any)?.title,
        receivedArticleMeta: (updatePayload.received_article as any)?.meta,
      });

      const { data: updateData, error: updateError } = await supabase
        .from("article_outlines")
        .update(updatePayload)
        .eq("id", id)
        .select(
          'id, article_id, received_article, updated_at, "word count", "flesch score", schema',
        )
        .single();

      if (updateError) {
        console.error("❌ Supabase update error:", updateError);
        return {
          statusCode: 500,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            error: `Failed to update article: ${updateError.message}`,
          }),
        };
      }

      console.log("✅ Supabase update successful. Returned data:", {
        id: updateData?.id,
        receivedArticleTitle: updateData?.received_article?.title,
        receivedArticleMeta: updateData?.received_article?.meta,
      });

      // Keep translations in sync with edits (debounced server-side).
      await pingTranslateQueue(updateData?.article_id);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          success: true,
          data: updateData,
        }),
      };
    }

    // Handle PATCH requests (for field updates)
    const { articleId, field, value } = body;

    if (!articleId || !field) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Missing required fields: articleId, field",
        }),
      };
    }

    const updateData: Record<string, unknown> = {
      [field]: value,
      updated_at: new Date().toISOString(),
    };

    const { data: patchData, error: patchError } = await supabase
      .from("article_outlines")
      .update(updateData)
      .eq("article_id", articleId)
      .select();

    if (patchError) {
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: patchError.message }),
      };
    }

    // Field updates (title tag, meta, slug…) also affect translations.
    await pingTranslateQueue(articleId);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patchData[0]),
    };
  } catch (error) {
    console.error("Handler error:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    };
  }
};
