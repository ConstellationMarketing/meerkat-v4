import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, Globe, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArticleOutline } from "@/types/article";
import { getArticleOutlineById } from "@/lib/storage";
import {
  requestTranslation,
  getTranslationStatus,
  LANGUAGE_LABELS,
  type TranslationLanguage,
  type TranslationStatus,
} from "@/lib/translate";

interface TranslationControlsProps {
  outline: ArticleOutline;
  /** Called when the user selects a language to view (null = English original) */
  onLanguageChange: (language: TranslationLanguage | null) => void;
  /** Currently active display language */
  activeLanguage: TranslationLanguage | null;
  /** Called after a translation completes — refresh translations in place instead of a full page reload. */
  onTranslationsUpdated?: (translations: ArticleOutline["translations"]) => void;
}

const LANGUAGES: TranslationLanguage[] = ["es", "vi"];

export function TranslationControls({
  outline,
  onLanguageChange,
  activeLanguage,
  onTranslationsUpdated,
}: TranslationControlsProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [translating, setTranslating] = useState<TranslationLanguage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const articleId = outline.articleId || outline.id;

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const getTranslation = useCallback(
    (lang: TranslationLanguage) => outline.translations?.[lang],
    [outline.translations],
  );

  const handleTranslate = async (lang: TranslationLanguage) => {
    setIsDropdownOpen(false);
    setError(null);
    setTranslating(lang);

    try {
      await requestTranslation(articleId, lang);

      // Poll for completion
      pollRef.current = setInterval(async () => {
        try {
          const status: TranslationStatus = await getTranslationStatus(articleId, lang);
          if (status.status === "complete") {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setTranslating(null);
            // Refresh in place and switch to the new language. Avoids a full
            // page reload, which in the Public View can drop the article
            // context (loaded from navigation state) and fail to reflect.
            try {
              const fresh = await getArticleOutlineById(articleId);
              if (fresh && onTranslationsUpdated) {
                onTranslationsUpdated(fresh.translations);
                onLanguageChange(lang);
              } else {
                window.location.reload();
              }
            } catch {
              window.location.reload();
            }
          } else if (status.status === "failed") {
            // Backend marks failed runs explicitly (July 2026) — stop polling
            // and surface it instead of spinning forever.
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setTranslating(null);
            setError("Translation failed — it will be retried automatically, or try again now.");
          }
        } catch {
          // Transient errors during polling are expected — keep trying
        }
      }, 10000);
    } catch (err) {
      setTranslating(null);
      setError(err instanceof Error ? err.message : "Translation failed");
    }
  };

  const hasAnyTranslation = LANGUAGES.some(
    (lang) => getTranslation(lang)?.status === "complete",
  );

  // If no content to translate, don't render
  if (!outline.receivedArticle?.content) return null;

  return (
    <div className="flex items-center gap-2">
      {/* Language toggle bar — only show if there are completed translations */}
      {hasAnyTranslation && (
        <div className="flex items-center bg-muted/50 rounded-lg border border-border/30 overflow-hidden">
          <button
            onClick={() => onLanguageChange(null)}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              activeLanguage === null
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            English
          </button>
          {LANGUAGES.map((lang) => {
            const t = getTranslation(lang);
            if (t?.status !== "complete") return null;
            return (
              <button
                key={lang}
                onClick={() => onLanguageChange(lang)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeLanguage === lang
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                {LANGUAGE_LABELS[lang]}
              </button>
            );
          })}
        </div>
      )}

      {/* Translate dropdown */}
      <div className="relative" ref={dropdownRef}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          disabled={!!translating}
          className="h-8 gap-1.5"
        >
          {translating ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Globe className="w-3.5 h-3.5" />
          )}
          <span className="text-xs">
            {translating
              ? `Translating to ${LANGUAGE_LABELS[translating]}...`
              : "Translate"}
          </span>
          {!translating && <ChevronDown className="w-3 h-3" />}
        </Button>

        {isDropdownOpen && (
          <div className="absolute right-0 top-full mt-1 bg-popover border border-border rounded-lg shadow-lg z-50 min-w-[160px] py-1">
            {LANGUAGES.map((lang) => {
              const t = getTranslation(lang);
              const isComplete = t?.status === "complete";
              return (
                <button
                  key={lang}
                  onClick={() => handleTranslate(lang)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center justify-between"
                >
                  <span>{LANGUAGE_LABELS[lang]}</span>
                  {isComplete && (
                    <span className="text-xs text-green-600 font-medium">Done</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <span className="text-xs text-destructive">{error}</span>
      )}
    </div>
  );
}
