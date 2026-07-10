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
      const { data, error } = await supabase
        .from("article_outlines")
        .select("*")
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

      // Strip the heaviest columns the list view never displays. Since the
      // translation backfill, `translations` (full ES + VI HTML) plus
      // `cleaned content` bloated this list response to many megabytes, making
      // the homepage slow to load. The editor/preview re-fetch full content by
      // id, so the list doesn't need these.
      const slim = (data || []).map((row: any) => {
        const { translations, ...rest } = row;
        delete (rest as any)["cleaned content"];
        return rest;
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
