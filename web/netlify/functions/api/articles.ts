import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://cwligyakhxevopxiksdm.supabase.co";
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZjZG90ZHB6bWpibXN4dW5jZmRnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2Mjk3Mzg4MywiZXhwIjoyMDc4NTQ5ODgzfQ.lRHYJGEeuVATe5dd1M_6808OsHhZVT506hRoAz5JXzs";

const createSupabaseClient = () => {
  return createClient(supabaseUrl, supabaseServiceKey, {
    db: { schema: "meerkat" },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
};

type CorsHeaders = {
  [key: string]: string;
};

export const handler = async (event: any) => {
  const corsHeaders: CorsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: "",
      };
    }

    if (event.httpMethod === "GET") {
      console.log("📚 Articles GET request");

      const supabase = createSupabaseClient();
      // Fetch only the columns the list views use. Previously this projected
      // `received_article` as a whole JSONB column, which carries the full
      // editor-saved HTML per row — ~12MB across the 2,255-article corpus.
      // Combined with the other projected columns (~4MB) that put the raw
      // fetch at ~16MB, which was killing the Netlify function (Supabase
      // fetch too slow / too much intermediate memory, resulting in a 502
      // "invalid status code returned from lambda: 0" and the app showing
      // 0 articles for every client — 2026-07-17 incident).
      //
      // Instead, project only the tiny received_article metadata that the
      // list views actually need (title, meta, receivedAt) via Supabase JSON
      // path aliases. Content itself is only ever fetched by-id via
      // get-article / getArticleOutlineById when a user opens an article.
      const { data, error } = await supabase
        .from("article_outlines")
        .select(
          'id, article_id, client_name, client_id, keyword, template, sections, created_at, updated_at, webhook_sent, "Schema", "word count", "flesch score", "Page URL", "URL Slug", user_id, version, title_tag, meta_description, page_update_type, page_url, ra_title:received_article->>title, ra_meta:received_article->>meta, ra_received_at:received_article->>receivedAt',
        )
        .order("created_at", { ascending: false });

      if (error) {
        console.error("❌ Supabase error fetching articles:", {
          message: error.message,
          code: (error as any).code,
          details: (error as any).details,
        });
        return {
          statusCode: 500,
          headers: corsHeaders,
          body: JSON.stringify({
            error: error.message,
            code: (error as any).code,
          }),
        };
      }

      console.log("✅ Successfully fetched articles:", {
        count: data?.length || 0,
        articles:
          data?.map((a: any) => ({
            id: a.id,
            keyword: a.keyword,
            user_id: a.user_id,
          })) || [],
      });

      // Reassemble received_article from the JSON-path aliased fields so the
      // client-side shape stays identical to the previous version — same
      // `receivedArticle: { title, meta, receivedAt, content: null, hasContent }`
      // structure the client mapper expects. Content is never shipped here;
      // per-article endpoints fetch it by id.
      const slim = (data || []).map((row: any) => {
        const { ra_title, ra_meta, ra_received_at, ...rest } = row;
        const hasReceived = ra_received_at != null || ra_title != null;
        return {
          ...rest,
          received_article: hasReceived
            ? {
                hasContent: true,
                content: null,
                title: ra_title ?? null,
                meta: ra_meta ?? null,
                receivedAt: ra_received_at ?? null,
              }
            : null,
        };
      });

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(slim),
      };
    }

    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  } catch (error) {
    console.error("Unexpected error:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Internal server error",
      }),
    };
  }
};
