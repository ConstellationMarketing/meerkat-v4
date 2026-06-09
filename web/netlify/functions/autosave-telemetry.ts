import { Handler } from "@netlify/functions";
import { supabase } from "../../server/supabase";

/**
 * Receives autosave telemetry events from the editor and writes them to
 * meerkat.autosave_telemetry. Intended to catch silent autosave failure
 * modes — most importantly the "user is editing but no save fires" pattern
 * that surfaced as the June 2026 phantom-write incident (autosave call
 * site was disconnected, so no errors fired, but no saves landed either).
 *
 * Fire-and-forget on the client side. Never block editor UX on this call;
 * we intentionally accept and return immediately so a slow / failed
 * telemetry write can't degrade the actual editor.
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  let body: {
    event_type?: string;
    article_id?: string;
    user_email?: string;
    error_message?: string;
    details?: Record<string, unknown>;
  };

  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const validTypes = new Set([
    "save_error",
    "edits_without_saves",
    "save_success",
  ]);
  if (!body.event_type || !validTypes.has(body.event_type)) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        error: "event_type must be one of: save_error, edits_without_saves, save_success",
      }),
    };
  }

  try {
    const { error } = await supabase
      .schema("meerkat")
      .from("autosave_telemetry")
      .insert({
        event_type: body.event_type,
        article_id: body.article_id ?? null,
        user_email: body.user_email ?? null,
        error_message: body.error_message?.slice(0, 2000) ?? null,
        details: body.details ?? null,
        user_agent: event.headers["user-agent"]?.slice(0, 500) ?? null,
      });

    if (error) {
      console.error("[autosave-telemetry] insert failed:", error.message);
      // Still return 200 — telemetry failures should never propagate to the
      // editor. Log loudly for ops; the editor session is still healthy.
      return {
        statusCode: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ ok: true, logged: false }),
      };
    }

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: true }),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[autosave-telemetry] threw:", msg);
    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: true, logged: false }),
    };
  }
};
