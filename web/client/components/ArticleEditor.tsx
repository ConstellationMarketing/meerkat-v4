import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Save,
  Send,
  Download,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Circle,
  X,
  MessageCircle,
} from "lucide-react";
import { ArticleOutline } from "@/types/article";
import {
  getArticleOutlineById,
  saveArticleOutline,
  extractFirstTwoParagraphsAndClean,
  getArticleRevisions,
  isSupabaseAvailable,
  waitForConnectionCheck,
  type ArticleRevision,
} from "@/lib/storage";
import {
  calculateWordCount,
  calculateFleschScore,
} from "@/lib/article-metrics";
import { getClientFolders } from "@/lib/client-folders";
import { CLIENTS } from "@/lib/clients";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { LoadingIndicator } from "@/components/LoadingIndicator";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { RichTextEditor } from "@/components/RichTextEditor";
import { TranslationControls } from "@/components/TranslationControls";
import type { TranslationLanguage } from "@/lib/translate";
import ContentEditor from "@/components/ContentEditor/ContentEditor";
import { HeadingsNavigator } from "@/components/HeadingsNavigator";
import { SchemaEditModal } from "@/components/SchemaEditModal";
import { sendOutlineToWebhook } from "@/lib/webhook";
import { useToast } from "@/hooks/use-toast";
import { CommentsSidebar } from "@/components/CommentsSidebar";
import { FloatingCommentBox } from "@/components/FloatingCommentBox";

// Helper function to remove metadata lines and article title from content
function stripMetadataFromContent(html: string): string {
  if (!html) return html;

  let cleaned = html;

  // Remove entire paragraphs containing metadata
  cleaned = cleaned.replace(
    /<p[^>]*>[\s\S]*?(Client Name|Keyword|Title|Article ID|Description)\s*:[\s\S]*?<\/p>/gi,
    "",
  );

  // Remove divs containing metadata
  cleaned = cleaned.replace(
    /<div[^>]*>[\s\S]*?(Client Name|Keyword|Title|Article ID|Description)\s*:[\s\S]*?<\/div>/gi,
    "",
  );

  // Remove any standalone metadata lines with strong/em tags
  cleaned = cleaned.replace(
    /<(strong|b)>[\s\S]*?(Client Name|Keyword|Title|Article ID|Description)\s*:<\/(strong|b)>[\s\S]*?<br\s*\/?>/gi,
    "",
  );

  // Remove the main article title "Comprehensive Guide to Finding Legal Services" - multiple formats
  cleaned = cleaned.replace(
    /<h[1-6][^>]*>\s*Comprehensive Guide to Finding Legal Services\s*<\/h[1-6]>/gi,
    "",
  );
  cleaned = cleaned.replace(
    /<p[^>]*>\s*Comprehensive Guide to Finding Legal Services\s*<\/p>/gi,
    "",
  );
  cleaned = cleaned.replace(
    /<title[^>]*>\s*Comprehensive Guide to Finding Legal Services\s*<\/title>/gi,
    "",
  );

  // Remove the text even if not in tags (plain text at start)
  cleaned = cleaned.replace(
    /^\s*Comprehensive Guide to Finding Legal Services\s*\n*/gi,
    "",
  );

  // Also handle case where it might be in a div or other wrapper without specific pattern match
  cleaned = cleaned.replace(
    /Comprehensive Guide to Finding Legal Services\s*(?=<|$)/gi,
    "",
  );

  // Remove extra blank lines, paragraphs, headings at the beginning
  cleaned = cleaned.replace(
    /^(<br\s*\/?|<p>\s*<\/p>|<h[1-6]>\s*<\/h[1-6]>|\s)*(?=<)/gi,
    "",
  );
  cleaned = cleaned.replace(/^\s+/g, "");

  return cleaned.trim();
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildFileName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return sanitized || "article";
}

function calculateWordCount(html: string): number {
  if (!html) return 0;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.split(/\s+/).filter(Boolean).length;
}

function formatLastEditTime(date: Date | string | null | undefined): string {
  if (!date) return "Never edited";

  const editDate = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - editDate.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;

  return editDate.toLocaleDateString();
}

// Format a Date as "h:mm AM/PM" for the save-status indicator.
function formatSavedAt(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Fire-and-forget telemetry beacon. Captures autosave failure modes for
// later inspection in meerkat.autosave_telemetry. Intentionally returns
// void and swallows all errors — telemetry must NEVER block or break
// the editor. Added after the June 2026 phantom-write incident, where
// the autosave call site had been silently disconnected and we had no
// signal that nothing was being persisted.
function sendAutosaveTelemetry(
  eventType: "save_error" | "edits_without_saves" | "save_success",
  payload: {
    articleId?: string;
    userEmail?: string;
    errorMessage?: string;
    details?: Record<string, unknown>;
  } = {},
): void {
  try {
    fetch("/.netlify/functions/autosave-telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: eventType,
        article_id: payload.articleId,
        user_email: payload.userEmail,
        error_message: payload.errorMessage,
        details: payload.details,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Telemetry must not throw into the editor under any circumstances.
  }
}

interface ArticleEditorProps {
  projectId: string;
  onUpdate: () => void;
}

function getFleschScoreColor(scoreString: string | undefined): {
  bgColor: string;
  textColor: string;
  score: number;
} {
  if (!scoreString) {
    return { bgColor: "bg-gray-100", textColor: "text-gray-800", score: 0 };
  }

  // Extract the numeric part from the score string (e.g., "66.09 - Plain English..." -> 66.09)
  const scoreMatch = scoreString.match(/^([\d.]+)/);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;

  if (score >= 60) {
    return { bgColor: "bg-green-100", textColor: "text-green-800", score };
  } else if (score >= 50) {
    return { bgColor: "bg-orange-100", textColor: "text-orange-800", score };
  } else if (score >= 30) {
    return { bgColor: "bg-red-100", textColor: "text-red-800", score };
  } else {
    return { bgColor: "bg-red-900", textColor: "text-red-50", score };
  }
}

export function ArticleEditor({ projectId, onUpdate }: ArticleEditorProps) {
  const navigate = useNavigate();
  const contentEditorRef = useRef<HTMLDivElement>(null);
  const [outline, setOutline] = useState<ArticleOutline | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [isResubmitting, setIsResubmitting] = useState(false);
  const [clientFolders, setClientFolders] = useState<any[]>([]);
  const [showSchemaModal, setShowSchemaModal] = useState(false);
  const [isNavHidden, setIsNavHidden] = useState(() => {
    const stored = sessionStorage.getItem("editor_isNavHidden");
    return stored ? JSON.parse(stored) : false;
  });
  const [showHistory, setShowHistory] = useState(() => {
    const stored = sessionStorage.getItem("editor_showHistory");
    return stored ? JSON.parse(stored) : false;
  });
  const [revisions, setRevisions] = useState<ArticleRevision[]>([]);
  const [selectedRevision, setSelectedRevision] =
    useState<ArticleRevision | null>(null);
  const [isRestoringRevision, setIsRestoringRevision] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<
    "idle" | "unsaved" | "saving" | "saved" | "error"
  >("idle");
  // Timestamp of the last successful autosave THIS SESSION. Null until the
  // user's first edit has been persisted. Drives the "Saved at H:MM" display.
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [isEditFocus, setIsEditFocus] = useState(() => {
    const stored = sessionStorage.getItem("editor_isEditFocus");
    return stored ? JSON.parse(stored) : false;
  });
  const [isCommentsOpen, setIsCommentsOpen] = useState(() => {
    const stored = sessionStorage.getItem("editor_isCommentsOpen");
    return stored ? JSON.parse(stored) : false;
  });
  const [selectedText, setSelectedText] = useState<string>("");
  const [currentView, setCurrentView] = useState<
    "seo" | "edit" | "public" | "client" | null
  >(null);
  const [selectedPosition, setSelectedPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [showFloatingComment, setShowFloatingComment] = useState(false);
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);
  const [pageUpdateType, setPageUpdateType] = useState<"new" | "update">("new");
  const [pageUrl, setPageUrl] = useState<string>("");
  const [activeLanguage, setActiveLanguage] = useState<TranslationLanguage | null>(null);
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoSaveDataRef = useRef<ArticleOutline | null>(null);
  // Canary counters for the "user edits but no saves fire" failure mode.
  // Incremented in triggerAutoSave / performAutoSave; checked periodically
  // and a beacon is sent if edits >> successful saves over time. Caught
  // the dead-code autosave silently (June 2026 phantom-write incident).
  const editCountRef = useRef<number>(0);
  const autosaveSuccessCountRef = useRef<number>(0);
  const editsWithoutSavesReportedRef = useRef<boolean>(false);
  const pageConfigTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const clientFoldersCachedRef = useRef<any[] | null>(null);
  const articleCacheRef = useRef<Record<string, { data: ArticleOutline; timestamp: number }>>({});
  const { toast } = useToast();

  const handleCommentClick = (comment: any) => {
    if (comment.selected_text) {
      try {
        const contentArea = contentEditorRef.current;

        if (!contentArea) {
          toast({
            title: "Error",
            description: "Editor content area not found",
            variant: "destructive",
          });
          return;
        }

        // Normalize text for comparison
        const normalize = (text: string) =>
          text.trim().replace(/\s+/g, " ").toLowerCase();

        const searchText = normalize(comment.selected_text);
        const searchLength = comment.selected_text.length;

        // Collect all text nodes
        const textNodes: Text[] = [];
        const walker = document.createTreeWalker(
          contentArea,
          NodeFilter.SHOW_TEXT,
          null,
        );

        let node;
        while ((node = walker.nextNode())) {
          const text = node.textContent || "";
          if (text.trim().length > 0) {
            textNodes.push(node as Text);
          }
        }

        // Build a map of text with original node references
        let fullText = "";
        const nodePositions: Array<{
          nodeIdx: number;
          startInFull: number;
          endInFull: number;
        }> = [];

        for (let i = 0; i < textNodes.length; i++) {
          const text = textNodes[i].textContent || "";
          const startPos = fullText.length;
          fullText += text + " "; // Add space between nodes
          nodePositions.push({
            nodeIdx: i,
            startInFull: startPos,
            endInFull: fullText.length - 1,
          });
        }

        // Search for the normalized text in normalized full text
        const normalizedFull = normalize(fullText);
        const foundIndex = normalizedFull.indexOf(searchText);

        if (foundIndex === -1) {
          toast({
            title: "Info",
            description: "Could not find the commented text in the editor",
          });
          return;
        }

        // Map normalized position back to original text
        let normalizedPos = 0;
        let originalPos = 0;
        while (normalizedPos < foundIndex && originalPos < fullText.length) {
          if (fullText[originalPos].trim() || fullText[originalPos] === " ") {
            normalizedPos++;
          }
          originalPos++;
        }

        const matchStart = originalPos;
        let matchEnd = matchStart + searchLength;

        // Find the nodes that contain the match start and end
        let startNodeIdx = 0;
        let startOffset = 0;
        let endNodeIdx = 0;
        let endOffset = 0;

        // Find start node
        for (const pos of nodePositions) {
          if (matchStart >= pos.startInFull && matchStart <= pos.endInFull) {
            startNodeIdx = pos.nodeIdx;
            startOffset = matchStart - pos.startInFull;
            break;
          }
        }

        // Find end node
        for (const pos of nodePositions) {
          if (matchEnd >= pos.startInFull && matchEnd <= pos.endInFull) {
            endNodeIdx = pos.nodeIdx;
            endOffset = matchEnd - pos.startInFull;
            break;
          }
        }

        const startNode = textNodes[startNodeIdx];
        const endNode = textNodes[endNodeIdx];

        if (!startNode || !endNode) {
          toast({
            title: "Info",
            description: "Could not locate the text in the editor",
          });
          return;
        }

        // Create and apply selection
        try {
          const range = document.createRange();
          range.setStart(startNode, Math.max(0, startOffset));
          range.setEnd(endNode, Math.min(endNode.length, endOffset));

          const selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
          }

          // Scroll into view
          startNode.parentElement?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });

          toast({
            title: "Success",
            description: "Comment text highlighted",
            duration: 2000,
          });
        } catch (error) {
          console.error("Error creating selection:", error);
          startNode.parentElement?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }
      } catch (error) {
        console.error("Error navigating to comment:", error);
        toast({
          title: "Error",
          description: "Failed to navigate to comment",
          variant: "destructive",
        });
      }
    }
  };

  useEffect(() => {
    const fetchData = async () => {
      // Check cache first - in-memory cache (fastest)
      let cached = articleCacheRef.current[projectId];
      const now = Date.now();
      const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

      // If not in memory, check sessionStorage (survives navigation)
      if (!cached) {
        const sessionCached = sessionStorage.getItem(`article_cache_${projectId}`);
        if (sessionCached) {
          try {
            cached = JSON.parse(sessionCached);
            console.log("📱 Restored article from sessionStorage cache");
          } catch (err) {
            console.error("Error parsing cached article:", err);
            sessionStorage.removeItem(`article_cache_${projectId}`);
          }
        }
      }

      let found: ArticleOutline | null = null;

      if (cached && (now - cached.timestamp) < CACHE_DURATION) {
        console.log("⚡ Using cached article data (skipping fetch)");
        found = cached.data;
      } else {
        console.log("📡 Fetching fresh article data from Supabase...");
        found = await getArticleOutlineById(projectId);

        // Cache the article in both memory and sessionStorage
        if (found) {
          const cacheData = {
            data: found,
            timestamp: now,
          };
          articleCacheRef.current[projectId] = cacheData;

          // Store in sessionStorage for navigation persistence
          try {
            sessionStorage.setItem(`article_cache_${projectId}`, JSON.stringify(cacheData));
          } catch (err) {
            console.warn("Could not cache to sessionStorage:", err);
          }
        }
      }

      if (found) {
        // Ensure receivedArticle is initialized even if it doesn't have content yet
        if (!found.receivedArticle) {
          found.receivedArticle = {
            content: "",
            title: undefined,
            meta: undefined,
            receivedAt: new Date().toISOString(),
          };
        }

        if (found.receivedArticle?.content) {
          const hasTitle = found.receivedArticle?.title?.trim();
          const hasMeta = found.receivedArticle?.meta?.trim();
          const content = found.receivedArticle.content;

          if (!hasTitle || !hasMeta) {
            const { first, second, cleanedHtml } =
              extractFirstTwoParagraphsAndClean(content);

            const updatedArticle = { ...found.receivedArticle };

            if (!hasTitle && first) {
              updatedArticle.title = first.substring(0, 70);
              console.log("✅ Extracted title from content");
            }

            if (!hasMeta && second) {
              updatedArticle.meta = second.substring(0, 156);
              console.log("✅ Extracted meta description from content");
            }

            if (!hasTitle || !hasMeta) {
              updatedArticle.content = cleanedHtml;
              console.log(
                "✅ Cleaned article content (removed first two sections)",
              );
            }

            found.receivedArticle = updatedArticle;
          }
        }
      }

      setOutline(found);

      // Only fetch client folders once per session (they rarely change)
      if (!clientFoldersCachedRef.current) {
        console.log("📂 Fetching client folders (first time this session)...");
        try {
          const folders = await getClientFolders();
          clientFoldersCachedRef.current = folders;
          setClientFolders(folders);
        } catch (err) {
          console.error("Error fetching client folders:", err);
        }
      } else {
        console.log("📂 Using cached client folders");
        setClientFolders(clientFoldersCachedRef.current);
      }
    };
    fetchData();
  }, [projectId]);

  // Initialize page configuration when article outline loads
  useEffect(() => {
    if (!outline) return;

    console.log("📋 Initializing page config from outline:", {
      articleId: outline.id,
      "page-update-type": outline["page-update-type"],
      "page-url": outline["page-url"],
      hasPageUpdateType: !!outline["page-update-type"],
      hasPageUrl: !!outline["page-url"],
    });

    // Set page configuration from loaded outline
    const updateType = outline["page-update-type"] || "new";
    const url = outline["page-url"] || "";

    console.log("🔧 Setting page config state:", { updateType, url });

    setPageUpdateType(updateType as "new" | "update");
    setPageUrl(url);
  }, [outline?.id]); // Only re-initialize when article ID changes

  // NO AUTO-SAVE: Just backup page configuration to localStorage
  useEffect(() => {
    if (!outline || !outline.id) return;

    // Clear any pending save
    if (pageConfigTimeoutRef.current) {
      clearTimeout(pageConfigTimeoutRef.current);
    }

    // Debounce the backup to localStorage
    pageConfigTimeoutRef.current = setTimeout(() => {
      try {
        // Create updated outline with page configuration
        const updated = {
          ...outline,
          "page-update-type": pageUpdateType,
          "page-url": pageUpdateType === "update" ? pageUrl : "",
        };
        // Backup to localStorage only - no Supabase save
        const outlines = JSON.parse(localStorage.getItem("article_outlines") || "[]");
        const index = outlines.findIndex((o: ArticleOutline) => o.id === updated.id);
        if (index >= 0) {
          outlines[index] = updated;
        } else {
          outlines.push(updated);
        }
        localStorage.setItem("article_outlines", JSON.stringify(outlines));
        console.log("✅ Page configuration backed up to localStorage");
      } catch (error) {
        console.error("❌ Failed to back up page configuration:", error);
      }
    }, 500);

    return () => {
      if (pageConfigTimeoutRef.current) {
        clearTimeout(pageConfigTimeoutRef.current);
      }
    };
  }, [pageUpdateType, pageUrl, outline?.id]);

  // Poll for article updates if not yet received
  // Poll for initial content only — once content exists, polling stops (line 659)
  // and autosave takes over as the single source of truth
  useEffect(() => {
    if (!projectId || outline?.receivedArticle?.content) return;

    let pollInterval: NodeJS.Timeout | null = null;
    let pollCount = 0;
    let consecutiveErrors = 0;
    let mounted = true;
    let hasContent = false;

    const checkForUpdate = async () => {
      pollCount++;
      try {
        const updated = await getArticleOutlineById(projectId);
        if (updated && mounted) {
          // Reset error counter on successful fetch
          consecutiveErrors = 0;

          // Ensure receivedArticle is initialized even if it doesn't have content yet
          if (!updated.receivedArticle) {
            updated.receivedArticle = {
              content: "",
              title: undefined,
              meta: undefined,
              receivedAt: new Date().toISOString(),
            };
          }

          console.log(
            `[ArticleEditor Poll #${pollCount}] Update received for ID: ${projectId}`,
            {
              hasReceivedArticle: !!updated.receivedArticle,
              contentLength: updated.receivedArticle?.content?.length || 0,
            },
          );

          // Extract metadata if needed
          if (updated.receivedArticle?.content) {
            const hasTitle = updated.receivedArticle?.title?.trim();
            const hasMeta = updated.receivedArticle?.meta?.trim();
            const content = updated.receivedArticle.content;

            if (!hasTitle || !hasMeta) {
              const { first, second, cleanedHtml } =
                extractFirstTwoParagraphsAndClean(content);
              const updatedArticle = { ...updated.receivedArticle };

              if (!hasTitle && first) {
                updatedArticle.title = first.substring(0, 70);
              }
              if (!hasMeta && second) {
                updatedArticle.meta = second.substring(0, 156);
              }
              if (!hasTitle || !hasMeta) {
                updatedArticle.content = cleanedHtml;
              }
              updated.receivedArticle = updatedArticle;
            }
          }

          // Merge polling updates with local user edits
          setOutline((prevOutline) => {
            if (!prevOutline) return updated;
            if (!prevOutline.receivedArticle) return updated;

            // Only update if this is truly a new update from Supabase
            // Preserve user's edits to title and meta that may have occurred since last fetch
            return {
              ...updated,
              receivedArticle: {
                ...updated.receivedArticle,
                // Keep user's local title if it differs from Supabase version
                title: prevOutline.receivedArticle.title,
                // Keep user's local meta if it differs from Supabase version
                meta: prevOutline.receivedArticle.meta,
              },
            };
          });

          // Stop polling once content is received
          if (updated.receivedArticle?.content && !hasContent) {
            hasContent = true;
            if (pollInterval) {
              console.log(
                `[ArticleEditor Poll] Content received, stopping polling after ${pollCount} attempts`,
              );
              clearInterval(pollInterval);
              pollInterval = null;
            }
          }
        }
      } catch (error) {
        if (mounted) {
          consecutiveErrors++;

          // Don't log errors during polling - transient network errors are expected
          // Just silently retry on the next interval

          // Stop polling if we hit 15 consecutive errors (indicates persistent issue)
          if (consecutiveErrors > 15) {
            console.warn(
              `[ArticleEditor Poll] Stopping polling after ${consecutiveErrors} consecutive errors`,
            );
            if (pollInterval) clearInterval(pollInterval);
          }
        }
      }
    };

    const startPolling = async () => {
      await waitForConnectionCheck();
      if (!mounted) return;

      console.log(
        `ArticleEditor: Starting polling for article ID: ${projectId}`,
      );
      checkForUpdate();

      // Use 3-5 second polling interval to reduce network stress
      // Polling too frequently causes "Failed to fetch" errors
      const pollFrequency = isSupabaseAvailable() ? 3000 : 5000;
      console.log(
        `[ArticleEditor Poll] Using polling interval: ${pollFrequency}ms`,
      );
      pollInterval = setInterval(checkForUpdate, pollFrequency);
    };

    startPolling();

    return () => {
      mounted = false;
      if (pollCount > 0) {
        console.log(
          `ArticleEditor: Stopping polling after ${pollCount} attempts`,
        );
      }
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    };
  }, [projectId]);

  // Fetch article revisions
  useEffect(() => {
    if (outline?.articleId) {
      const fetchRevisions = async () => {
        try {
          const revisionsList = await getArticleRevisions(outline.articleId);
          setRevisions(revisionsList);
        } catch (error) {
          // Silently handle error - revisions are optional
          setRevisions([]);
        }
      };
      fetchRevisions();
    }
  }, [outline?.articleId]);

  // Cleanup autosave timeout on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, []);

  // Canary: detect "user is editing but no save has succeeded" — the failure
  // mode that ate Jose's work in the June 2026 phantom-write incident. Runs
  // every 30s while the editor is mounted. If we see ≥3 edits but zero
  // successful autosaves AND it's been ≥60s since the article loaded, send
  // exactly one telemetry beacon (per editor session) so it surfaces fast
  // next time the autosave call site silently breaks.
  useEffect(() => {
    const sessionStartedAt = Date.now();
    const intervalId = setInterval(() => {
      if (editsWithoutSavesReportedRef.current) return;
      if (Date.now() - sessionStartedAt < 60_000) return;
      const edits = editCountRef.current;
      const saves = autosaveSuccessCountRef.current;
      if (edits >= 3 && saves === 0) {
        editsWithoutSavesReportedRef.current = true;
        sendAutosaveTelemetry("edits_without_saves", {
          articleId: outline?.articleId,
          details: {
            edits_recorded: edits,
            saves_recorded: saves,
            seconds_since_load: Math.round(
              (Date.now() - sessionStartedAt) / 1000,
            ),
          },
        });
        console.warn(
          `[autosave canary] ${edits} edits recorded but 0 successful saves in ${Math.round((Date.now() - sessionStartedAt) / 1000)}s — telemetry beacon sent`,
        );
      }
    }, 30_000);
    return () => clearInterval(intervalId);
  }, [outline?.articleId]);

  // Warn on page-leave if there are unsaved or in-flight edits. The browser
  // forces a generic "Changes you made may not be saved" dialog — the exact
  // text isn't customizable in modern browsers, but the prompt itself is
  // what we need to prevent silent loss when a user closes the tab during
  // the autosave debounce window.
  useEffect(() => {
    const hasPendingWork =
      autoSaveStatus === "unsaved" ||
      autoSaveStatus === "saving" ||
      autoSaveStatus === "error";
    if (!hasPendingWork) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [autoSaveStatus]);

  // Listen for copy events
  useEffect(() => {
    const handleArticleCopied = () => {
      toast({
        title: "✓ Copied",
        description: "Article copied to clipboard",
        duration: 3000,
      });
    };

    const handleArticleCopyFailed = () => {
      toast({
        title: "Error",
        description: "Failed to copy article",
        duration: 3000,
      });
    };

    window.addEventListener("article-copied", handleArticleCopied);
    window.addEventListener("article-copy-failed", handleArticleCopyFailed);

    return () => {
      window.removeEventListener("article-copied", handleArticleCopied);
      window.removeEventListener(
        "article-copy-failed",
        handleArticleCopyFailed,
      );
    };
  }, [toast]);

  // Preserve UI state in sessionStorage when it changes
  useEffect(() => {
    sessionStorage.setItem("editor_isNavHidden", JSON.stringify(isNavHidden));
    sessionStorage.setItem("editor_showHistory", JSON.stringify(showHistory));
    sessionStorage.setItem("editor_isEditFocus", JSON.stringify(isEditFocus));
    sessionStorage.setItem(
      "editor_isCommentsOpen",
      JSON.stringify(isCommentsOpen),
    );
  }, [isNavHidden, showHistory, isEditFocus, isCommentsOpen]);

  // Perform autosave (actually saves to the server)
  const performAutoSave = useCallback(
    async (dataToSave: ArticleOutline) => {
      try {
        const htmlContent = dataToSave.receivedArticle?.content || "";

        if (!dataToSave.id) {
          throw new Error("Article ID is missing. Cannot save.");
        }

        // Calculate metrics
        const wordCount = calculateWordCount(htmlContent);
        const fleschData = calculateFleschScore(htmlContent);

        console.log("📝 Starting autosave for article:", {
          id: dataToSave.id,
          contentLength: htmlContent.length,
          wordCount,
          fleschScore: fleschData.scoreRounded,
          hasTitle: !!dataToSave.receivedArticle?.title,
          hasMeta: !!dataToSave.receivedArticle?.meta,
          timestamp: new Date().toISOString(),
        });

        // Prepare updated data with calculated metrics
        // Keep schema from Supabase - don't regenerate it
        const updated = {
          ...dataToSave,
          "word count": wordCount,
          "flesch score": `${fleschData.scoreRounded} - ${fleschData.readability}`,
          "page-update-type": pageUpdateType,
          "page-url": pageUpdateType === "update" ? pageUrl : "",
          updatedAt: new Date().toISOString(),
        };

        // Save directly to Supabase (single source of truth)
        // This is simpler and avoids race conditions with Netlify function
        console.log("💾 Saving directly to Supabase...");
        await saveArticleOutline(updated);
        console.log("✅ Supabase save successful");

        // DO NOT call setOutline(updated) here!
        // The outline state is already updated in real-time by the change handlers
        // (handleArticleTitleChange, handleArticleDescriptionChange, etc.)
        // Calling setOutline here can overwrite user's latest changes if they're typing
        // during the save operation, causing the glitching effect.

        // Only update the calculated metrics (word count, flesch score) in the outline
        // without overwriting the user's edited fields
        setOutline((current) => {
          if (!current) return current;
          return {
            ...current,
            "word count": wordCount,
            "flesch score": `${fleschData.scoreRounded} - ${fleschData.readability}`,
            // Keep schema from Supabase - don't regenerate it
            updatedAt: new Date().toISOString(),
          };
        });

        setAutoSaveStatus("saved");
        setLastSavedAt(new Date());
        autosaveSuccessCountRef.current += 1;
        console.log("✨ Article saved successfully");

        // Update the article cache with the fresh save
        if (dataToSave.id) {
          articleCacheRef.current[dataToSave.id] = {
            data: dataToSave,
            timestamp: Date.now(),
          };
        }

        // Don't fetch revisions on autosave - only fetch when user clicks History button
        // This significantly speeds up autosave by avoiding an extra API call

        // Clear "saved" indicator after 2 seconds of no changes
        setTimeout(() => setAutoSaveStatus("idle"), 2000);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error("❌ Error during autosave:", errorMessage);
        setAutoSaveStatus("error");
        // Telemetry: log the failure so we have a record of how often
        // autosave fails in the wild and why. Fire-and-forget.
        sendAutosaveTelemetry("save_error", {
          articleId: dataToSave.articleId,
          errorMessage,
          details: {
            outline_id: dataToSave.id,
            content_length: dataToSave.receivedArticle?.content?.length ?? 0,
          },
        });
        toast({
          title: "Save Failed",
          description: `Could not save changes: ${errorMessage}. Please try again or contact support if this persists.`,
          variant: "destructive",
          duration: 7000,
        });
        setTimeout(() => setAutoSaveStatus("idle"), 5000);
      }
    },
    [toast, pageUpdateType, pageUrl],
  );

  // ──────────────────────────────────────────────────────────────────────
  // AUTOSAVE — DO NOT DISCONNECT
  //
  // `triggerAutoSave` MUST be called from every content/title/meta change
  // handler. If you find yourself adding "NO AUTO-SAVE" comments or removing
  // the triggerAutoSave() call from a change handler, STOP. That exact
  // pattern caused the June 2026 phantom-write incident — editor work was
  // silently lost for ~3 months because the call site had been disconnected
  // (Builder.io commit 081aef9, 2026-03-04, no documented reason).
  //
  // The infrastructure (this function, performAutoSave, the indicator state,
  // the beforeunload guard, the canary telemetry beacon) only works when the
  // change handlers actually call this function. The autosave_telemetry
  // table + canary effect above will surface a regression within ~60s of an
  // editor session if you break this contract — but don't rely on that.
  // Verify by typing in the editor and watching for a network request to
  // /rest/v1/article_outlines within ~1 second.
  // ──────────────────────────────────────────────────────────────────────
  const triggerAutoSave = useCallback(
    (dataToSave: ArticleOutline) => {
      // Don't auto-save if article doesn't have an ID yet
      if (!dataToSave.id) {
        return;
      }

      // Flip to "unsaved" the moment an edit comes in — before the debounce
      // delay. Without this the indicator would stay on "Saved" for the full
      // 1-second debounce window, masking the fact that pending work hasn't
      // been persisted yet. (Surfaced by the June 2026 silent-save-loss
      // incident — editor couldn't tell their edits hadn't been captured.)
      setAutoSaveStatus("unsaved");
      editCountRef.current += 1;

      // Store the latest data in ref
      autoSaveDataRef.current = dataToSave;

      // Clear existing timeout
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }

      // Set new timeout - save after 1 second of inactivity
      autoSaveTimeoutRef.current = setTimeout(() => {
        if (autoSaveDataRef.current) {
          setAutoSaveStatus("saving");
          performAutoSave(autoSaveDataRef.current);
        }
      }, 1000);
    },
    [performAutoSave],
  );

  // Define all hooks BEFORE any early returns
  const handleClientNameChange = (value: string) => {
    const selectedFolder = clientFolders.find((f) => f.name === value);
    setOutline((prev) =>
      prev
        ? {
            ...prev,
            clientName: value,
            clientId: selectedFolder?.client_id || prev.clientId,
          }
        : null,
    );
  };

  const handleKeywordChange = (value: string) => {
    setOutline((prev) => (prev ? { ...prev, keyword: value } : null));
  };

  const handleSectionChange = (
    sectionId: string,
    field: "title" | "description",
    value: string,
  ) => {
    setOutline((prev) =>
      prev
        ? {
            ...prev,
            sections: prev.sections.map((s) =>
              s.id === sectionId ? { ...s, [field]: value } : s,
            ),
          }
        : null,
    );
  };

  const handleArticleContentChange = useCallback(
    (value: string) => {
      setOutline((prev) => {
        const updated = prev
          ? {
              ...prev,
              receivedArticle: prev.receivedArticle
                ? { ...prev.receivedArticle, content: value }
                : { content: value, receivedAt: new Date().toISOString() },
            }
          : null;
        if (updated) {
          // Local backup (fast, synchronous fallback).
          try {
            const outlines = JSON.parse(localStorage.getItem("article_outlines") || "[]");
            const index = outlines.findIndex((o: ArticleOutline) => o.id === updated.id);
            if (index >= 0) {
              outlines[index] = updated;
            } else {
              outlines.push(updated);
            }
            localStorage.setItem("article_outlines", JSON.stringify(outlines));
          } catch (error) {
            console.error("Error backing up to localStorage:", error);
          }
          // Fire autosave (debounced inside triggerAutoSave). The system was
          // built end-to-end (triggerAutoSave → performAutoSave → Supabase)
          // but the call site had been replaced with a "NO AUTO-SAVE" comment
          // at some point, leaving the indicator and beforeunload guard dead
          // and editor edits silently failing to persist unless the user hit
          // the manual Save button. See PR #70 / June 2026 phantom-write
          // incident for the audit.
          triggerAutoSave(updated);
        }
        return updated;
      });
    },
    [triggerAutoSave],
  );

  const handleArticleTitleChange = useCallback(
    (value: string) => {
      setOutline((prev) => {
        const updated = prev
          ? {
              ...prev,
              receivedArticle: prev.receivedArticle
                ? { ...prev.receivedArticle, title: value }
                : {
                    content: "",
                    title: value,
                    receivedAt: new Date().toISOString(),
                  },
            }
          : null;
        if (updated) {
          try {
            const outlines = JSON.parse(localStorage.getItem("article_outlines") || "[]");
            const index = outlines.findIndex((o: ArticleOutline) => o.id === updated.id);
            if (index >= 0) {
              outlines[index] = updated;
            } else {
              outlines.push(updated);
            }
            localStorage.setItem("article_outlines", JSON.stringify(outlines));
          } catch (error) {
            console.error("Error backing up to localStorage:", error);
          }
          triggerAutoSave(updated);
        }
        return updated;
      });
    },
    [triggerAutoSave],
  );

  const handleArticleDescriptionChange = useCallback(
    (value: string) => {
      setOutline((prev) => {
        const updated = prev
          ? {
              ...prev,
              receivedArticle: prev.receivedArticle
                ? { ...prev.receivedArticle, meta: value }
                : {
                    content: "",
                    meta: value,
                    receivedAt: new Date().toISOString(),
                  },
            }
          : null;
        if (updated) {
          try {
            const outlines = JSON.parse(localStorage.getItem("article_outlines") || "[]");
            const index = outlines.findIndex((o: ArticleOutline) => o.id === updated.id);
            if (index >= 0) {
              outlines[index] = updated;
            } else {
              outlines.push(updated);
            }
            localStorage.setItem("article_outlines", JSON.stringify(outlines));
          } catch (error) {
            console.error("Error backing up to localStorage:", error);
          }
          triggerAutoSave(updated);
        }
        return updated;
      });
    },
    [triggerAutoSave],
  );

  const handleSchemaChange = useCallback((schema: string) => {
    // Update local state and save to Supabase
    setOutline((prev) => {
      if (!prev) return null;
      const updated = { ...prev, schema };

      // Save to Supabase
      saveArticleOutline(updated).catch((err) => {
        console.error("Error saving schema:", err);
      });

      return updated;
    });

    setShowSchemaModal(false);
  }, []);

  const handlePageUpdateTypeChange = (type: "new" | "update") => {
    setPageUpdateType(type);
    // Clear page URL when switching to "new"
    if (type === "new") {
      setPageUrl("");
    }
  };

  const handlePageUrlChange = (value: string) => {
    setPageUrl(value);
  };

  const handleExportHtml = useCallback(() => {
    if (!outline || !outline.receivedArticle?.content) {
      toast({
        title: "No content to export",
        description: "The article content is not ready yet.",
        variant: "destructive",
      });
      return;
    }

    const title = outline.receivedArticle.title || outline.keyword || "Article";
    const description = outline.receivedArticle.meta || "";
    const sanitizedTitle = escapeHtmlAttribute(title);
    const sanitizedDescription = description
      ? escapeHtmlAttribute(description)
      : "";
    const htmlBody = outline.receivedArticle.content;

    const htmlDocument = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${sanitizedTitle}</title>
  ${sanitizedDescription ? `<meta name="description" content="${sanitizedDescription}" />` : ""}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #333; line-height: 1.6; }
    .metadata { padding: 40px 60px 0 60px; max-width: 900px; margin: 0 auto; }
    .keyword-id-box { border: 2px solid #333; border-radius: 12px; padding: 16px; margin-bottom: 30px; font-size: 14px; font-weight: 500; }
    .keyword-id-row { padding: 6px 0; }
    .keyword-id-row:not(:last-child) { border-bottom: 1px solid #ddd; }
    .field-section { margin-bottom: 25px; }
    .field-label { font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; font-size: 11px; color: #666; margin-bottom: 8px; }
    .field-value { font-size: 16px; color: #333; }
    .divider { border-top: 1px solid #333; margin: 30px 0 0 0; }
    .article-content { max-width: 900px; margin: 0 auto; margin-top: 0; padding: 0 60px 40px; }
    .article-content h1 { font-size: 32px; font-weight: 700; margin-top: 0; margin-bottom: 20px; line-height: 1.3; }
    .article-content h2 { font-size: 24px; font-weight: 600; margin-top: 30px; margin-bottom: 15px; }
    .article-content h3 { font-size: 20px; font-weight: 600; margin-top: 25px; margin-bottom: 12px; }
    .article-content h4 { font-size: 16px; font-weight: 600; margin-top: 20px; margin-bottom: 10px; }
    .article-content p { margin-bottom: 15px; }
    .article-content ul, .article-content ol { margin-left: 20px; margin-bottom: 15px; }
    .article-content li { margin-bottom: 8px; }
  </style>
</head>
<body>
<div class="metadata">
  <div class="keyword-id-box">
    <div class="keyword-id-row"><strong>Keyword:</strong> ${outline.keyword || ""}</div>
    <div class="keyword-id-row"><strong>ID:</strong> ${outline.articleId || ""}</div>
  </div>

  <div class="field-section">
    <div class="field-label">Title</div>
    <h1 style="all: revert; font-size: 28px; font-weight: 700; margin: 5px 0 0 0; color: #333;">${title}</h1>
  </div>

  <div class="field-section">
    <div class="field-label">Description</div>
    <h4 style="all: revert; font-size: 16px; font-weight: 600; margin: 5px 0 0 0; color: #333;">${description}</h4>
  </div>

  <div class="divider"></div>
</div>

<div class="article-content">
${htmlBody}
</div>

</body>
</html>`;

    const blob = new Blob([htmlDocument], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${buildFileName(
      outline.keyword || outline.articleId || outline.clientName || "article",
    )}.html`;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    toast({
      title: "Exported HTML",
      description: "Downloaded HTML version of the article.",
    });
  }, [outline, toast]);

  // Now safe to have early return
  if (!outline) {
    return (
      <div className="w-full h-full overflow-hidden">
        <LoadingIndicator
          title="Generating Article"
          description="Meerkat is creating your article content. This typically takes 1-3 minutes. You'll see the article appear here as soon as it's ready."
        />
      </div>
    );
  }

  const handleRestoreRevision = async (revision: ArticleRevision) => {
    if (!outline) return;

    setIsRestoringRevision(true);
    try {
      const updated = {
        ...outline,
        receivedArticle: outline.receivedArticle
          ? {
              ...outline.receivedArticle,
              content: revision.html_content,
            }
          : {
              content: revision.html_content,
              receivedAt: new Date().toISOString(),
            },
        updatedAt: new Date().toISOString(),
      };

      const response = await fetch("/.netlify/functions/update-article", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: outline.id,
          html_content: revision.html_content,
          received_article: updated.receivedArticle || {},
          create_revision: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to restore revision (HTTP ${response.status})`);
      }

      await saveArticleOutline(updated);
      setOutline(updated);
      setSelectedRevision(null);

      toast({
        title: "✓ Revision Restored",
        description: `Article restored to version ${revision.version_number}`,
        duration: 3000,
      });

      // Refresh revisions
      const revisionsList = await getArticleRevisions(outline.articleId);
      setRevisions(revisionsList);
      onUpdate();
    } catch (error) {
      console.error("Error restoring revision:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to restore revision",
      });
    } finally {
      setIsRestoringRevision(false);
    }
  };

  const handleSave = async () => {
    if (!outline) return;

    setIsSaving(true);
    // Cancel any pending autosave
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
    }

    try {
      const htmlContent = outline.receivedArticle?.content || "";

      // Calculate metrics
      const wordCount = calculateWordCount(htmlContent);
      const fleschData = calculateFleschScore(htmlContent);

      console.log("💾 Manual save started for article:", {
        outlineId: outline.id,
        articleId: outline.articleId,
        contentLength: htmlContent.length,
        wordCount,
        fleschScore: fleschData.scoreRounded,
      });

      // Keep schema from Supabase - don't regenerate it
      const updated = {
        ...outline,
        "word count": wordCount,
        "flesch score": `${fleschData.scoreRounded} - ${fleschData.readability}`,
        "page-update-type": pageUpdateType,
        "page-url": pageUpdateType === "update" ? pageUrl : "",
        updatedAt: new Date().toISOString(),
      };

      // Save to both localStorage AND Supabase
      // saveArticleOutline will handle both automatically
      console.log("💾 Saving article...");
      await saveArticleOutline(updated);
      console.log("✅ Save completed (localStorage + Supabase)");

      // Update the outline with calculated metrics without overwriting user edits
      // This matches the pattern used in performAutoSave
      setOutline((current) => {
        if (!current) return current;
        return {
          ...current,
          "word count": wordCount,
          "flesch score": `${fleschData.scoreRounded} - ${fleschData.readability}`,
          // Keep schema from Supabase - don't regenerate it
          "page-update-type": pageUpdateType,
          "page-url": pageUpdateType === "update" ? pageUrl : "",
          updatedAt: new Date().toISOString(),
        };
      });

      setAutoSaveStatus("saved");
      setSaveMessage("✅ All changes saved successfully!");
      onUpdate();

      // IMPORTANT: Clear the sessionStorage cache after saving so next load pulls fresh data from localStorage
      // This ensures edits are loaded fresh from localStorage on the next visit
      console.log("🗑️ Clearing article cache to force fresh load from localStorage");
      if (outline?.id) {
        try {
          sessionStorage.removeItem(`article_cache_${outline.id}`);
          delete articleCacheRef.current[outline.id];
        } catch (err) {
          console.warn("Could not clear cache:", err);
        }
      }
      if (projectId) {
        try {
          sessionStorage.removeItem(`article_cache_${projectId}`);
          delete articleCacheRef.current[projectId];
        } catch (err) {
          console.warn("Could not clear cache:", err);
        }
      }

      // Don't fetch revisions on manual save either - only fetch when user clicks History button
      // This significantly speeds up the save operation by avoiding an extra API call
      // Revisions will be loaded lazily when needed

      // Keep "Saved" status showing for 5 seconds before going back to "Saved" (idle shows checkmark)
      // This gives users better feedback that their save was successful
      setTimeout(() => {
        setAutoSaveStatus("idle");
        setSaveMessage("");
      }, 5000);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("❌ Manual save error:", errorMessage);
      setSaveMessage(
        `❌ Save failed: ${errorMessage}. Please try again or contact support.`,
      );
      setAutoSaveStatus("error");
      toast({
        title: "Save Failed",
        description: errorMessage,
        variant: "destructive",
        duration: 7000,
      });
      setTimeout(() => setAutoSaveStatus("idle"), 5000);
    } finally {
      setIsSaving(false);
    }
  };

  const handleResubmit = async () => {
    if (!outline) return;

    setIsResubmitting(true);
    try {
      const result = await sendOutlineToWebhook(outline);

      if (result.status === "success") {
        const updatedOutline = {
          ...outline,
          webhookSent: true,
          updatedAt: new Date().toISOString(),
        };
        await saveArticleOutline(updatedOutline);
        setOutline(updatedOutline);

        toast({
          title: "✓ Outline Resubmitted",
          description: `"${outline.keyword}" has been sent to the webhook.`,
        });
      } else if (result.status === "validation_failed") {
        toast({
          title: "⚠ Validation Failed",
          description: `Errors: ${result.errors?.map((e) => e.message).join(", ") || "Unknown error"}`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "✗ Error",
          description:
            result.errors?.[0]?.message || "Failed to resubmit outline",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "✗ Error",
        description:
          error instanceof Error ? error.message : "Failed to resubmit outline",
        variant: "destructive",
      });
    } finally {
      setIsResubmitting(false);
    }
  };

  if (isEditFocus) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-background">
        {/* Edit Focus Header */}
        <div
          className={`bg-background px-6 py-4 border-b border-border/30 flex items-center justify-between transition-all duration-200 ${isCommentsOpen ? "pr-80" : ""}`}
        >
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsEditFocus(false)}
              className="flex items-center justify-center p-1 rounded hover:bg-secondary transition-colors"
              title="Go back to normal view"
            >
              <ArrowLeft className="w-5 h-5 text-muted-foreground hover:text-foreground" />
            </button>
            <h2 className="font-heading text-xl font-bold text-foreground">
              {outline.clientName} - {outline.keyword}
            </h2>
          </div>
          <div className="flex items-center gap-3">
            {/* View Mode Buttons */}
            <>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs hover:bg-purple-200 hover:text-purple-800 transition-colors"
                  onClick={() => navigate(`/editor/${projectId}/seo`)}
                  title="SEO View - Official front page"
                >
                  SEO View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs hover:bg-purple-200 hover:text-purple-800 transition-colors"
                  onClick={() => {
                    setCurrentView("edit");
                    setIsEditFocus(true);
                  }}
                  title="Edit View - Expanded editing mode"
                >
                  Edit View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs hover:bg-purple-200 hover:text-purple-800 transition-colors"
                  onClick={() => {
                    setCurrentView("public");
                    outline && navigate("/dev-view", { state: { outline } });
                  }}
                  title="Public View - Public page view"
                >
                  Public View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs hover:bg-purple-200 hover:text-purple-800 transition-colors"
                  onClick={() => {
                    setCurrentView("client");
                    outline && navigate("/client-view", { state: { outline } });
                  }}
                  title="Client View - Client facing view"
                >
                  Client View
                </Button>
              </div>
              <div className="h-6 w-px bg-border/30" />
            </>
            {/* Existing Controls */}
            <Button
              onClick={async () => {
                // Load revisions lazily when user clicks history button
                if (!showHistory && revisions.length === 0 && outline?.articleId) {
                  try {
                    console.log("📚 Loading revision history on demand...");
                    const revisionsList = await getArticleRevisions(outline.articleId);
                    setRevisions(revisionsList);
                    console.log("✅ Revisions loaded:", { count: revisionsList.length });
                  } catch (err) {
                    console.error("❌ Failed to load revisions:", err);
                  }
                }
                setShowHistory(!showHistory);
              }}
              variant="ghost"
              size="sm"
              className="gap-2 hover:bg-secondary"
              title="View edit history"
            >
              <Clock className="w-4 h-4" />
              <span className="text-xs text-muted-foreground">
                {revisions.length} version{revisions.length !== 1 ? "s" : ""}
              </span>
            </Button>
            {/* Save Status Indicator */}
            <div className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
              {autoSaveStatus === "unsaved" && (
                <>
                  <Circle className="w-3 h-3 text-amber-600 fill-amber-500" />
                  <span className="text-amber-700 font-medium">Unsaved changes</span>
                </>
              )}
              {autoSaveStatus === "saving" && (
                <>
                  <Loader2 className="w-3 h-3 animate-spin text-blue-600" />
                  <span className="text-blue-600 font-medium">Saving...</span>
                </>
              )}
              {(autoSaveStatus === "saved" || autoSaveStatus === "idle") && (
                <>
                  <CheckCircle2 className="w-3 h-3 text-green-600" />
                  <span className="text-green-600 font-medium">
                    {lastSavedAt
                      ? `Saved at ${formatSavedAt(lastSavedAt)}`
                      : "Saved"}
                  </span>
                </>
              )}
              {autoSaveStatus === "error" && (
                <>
                  <AlertCircle className="w-3 h-3 text-red-600" />
                  <span className="text-red-600 font-medium">Save failed — retry</span>
                </>
              )}
            </div>
            {outline && (
              <TranslationControls
                outline={outline}
                onLanguageChange={setActiveLanguage}
                activeLanguage={activeLanguage}
              />
            )}
            <Button
              onClick={() => setIsCommentsOpen(!isCommentsOpen)}
              variant={isCommentsOpen ? "default" : "outline"}
              size="sm"
              className="h-8 w-8 p-0"
              title="Comments"
            >
              <MessageCircle className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Edit Focus Content */}
        <div
          className={`flex-1 overflow-hidden flex relative transition-all duration-200 ${isCommentsOpen ? "pr-80" : ""}`}
        >
          {/* Headings Navigator */}
          <HeadingsNavigator
            content={stripMetadataFromContent(
              outline.receivedArticle?.content || "",
            )}
            editorRef={contentEditorRef}
            isHidden={isNavHidden}
            onHiddenChange={setIsNavHidden}
          />

          {/* Editor Container */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Content Editor with Document Padding */}
            <div className="flex-1 overflow-hidden flex justify-center">
              <div className="w-full max-w-4xl px-12 overflow-y-auto">
                {activeLanguage && outline.translations?.[activeLanguage]?.content ? (
                  <div
                    className="article-content prose prose-sm max-w-none py-8"
                    dangerouslySetInnerHTML={{
                      __html: outline.translations[activeLanguage].content!,
                    }}
                  />
                ) : outline.receivedArticle ? (
                  <ContentEditor
                    ref={contentEditorRef}
                    initialContent={stripMetadataFromContent(
                      outline.receivedArticle.content || "",
                    )}
                    initialTitle={outline.receivedArticle.title || ""}
                    initialDescription={outline.receivedArticle.meta || ""}
                    onContentChange={handleArticleContentChange}
                    onTitleChange={handleArticleTitleChange}
                    onDescriptionChange={handleArticleDescriptionChange}
                    showMetadataByDefault={false}
                    onSchemaClick={() => setShowSchemaModal(true)}
                    onShowNavigation={() => setIsNavHidden(false)}
                    isNavigationHidden={isNavHidden}
                    onSave={handleSave}
                    isSaveDisabled={isSaving}
                    articleKeyword={outline.keyword}
                    clientName={outline.clientName}
                    onExpand={() => setIsEditFocus(true)}
                    isEditFocus={isEditFocus}
                    onDevView={() =>
                      outline && navigate("/dev-view", { state: { outline } })
                    }
                    onClientView={() =>
                      outline &&
                      navigate("/client-view", { state: { outline } })
                    }
                    currentView={currentView}
                    onSeoView={() => navigate(`/editor/${projectId}/seo`)}
                    onEditView={() => {
                      setCurrentView("edit");
                      setIsEditFocus(true);
                    }}
                    onPublicView={() => {
                      setCurrentView("public");
                      outline && navigate("/dev-view", { state: { outline } });
                    }}
                    onClientViewClick={() => {
                      setCurrentView("client");
                      outline &&
                        navigate("/client-view", { state: { outline } });
                    }}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-foreground font-medium">
                      No article received yet
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* History Panel - Expand View */}
        {showHistory && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-end">
            <div className="bg-background w-96 h-full shadow-lg flex flex-col">
              <div className="border-b border-border/30 px-6 py-4 flex items-center justify-between">
                <h3 className="font-heading text-lg font-bold text-foreground flex items-center gap-2">
                  <Clock className="w-5 h-5" />
                  Version history ({revisions.length})
                </h3>
                <button
                  onClick={() => setShowHistory(false)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  title="Close"
                >
                  <ChevronDown className="w-5 h-5 rotate-90" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
                {revisions.length > 0 ? (
                  revisions.map((revision) => (
                    <div
                      key={revision.id}
                      className="border border-border/30 rounded-lg p-4 bg-card/50 hover:bg-card transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Clock className="w-4 h-4 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground">
                            Version {revision.version_number}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {formatLastEditTime(revision.created_at)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(revision.created_at).toLocaleString()}
                          </p>
                          <div className="flex gap-2 mt-3">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs h-7 px-2"
                              onClick={() => setSelectedRevision(revision)}
                            >
                              Preview
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs h-7 px-2"
                              onClick={() => handleRestoreRevision(revision)}
                              disabled={isRestoringRevision}
                            >
                              Restore
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8">
                    <p className="text-sm text-muted-foreground">
                      No versions yet. Save to create a version.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Comments Sidebar - Expand View */}
        <CommentsSidebar
          articleId={outline.articleId}
          currentUserEmail={outline.clientName}
          isOpen={isCommentsOpen}
          onClose={() => setIsCommentsOpen(false)}
          onCommentClick={handleCommentClick}
        />

        {/* Floating Comment Box - Expand View */}
        {showFloatingComment && selectedText && (
          <FloatingCommentBox
            articleId={outline.articleId}
            selectedText={selectedText}
            currentUserEmail={outline.clientName}
            onCommentAdded={() => setCommentsRefreshKey((prev) => prev + 1)}
            onClose={() => setShowFloatingComment(false)}
            position={selectedPosition || undefined}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div
        className={`bg-background px-6 py-4 border-b border-border/30 sticky top-0 z-40 transition-all duration-200 ${isCommentsOpen ? "pr-80" : ""}`}
      >
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center justify-center p-1 rounded hover:bg-secondary transition-colors flex-shrink-0"
            title="Back to client folder"
          >
            <ArrowLeft className="w-4 h-4 text-muted-foreground hover:text-foreground" />
          </button>
          <h2 className="font-heading text-xl font-bold text-foreground">
            {outline.clientName}
          </h2>
          <Button
            onClick={() => setShowHistory(!showHistory)}
            variant="ghost"
            size="sm"
            className="gap-2 ml-auto hover:bg-secondary"
            title="View edit history"
          >
            <Clock className="w-4 h-4" />
            <span className="text-xs text-muted-foreground">
              Last edit was {formatLastEditTime(outline.updatedAt)}
            </span>
          </Button>
          <div className="flex gap-2 items-center flex-shrink-0">
            {/* Always show save status indicator */}
            <div className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
              {autoSaveStatus === "unsaved" && (
                <>
                  <Circle className="w-3 h-3 text-amber-600 fill-amber-500" />
                  <span className="text-amber-700 font-medium">Unsaved changes</span>
                </>
              )}
              {autoSaveStatus === "saving" && (
                <>
                  <Loader2 className="w-3 h-3 animate-spin text-blue-600" />
                  <span className="text-blue-600 font-medium">Saving...</span>
                </>
              )}
              {(autoSaveStatus === "saved" || autoSaveStatus === "idle") && (
                <>
                  <CheckCircle2 className="w-3 h-3 text-green-600" />
                  <span className="text-green-600 font-medium">
                    {lastSavedAt
                      ? `Saved at ${formatSavedAt(lastSavedAt)}`
                      : "Saved"}
                  </span>
                </>
              )}
              {autoSaveStatus === "error" && (
                <>
                  <AlertCircle className="w-3 h-3 text-red-600" />
                  <span className="text-red-600 font-medium">Save failed — retry</span>
                </>
              )}
            </div>
            <TranslationControls
              outline={outline}
              onLanguageChange={setActiveLanguage}
              activeLanguage={activeLanguage}
            />
            <Button
              onClick={handleExportHtml}
              variant="outline"
              size="sm"
              disabled={!outline.receivedArticle?.content}
              className="gap-2"
            >
              <Download className="h-4 w-4" />
              Export HTML
            </Button>
            <Button
              onClick={() => setIsCommentsOpen(!isCommentsOpen)}
              variant={isCommentsOpen ? "default" : "outline"}
              size="sm"
              className="h-8 w-8 p-0"
              title="Comments"
            >
              <MessageCircle className="w-4 h-4" />
            </Button>
            <Button
              onClick={handleSave}
              size="sm"
              disabled={isSaving}
              className="gap-2 bg-primary hover:bg-primary/90"
            >
              <Save className="h-4 w-4" />
              {isSaving ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </div>

        {/* Three-Column SEO Section */}
        <div className="grid grid-cols-4 gap-4">
          {/* Column 1: Keyword, ID, and Score */}
          <div className="border-2 border-border rounded-lg p-4 bg-card">
            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Keyword
                </label>
                <p className="text-sm font-medium text-foreground mt-1">
                  {outline.keyword}
                </p>
              </div>
              <div className="border-t border-border pt-4">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Article ID
                </label>
                <p className="text-sm font-medium text-foreground mt-1">
                  {outline.articleId}
                </p>
              </div>
              <div className="border-t border-border pt-4">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Flesch Score
                </label>
                <p className="text-sm font-medium text-foreground mt-1">
                  {outline["flesch score"] !== undefined ? (
                    (() => {
                      const { bgColor, textColor } = getFleschScoreColor(
                        outline["flesch score"] as string,
                      );
                      return (
                        <span
                          className={`inline-block px-3 py-2 rounded-lg ${bgColor} ${textColor} text-sm font-semibold`}
                        >
                          {outline["flesch score"]}
                        </span>
                      );
                    })()
                  ) : (
                    <span className="inline-block px-2 py-1 rounded bg-gray-100 text-gray-800 text-xs font-medium">
                      —
                    </span>
                  )}
                </p>
              </div>
            </div>
          </div>

          {/* Column 2: Template, Word Count, and Date */}
          <div className="border-2 border-border rounded-lg p-4 bg-card">
            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Template
                </label>
                <p className="text-sm font-medium text-foreground mt-1">
                  {outline.template || "—"}
                </p>
              </div>
              <div className="border-t border-border pt-4">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Word Count
                </label>
                <p className="text-sm font-medium text-foreground mt-1">
                  {outline["word count"] ??
                    calculateWordCount(outline.receivedArticle?.content || "")}
                </p>
              </div>
              <div className="border-t border-border pt-4">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Date Created
                </label>
                <p className="text-sm font-medium text-foreground mt-1">
                  {new Date(outline.createdAt).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
            </div>
          </div>

          {/* Column 3: Title Tag & Meta Description Combined */}
          <div className="border-2 border-border rounded-lg p-4 bg-card">
            <div className="space-y-4">
              {/* Title Tag */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Title Tag
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {(outline.receivedArticle?.title || "").length}/70
                  </span>
                </div>
                <textarea
                  ref={(el) => {
                    if (el) {
                      setTimeout(() => {
                        el.style.height = "auto";
                        el.style.height = el.scrollHeight + "px";
                      }, 0);
                    }
                  }}
                  value={outline.receivedArticle?.title || ""}
                  onChange={(e) => {
                    handleArticleTitleChange(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = e.target.scrollHeight + "px";
                  }}
                  onInput={(e) => {
                    e.currentTarget.style.height = "auto";
                    e.currentTarget.style.height =
                      e.currentTarget.scrollHeight + "px";
                  }}
                  placeholder="Enter title"
                  rows={1}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none overflow-hidden"
                />
              </div>

              {/* Divider */}
              <div className="border-t border-border"></div>

              {/* Meta Description */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Meta Description
                  </label>
                  <span className="text-xs text-muted-foreground">
                    {(outline.receivedArticle?.meta || "").length}/156
                  </span>
                </div>
                <textarea
                  ref={(el) => {
                    if (el) {
                      setTimeout(() => {
                        el.style.height = "auto";
                        el.style.height = el.scrollHeight + "px";
                      }, 0);
                    }
                  }}
                  value={outline.receivedArticle?.meta || ""}
                  onChange={(e) => {
                    handleArticleDescriptionChange(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = e.target.scrollHeight + "px";
                  }}
                  onInput={(e) => {
                    e.currentTarget.style.height = "auto";
                    e.currentTarget.style.height =
                      e.currentTarget.scrollHeight + "px";
                  }}
                  placeholder="Enter description"
                  rows={1}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-none overflow-hidden"
                />
              </div>
            </div>
          </div>

          {/* Column 4: Page Configuration */}
          <div className="border-2 border-border rounded-lg p-4 bg-card">
            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Update Type
                </label>
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-3">
                    <input
                      type="radio"
                      id="page-update-new"
                      name="page-update-type"
                      value="new"
                      checked={pageUpdateType === "new"}
                      onChange={() => handlePageUpdateTypeChange("new")}
                      className="w-4 h-4 text-primary cursor-pointer"
                    />
                    <label
                      htmlFor="page-update-new"
                      className="text-sm font-medium text-foreground cursor-pointer"
                    >
                      New Page
                    </label>
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="radio"
                      id="page-update-update"
                      name="page-update-type"
                      value="update"
                      checked={pageUpdateType === "update"}
                      onChange={() => handlePageUpdateTypeChange("update")}
                      className="w-4 h-4 text-primary cursor-pointer"
                    />
                    <label
                      htmlFor="page-update-update"
                      className="text-sm font-medium text-foreground cursor-pointer"
                    >
                      Page Update
                    </label>
                  </div>
                </div>
              </div>

              {/* Page URL field - only show when "Page Update" is selected */}
              {pageUpdateType === "update" && (
                <div className="border-t border-border pt-4">
                  <label
                    htmlFor="page-url"
                    className="text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                  >
                    Page URL
                  </label>
                  <input
                    id="page-url"
                    type="text"
                    value={pageUrl}
                    onChange={(e) => handlePageUrlChange(e.target.value)}
                    placeholder="https://example.com/page-to-update"
                    className="w-full mt-2 rounded-md border border-primary bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  />
                  <p className="text-xs text-muted-foreground mt-2">
                    Enter the URL of the existing page that needs to be updated
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Content Editor with flex layout for sidebar */}
      <div
        className={`flex-1 overflow-hidden flex relative transition-all duration-200 ${isCommentsOpen ? "pr-80" : ""}`}
      >
        {/* Headings Navigator */}
        <HeadingsNavigator
          content={stripMetadataFromContent(
            outline.receivedArticle?.content || "",
          )}
          editorRef={contentEditorRef}
          isHidden={isNavHidden}
          onHiddenChange={setIsNavHidden}
        />

        {/* Editor Container */}
        <div className="flex-1 overflow-hidden flex flex-col">
          {activeLanguage && outline.translations?.[activeLanguage]?.content ? (
            <div className="flex-1 overflow-y-auto px-12 py-8">
              <div
                className="article-content prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{
                  __html: outline.translations[activeLanguage].content!,
                }}
              />
            </div>
          ) : outline.receivedArticle ? (
            <ContentEditor
              ref={contentEditorRef}
              initialContent={stripMetadataFromContent(
                outline.receivedArticle.content || "",
              )}
              initialTitle={outline.receivedArticle.title || ""}
              initialDescription={outline.receivedArticle.meta || ""}
              onContentChange={handleArticleContentChange}
              onTitleChange={handleArticleTitleChange}
              onDescriptionChange={handleArticleDescriptionChange}
              showMetadataByDefault={true}
              onSchemaClick={() => setShowSchemaModal(true)}
              onShowNavigation={() => setIsNavHidden(false)}
              isNavigationHidden={isNavHidden}
              onSave={handleSave}
              isSaveDisabled={isSaving}
              articleKeyword={outline.keyword}
              clientName={outline.clientName}
              onExpand={() => setIsEditFocus(true)}
              isEditFocus={isEditFocus}
              onDevView={() =>
                outline && navigate("/dev-view", { state: { outline } })
              }
              onClientView={() =>
                outline && navigate("/client-view", { state: { outline } })
              }
              currentView={currentView}
              onSeoView={() => navigate(`/editor/${projectId}/seo`)}
              onEditView={() => {
                setCurrentView("edit");
                setIsEditFocus(true);
              }}
              onPublicView={() => {
                setCurrentView("public");
                outline && navigate("/dev-view", { state: { outline } });
              }}
              onClientViewClick={() => {
                setCurrentView("client");
                outline && navigate("/client-view", { state: { outline } });
              }}
            />
          ) : (
            <div className="flex-1 overflow-y-auto flex flex-col">
              <div className="flex-1 overflow-auto px-12 py-8">
                <LoadingIndicator />

                {/* Article Outline Sections */}
                <div className="max-w-4xl">
                  <h3 className="text-xl font-semibold text-foreground mb-6">
                    Article Outline
                  </h3>

                  {/* Keyword and Section Info */}
                  <div className="bg-card border border-border rounded-lg p-6 mb-6">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          Keyword
                        </label>
                        <p className="text-sm font-medium text-foreground mt-2">
                          {outline.keyword}
                        </p>
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          Sections
                        </label>
                        <p className="text-sm font-medium text-foreground mt-2">
                          {outline.sections.length}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Sections List */}
                  <div className="space-y-4">
                    {outline.sections.map((section, index) => (
                      <div
                        key={section.id}
                        className="bg-card border border-border rounded-lg p-6"
                      >
                        <h4 className="font-semibold text-foreground mb-2">
                          Section {index + 1}: {section.title}
                        </h4>
                        <p className="text-sm text-muted-foreground">
                          {section.description}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Comments Sidebar */}
      <CommentsSidebar
        articleId={outline.articleId}
        currentUserEmail={outline.clientName}
        isOpen={isCommentsOpen}
        onClose={() => setIsCommentsOpen(false)}
        onCommentClick={handleCommentClick}
      />

      {/* Floating Comment Box */}
      {showFloatingComment && selectedText && (
        <FloatingCommentBox
          articleId={outline.articleId}
          selectedText={selectedText}
          currentUserEmail={outline.clientName}
          onCommentAdded={() => setCommentsRefreshKey((prev) => prev + 1)}
          onClose={() => setShowFloatingComment(false)}
          position={selectedPosition || undefined}
        />
      )}

      {/* History Panel */}
      {showHistory && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-end">
          <div className="bg-background w-96 h-full shadow-lg flex flex-col">
            <div className="border-b border-border/30 px-6 py-4 flex items-center justify-between">
              <h3 className="font-heading text-lg font-bold text-foreground flex items-center gap-2">
                <Clock className="w-5 h-5" />
                Version history ({revisions.length})
              </h3>
              <button
                onClick={() => setShowHistory(false)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Close"
              >
                <ChevronDown className="w-5 h-5 rotate-90" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {revisions.length > 0 ? (
                revisions.map((revision) => (
                  <div
                    key={revision.id}
                    className="border border-border/30 rounded-lg p-4 bg-card/50 hover:bg-card transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Clock className="w-4 h-4 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">
                          Version {revision.version_number}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {formatLastEditTime(revision.created_at)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(revision.created_at).toLocaleString()}
                        </p>
                        <div className="flex gap-2 mt-3">
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs h-7 px-2"
                            onClick={() => setSelectedRevision(revision)}
                          >
                            Preview
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-xs h-7 px-2"
                            onClick={() => handleRestoreRevision(revision)}
                            disabled={isRestoringRevision}
                          >
                            Restore
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-8">
                  <p className="text-sm text-muted-foreground">
                    No versions yet. Save to create a version.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Revision Preview Modal */}
      {selectedRevision && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-background rounded-lg shadow-lg max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="border-b border-border/30 px-6 py-4 flex items-center justify-between">
              <h3 className="font-heading text-lg font-bold text-foreground">
                Version {selectedRevision.version_number} Preview
              </h3>
              <button
                onClick={() => setSelectedRevision(null)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Close"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 bg-white/30">
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{
                  __html: selectedRevision.html_content,
                }}
              />
            </div>
            <div className="border-t border-border/30 px-6 py-4 bg-card/50 flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setSelectedRevision(null)}
              >
                Close
              </Button>
              <Button
                onClick={() => {
                  handleRestoreRevision(selectedRevision);
                }}
                disabled={isRestoringRevision}
              >
                {isRestoringRevision ? "Restoring..." : "Restore This Version"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Schema Edit Modal */}
      <SchemaEditModal
        visible={showSchemaModal}
        schema={outline?.schema}
        onSave={handleSchemaChange}
        onCancel={() => setShowSchemaModal(false)}
      />

      {/* Comments Sidebar */}
      {isCommentsOpen && (
        <>
          <CommentsSidebar
            articleId={outline?.article_id || outline?.articleId || ""}
            currentUserEmail={outline?.clientName || "editor@example.com"}
            isOpen={isCommentsOpen}
            onClose={() => {
              setIsCommentsOpen(false);
              setSelectedText("");
              setSelectedPosition(null);
            }}
            selectedText={selectedText}
            onCommentClick={handleCommentClick}
            key={commentsRefreshKey}
          />
          {showFloatingComment && selectedText && (
            <FloatingCommentBox
              articleId={outline?.article_id || outline?.articleId || ""}
              selectedText={selectedText}
              currentUserEmail={outline?.clientName || "editor@example.com"}
              position={selectedPosition || undefined}
              onCommentAdded={() => {
                setCommentsRefreshKey((k) => k + 1);
                setIsCommentsOpen(true);
                setSelectedText("");
                setShowFloatingComment(false);
                setSelectedPosition(null);
              }}
              onClose={() => {
                setShowFloatingComment(false);
                setSelectedText("");
                setSelectedPosition(null);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
