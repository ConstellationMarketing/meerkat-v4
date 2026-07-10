/**
 * Translation API client — calls V4 backend endpoints
 */

const TRANSLATE_API_URL =
  import.meta.env.VITE_TRANSLATE_API_URL || "https://meerkat-api.goconstellation.com";

export type TranslationLanguage = "es" | "vi";

export const LANGUAGE_LABELS: Record<TranslationLanguage, string> = {
  es: "Español",
  vi: "Tiếng Việt",
};

export interface TranslationStatus {
  articleId: string;
  language: string;
  status: "pending" | "complete" | "failed" | "not_found";
  translated_at?: string | null;
  content?: string | null;
  title?: string | null;
  meta?: string | null;
  slug?: string | null;
}

/** Trigger a translation for the given article and language */
export async function requestTranslation(
  articleId: string,
  language: TranslationLanguage,
): Promise<{ status: string; message: string }> {
  const res = await fetch(`${TRANSLATE_API_URL}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ articleId, language }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Translation request failed: ${res.status}`);
  }

  return res.json();
}

/** Poll translation status */
export async function getTranslationStatus(
  articleId: string,
  language: TranslationLanguage,
): Promise<TranslationStatus> {
  const res = await fetch(
    `${TRANSLATE_API_URL}/translate/status?articleId=${encodeURIComponent(articleId)}&language=${encodeURIComponent(language)}`,
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Status check failed: ${res.status}`);
  }

  return res.json();
}
