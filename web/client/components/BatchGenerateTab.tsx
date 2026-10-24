import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { Upload, Play, XCircle, RefreshCw, CheckCircle2, AlertCircle, Loader2, Plus, ChevronRight, ChevronDown, ExternalLink, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { getClientFolders } from "@/lib/client-folders";
import {
  parseCSV,
  startBatch,
  getBatchStatus,
  cancelBatch,
  retryBatch,
  listBatches,
  listArticlesForBatch,
  listTemplates,
  buildTemplateAliasMap,
  resolveTemplateAlias,
  buildClientAliasMap,
  resolveClientAlias,
  type BatchArticle,
  type BatchStatus,
  type BatchArticleRow,
  type BatchTemplate,
} from "@/lib/batch";
import { getTeamMembers } from "@/lib/team-members";

// "list" is the canonical home view: every past + in-progress batch with
// expand-to-articles. Creating a new batch is a flow that returns to list.
type Phase = "list" | "upload" | "progress" | "results";

const ARTICLES_PER_PAGE = 25;

interface ValidationRow extends BatchArticle {
  rowNumber: number;
  valid: boolean;
  error?: string;
  // Canonical template ID after backend-style alias resolution
  // (e.g. "Practice Page" → "practice-page").
  resolvedTemplateId?: string;
  // Canonical client name after fuzzy resolution. Punctuation differences
  // from client_folders.name (extra commas, missing periods) collapse to
  // the same key — backend mirrors this resolution.
  resolvedClientName?: string;
}

interface ExpandedBatchData {
  articles: BatchArticleRow[];
  total: number;
  loading: boolean;
  error?: string;
}

export default function BatchGenerateTab({ userId }: { userId: string | null }) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>("list");

  // List phase
  const [batches, setBatches] = useState<BatchStatus[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [expandedData, setExpandedData] = useState<Record<string, ExpandedBatchData>>({});
  const listPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Per-batch selected failed keywords (for selective retry).
  const [selectedFailures, setSelectedFailures] = useState<Record<string, Set<string>>>({});
  // Per-batch retry-in-flight flag (for button loading state).
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  // Cached templates for client-side validation table (mirrors backend
  // alias resolution so users see the resolved template ID before submit).
  const [templates, setTemplates] = useState<BatchTemplate[]>([]);
  // Map user_id → email for "Submitted by" column.
  const [userEmailMap, setUserEmailMap] = useState<Record<string, string>>({});

  // Bootstrap templates + team members on mount. Both feed the validation
  // table and the batch list display; both are non-blocking — the UI still
  // works if these calls fail (just no resolved-template hint, no email).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const tpls = await listTemplates();
        if (!cancelled) setTemplates(tpls);
      } catch (err) {
        console.warn("Failed to load templates:", err);
      }
      try {
        const members = await getTeamMembers();
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const m of members) {
          if (m.user_id) map[m.user_id] = m.email_address || "";
        }
        setUserEmailMap(map);
      } catch (err) {
        console.warn("Failed to load team members:", err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Whether a different batch is currently in 'processing' status — used to
  // gate the Start button in the upload phase. Live-updates via the existing
  // list-phase polling.
  const isAnyBatchProcessing = batches.some((b) => b.status === "processing");

  // Upload phase
  const [fileName, setFileName] = useState<string | null>(null);
  const [validationRows, setValidationRows] = useState<ValidationRow[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);

  // Progress phase
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (listPollRef.current) clearInterval(listPollRef.current);
    };
  }, []);

  // Load + poll the batches list whenever we're on the list phase. Polls every
  // 5s only if at least one batch is in 'processing' so an active run shows
  // live progress without burning IO when nothing is in flight.
  const refreshBatches = useCallback(async () => {
    try {
      const fetched = await listBatches();
      setBatches(fetched);
      return fetched;
    } catch (err) {
      console.error("Failed to load batches:", err);
      return [];
    }
  }, []);

  useEffect(() => {
    // Keep batches state fresh on both list and upload phases so the upload
    // phase can show a "waiting on current batch" message and disable Start
    // when another batch is running.
    if (phase !== "list" && phase !== "upload") {
      if (listPollRef.current) {
        clearInterval(listPollRef.current);
        listPollRef.current = null;
      }
      return;
    }

    let cancelled = false;
    (async () => {
      setBatchesLoading(true);
      const fetched = await refreshBatches();
      if (cancelled) return;
      setBatchesLoading(false);
      const anyProcessing = fetched.some((b) => b.status === "processing");
      if (anyProcessing && !listPollRef.current) {
        listPollRef.current = setInterval(async () => {
          const updated = await refreshBatches();
          if (!updated.some((b) => b.status === "processing") && listPollRef.current) {
            clearInterval(listPollRef.current);
            listPollRef.current = null;
          }
        }, 5000);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, refreshBatches]);

  const handleToggleExpand = useCallback(async (id: string) => {
    if (expandedBatchId === id) {
      setExpandedBatchId(null);
      return;
    }
    setExpandedBatchId(id);
    if (!expandedData[id]) {
      setExpandedData((prev) => ({ ...prev, [id]: { articles: [], total: 0, loading: true } }));
      try {
        const result = await listArticlesForBatch(id, { limit: ARTICLES_PER_PAGE, offset: 0 });
        setExpandedData((prev) => ({ ...prev, [id]: { ...result, loading: false } }));
      } catch (err) {
        setExpandedData((prev) => ({
          ...prev,
          [id]: { articles: [], total: 0, loading: false, error: (err as Error).message },
        }));
      }
    }
  }, [expandedBatchId, expandedData]);

  const handleLoadMoreArticles = useCallback(async (id: string) => {
    const current = expandedData[id];
    if (!current) return;
    setExpandedData((prev) => ({ ...prev, [id]: { ...current, loading: true } }));
    try {
      const result = await listArticlesForBatch(id, {
        limit: ARTICLES_PER_PAGE,
        offset: current.articles.length,
      });
      setExpandedData((prev) => ({
        ...prev,
        [id]: {
          articles: [...current.articles, ...result.articles],
          total: result.total,
          loading: false,
        },
      }));
    } catch (err) {
      setExpandedData((prev) => ({
        ...prev,
        [id]: { ...current, loading: false, error: (err as Error).message },
      }));
    }
  }, [expandedData]);

  // ── Retry handlers ────────────────────────────────────────────────────
  const handleToggleFailureSelection = useCallback((batchId: string, keyword: string) => {
    setSelectedFailures((prev) => {
      const current = new Set(prev[batchId] ?? []);
      if (current.has(keyword)) current.delete(keyword);
      else current.add(keyword);
      return { ...prev, [batchId]: current };
    });
  }, []);

  const handleSelectAllFailures = useCallback((batchId: string, keywords: string[], selectAll: boolean) => {
    setSelectedFailures((prev) => ({
      ...prev,
      [batchId]: selectAll ? new Set(keywords) : new Set(),
    }));
  }, []);

  const handleRetryFromList = useCallback(async (batchId: string, articleKeywords?: string[]) => {
    setRetrying((prev) => new Set(prev).add(batchId));
    try {
      await retryBatch(batchId, articleKeywords);
      // Clear selection for this batch — the retry covers everything that was selected.
      setSelectedFailures((prev) => ({ ...prev, [batchId]: new Set() }));
      // Drop cached article rows for this batch so the expanded view re-fetches
      // with the new ones once the retry runs.
      setExpandedData((prev) => {
        const next = { ...prev };
        delete next[batchId];
        return next;
      });
      const scopeNote = articleKeywords && articleKeywords.length > 0
        ? `${articleKeywords.length} selected`
        : "all failed";
      toast({ title: "Retry started", description: `Retrying ${scopeNote} — list will update as articles complete.` });
      // Trigger an immediate list refresh so the row flips to processing.
      await refreshBatches();
    } catch (err) {
      toast({ title: "Retry failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(batchId);
        return next;
      });
    }
  }, [refreshBatches, toast]);

  const handleStartNewBatch = useCallback(() => {
    setPhase("upload");
    setFileName(null);
    setValidationRows([]);
    setParseErrors([]);
    setBatchId(null);
    setBatchStatus(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handleBackToList = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPhase("list");
    setBatchId(null);
    setBatchStatus(null);
    setFileName(null);
    setValidationRows([]);
    setParseErrors([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    refreshBatches();
  }, [refreshBatches]);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setValidating(true);
    setParseErrors([]);
    setValidationRows([]);

    const text = await file.text();
    const { articles, errors } = parseCSV(text);

    if (errors.length > 0) {
      setParseErrors(errors);
      setValidating(false);
      return;
    }

    // Validate client names AND resolve template aliases — same logic the
    // backend will run, so what's shown here matches what /batch/start will
    // see. If the user typed "Practice Page" we display that it resolves to
    // "practice-page" so they're not surprised by the canonical id.
    try {
      const [folders, currentTemplates] = await Promise.all([
        getClientFolders(),
        // Use cached templates if already loaded; refetch if not (the bootstrap
        // useEffect may not have completed yet for fast uploads).
        templates.length > 0 ? Promise.resolve(templates) : listTemplates(),
      ]);
      if (templates.length === 0) setTemplates(currentTemplates);

      const aliasMap = buildTemplateAliasMap(currentTemplates);
      const clientAliasMap = buildClientAliasMap(folders);

      const rows: ValidationRow[] = articles.map((a, i) => {
        const resolvedClientName = resolveClientAlias(a.clientName, clientAliasMap);
        const clientExists = !!resolvedClientName;
        const resolvedTemplateId = resolveTemplateAlias(a.template, aliasMap);
        const templateValid = !!resolvedTemplateId;
        const valid = clientExists && templateValid;
        let error: string | undefined;
        if (!clientExists) error = `Client "${a.clientName}" not found`;
        else if (!templateValid) error = `Template "${a.template}" not recognized`;
        return {
          ...a,
          rowNumber: i + 2, // +2 for header row + 1-indexed
          valid,
          error,
          resolvedTemplateId: resolvedTemplateId ?? undefined,
          resolvedClientName: resolvedClientName ?? undefined,
        };
      });

      setValidationRows(rows);
    } catch (err) {
      setParseErrors(["Failed to validate CSV: " + (err as Error).message]);
    }

    setValidating(false);
  }, []);

  const handleStartBatch = useCallback(async () => {
    const validArticles = validationRows.filter((r) => r.valid);
    if (validArticles.length === 0) return;

    try {
      const result = await startBatch(
        validArticles.map((r) => ({
          keyword: r.keyword,
          // Send canonical client name so downstream storage stays consistent
          // regardless of CSV punctuation. Falls back to raw if somehow unresolved.
          clientName: r.resolvedClientName ?? r.clientName,
          template: r.template,
        })),
        userId,
      );

      setBatchId(result.batchId);
      setPhase("progress");

      // Start polling
      pollRef.current = setInterval(async () => {
        try {
          const status = await getBatchStatus(result.batchId);
          setBatchStatus(status);

          if (["completed", "failed", "cancelled"].includes(status.status)) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setPhase("results");
          }
        } catch {
          // Silently retry on poll failure
        }
      }, 5000);

      toast({ title: "Batch started", description: `Generating ${result.totalArticles} articles` });
    } catch (err) {
      toast({ title: "Error", description: (err as Error).message, variant: "destructive" });
    }
  }, [validationRows, userId, toast]);

  const handleCancel = useCallback(async () => {
    if (!batchId) return;
    try {
      await cancelBatch(batchId);
      toast({ title: "Batch cancelled" });
    } catch (err) {
      toast({ title: "Error", description: (err as Error).message, variant: "destructive" });
    }
  }, [batchId, toast]);

  const handleRetry = useCallback(async () => {
    if (!batchId) return;
    try {
      await retryBatch(batchId);
      setPhase("progress");
      setBatchStatus(null);

      // Restart polling
      pollRef.current = setInterval(async () => {
        try {
          const status = await getBatchStatus(batchId);
          setBatchStatus(status);
          if (["completed", "failed", "cancelled"].includes(status.status)) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setPhase("results");
          }
        } catch {
          // Silently retry
        }
      }, 5000);

      toast({ title: "Retrying failed articles" });
    } catch (err) {
      toast({ title: "Error", description: (err as Error).message, variant: "destructive" });
    }
  }, [batchId, toast]);

  const validCount = validationRows.filter((r) => r.valid).length;
  const invalidCount = validationRows.filter((r) => !r.valid).length;
  const allValid = validationRows.length > 0 && invalidCount === 0;

  return (
    <div className="space-y-6">
      {/* List Phase — canonical home view */}
      {phase === "list" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Batches</span>
              <Button onClick={handleStartNewBatch} size="sm">
                <Plus className="w-4 h-4 mr-2" />
                New Batch
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {batchesLoading && batches.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading batches...
              </div>
            ) : batches.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                No batches yet. Click <strong>New Batch</strong> to upload a CSV and start your first run.
              </div>
            ) : (
              <div className="border rounded">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left p-2 w-8"></th>
                      <th className="text-left p-2">Date</th>
                      <th className="text-left p-2">Status</th>
                      <th className="text-left p-2">Articles</th>
                      <th className="text-left p-2">Submitted by</th>
                      <th className="text-left p-2">Batch ID</th>
                      <th className="text-left p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map((b) => {
                      const expanded = expandedBatchId === b.batch_id;
                      const data = expandedData[b.batch_id];
                      const dateStr = b.created_at
                        ? new Date(b.created_at).toLocaleString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "—";
                      const statusColor =
                        b.status === "completed"
                          ? "bg-green-50 text-green-700"
                          : b.status === "processing"
                            ? "bg-blue-50 text-blue-700"
                            : b.status === "cancelled"
                              ? "bg-yellow-50 text-yellow-700"
                              : b.status === "orphaned"
                                ? "bg-orange-50 text-orange-700"
                                : "bg-red-50 text-red-700";
                      return (
                        <Fragment key={b.batch_id}>
                          <tr
                            className="border-t cursor-pointer hover:bg-muted/30"
                            onClick={() => handleToggleExpand(b.batch_id)}
                          >
                            <td className="p-2">
                              {expanded ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )}
                            </td>
                            <td className="p-2 whitespace-nowrap">{dateStr}</td>
                            <td className="p-2">
                              <Badge variant="outline" className={statusColor}>
                                {b.status}
                              </Badge>
                            </td>
                            <td className="p-2">
                              {b.completed_count}/{b.total_articles}
                              {b.failed_count > 0 && (
                                <span className="text-red-600 ml-2 text-xs">({b.failed_count} failed)</span>
                              )}
                              {b.status === "processing" && b.current_keyword && (
                                <span className="text-xs text-muted-foreground ml-2">
                                  • {b.current_keyword}
                                </span>
                              )}
                            </td>
                            <td className="p-2 text-xs text-muted-foreground whitespace-nowrap">
                              {b.created_by
                                ? userEmailMap[b.created_by] || (
                                    <span className="font-mono">{b.created_by.slice(0, 8)}…</span>
                                  )
                                : "—"}
                            </td>
                            <td className="p-2 font-mono text-xs text-muted-foreground">{b.batch_id}</td>
                            <td className="p-2 whitespace-nowrap">
                              {b.failed_count > 0 && b.status !== "processing" && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={retrying.has(b.batch_id)}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRetryFromList(b.batch_id);
                                  }}
                                  className="h-7 text-xs"
                                >
                                  {retrying.has(b.batch_id) ? (
                                    <>
                                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                      Retrying...
                                    </>
                                  ) : (
                                    <>
                                      <RefreshCw className="w-3 h-3 mr-1" />
                                      Retry {b.failed_count} Failed
                                    </>
                                  )}
                                </Button>
                              )}
                            </td>
                          </tr>
                          {expanded && (
                            <tr className="border-t bg-muted/10">
                              <td colSpan={7} className="p-3 space-y-3">
                                {/* Failed articles section — only when this batch has errors */}
                                {b.errors && b.errors.length > 0 && (() => {
                                  const failedKeywords = b.errors.map((e) => e.keyword);
                                  const selectedSet = selectedFailures[b.batch_id] ?? new Set<string>();
                                  const selectedCount = selectedSet.size;
                                  const allSelected = selectedCount === failedKeywords.length;
                                  const isRetrying = retrying.has(b.batch_id);
                                  return (
                                    <div className="border rounded bg-red-50/40 border-red-200 p-3 space-y-2">
                                      <div className="flex items-center justify-between gap-3 flex-wrap">
                                        <div className="flex items-center gap-2">
                                          <input
                                            type="checkbox"
                                            checked={allSelected && failedKeywords.length > 0}
                                            onChange={(e) => handleSelectAllFailures(b.batch_id, failedKeywords, e.target.checked)}
                                            className="h-4 w-4"
                                            disabled={isRetrying || b.status === "processing"}
                                          />
                                          <span className="text-sm font-medium text-red-800">
                                            Failed ({b.errors.length})
                                          </span>
                                          {selectedCount > 0 && (
                                            <span className="text-xs text-muted-foreground">
                                              — {selectedCount} selected
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex gap-2">
                                          {selectedCount > 0 && (
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              disabled={isRetrying || b.status === "processing"}
                                              onClick={() => handleRetryFromList(b.batch_id, [...selectedSet])}
                                              className="h-7 text-xs"
                                            >
                                              {isRetrying ? (
                                                <>
                                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                                  Retrying...
                                                </>
                                              ) : (
                                                <>
                                                  <RefreshCw className="w-3 h-3 mr-1" />
                                                  Retry Selected ({selectedCount})
                                                </>
                                              )}
                                            </Button>
                                          )}
                                        </div>
                                      </div>
                                      <div className="border rounded bg-background">
                                        <table className="w-full text-sm">
                                          <thead className="bg-muted/30">
                                            <tr>
                                              <th className="text-left p-2 w-8"></th>
                                              <th className="text-left p-2">Keyword</th>
                                              <th className="text-left p-2">Client</th>
                                              <th className="text-left p-2">Error</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {b.errors.map((e, i) => {
                                              const checked = selectedSet.has(e.keyword);
                                              return (
                                                <tr key={`${b.batch_id}-err-${i}`} className="border-t">
                                                  <td className="p-2">
                                                    <input
                                                      type="checkbox"
                                                      checked={checked}
                                                      onChange={() => handleToggleFailureSelection(b.batch_id, e.keyword)}
                                                      className="h-4 w-4"
                                                      disabled={isRetrying || b.status === "processing"}
                                                    />
                                                  </td>
                                                  <td className="p-2">{e.keyword}</td>
                                                  <td className="p-2 text-muted-foreground">{e.clientName}</td>
                                                  <td className="p-2 text-red-600 text-xs">{e.error}</td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  );
                                })()}

                                {data?.loading && data.articles.length === 0 ? (
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Loading articles...
                                  </div>
                                ) : data?.error ? (
                                  <div className="text-sm text-destructive">{data.error}</div>
                                ) : !data || data.articles.length === 0 ? (
                                  <div className="text-sm text-muted-foreground py-2">
                                    No articles found for this batch.
                                  </div>
                                ) : (
                                  <div className="space-y-2">
                                    <div className="text-xs text-muted-foreground">
                                      Showing {data.articles.length} of {data.total} articles
                                    </div>
                                    <div className="border rounded bg-background">
                                      <table className="w-full text-sm">
                                        <thead className="bg-muted/30">
                                          <tr>
                                            <th className="text-left p-2">Keyword</th>
                                            <th className="text-left p-2">Client</th>
                                            <th className="text-left p-2 w-24">Words</th>
                                            <th className="text-left p-2 w-20"></th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {data.articles.map((a) => (
                                            <tr key={a.article_id} className="border-t">
                                              <td className="p-2">{a.keyword}</td>
                                              <td className="p-2 text-muted-foreground">{a.client_name || "—"}</td>
                                              <td className="p-2 text-muted-foreground">{a.word_count ?? "—"}</td>
                                              <td className="p-2">
                                                <a
                                                  href={`/editor/${a.article_id}`}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  className="text-primary hover:underline inline-flex items-center gap-1 text-sm"
                                                >
                                                  View
                                                  <ExternalLink className="w-3 h-3" />
                                                </a>
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                    {data.articles.length < data.total && (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => handleLoadMoreArticles(b.batch_id)}
                                        disabled={data.loading}
                                      >
                                        {data.loading ? (
                                          <>
                                            <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                                            Loading...
                                          </>
                                        ) : (
                                          `Load more (${data.total - data.articles.length} remaining)`
                                        )}
                                      </Button>
                                    )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Upload Phase */}
      {phase === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Upload className="w-5 h-5" />
                New Batch
              </span>
              <Button onClick={handleBackToList} variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-1" />
                Back to Batches
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm text-muted-foreground mb-3">
                Upload a CSV file with columns: <code className="bg-muted px-1 rounded">keyword</code>, <code className="bg-muted px-1 rounded">clientName</code>, and optionally <code className="bg-muted px-1 rounded">template</code>.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileSelect}
                className="block w-full text-sm text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 cursor-pointer"
              />
            </div>

            {validating && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Validating...
              </div>
            )}

            {parseErrors.length > 0 && (
              <div className="bg-destructive/10 border border-destructive/20 rounded p-3">
                {parseErrors.map((e, i) => (
                  <p key={i} className="text-sm text-destructive">{e}</p>
                ))}
              </div>
            )}

            {validationRows.length > 0 && (
              <>
                <div className="flex gap-3 text-sm">
                  <Badge variant="outline" className="bg-green-50 text-green-700">
                    {validCount} valid
                  </Badge>
                  {invalidCount > 0 && (
                    <Badge variant="outline" className="bg-red-50 text-red-700">
                      {invalidCount} invalid
                    </Badge>
                  )}
                  <span className="text-muted-foreground">
                    {validationRows.length} total rows from {fileName}
                  </span>
                </div>

                <div className="border rounded max-h-80 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left p-2 w-10">#</th>
                        <th className="text-left p-2 w-10"></th>
                        <th className="text-left p-2">Keyword</th>
                        <th className="text-left p-2">Client</th>
                        <th className="text-left p-2">Template</th>
                        <th className="text-left p-2">Resolves to</th>
                        <th className="text-left p-2">Issue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validationRows.map((row) => (
                        <tr key={row.rowNumber} className={row.valid ? "" : "bg-red-50/50"}>
                          <td className="p-2 text-muted-foreground">{row.rowNumber}</td>
                          <td className="p-2">
                            {row.valid ? (
                              <CheckCircle2 className="w-4 h-4 text-green-600" />
                            ) : (
                              <AlertCircle className="w-4 h-4 text-red-500" />
                            )}
                          </td>
                          <td className="p-2">{row.keyword}</td>
                          <td className="p-2">
                            {row.clientName}
                            {row.resolvedClientName && row.resolvedClientName !== row.clientName && (
                              <div className="text-xs text-muted-foreground mt-0.5">
                                → {row.resolvedClientName}
                              </div>
                            )}
                          </td>
                          <td className="p-2 text-muted-foreground">{row.template || "(blank)"}</td>
                          <td className="p-2 font-mono text-xs">
                            {row.resolvedTemplateId ? (
                              <span className="text-green-700">{row.resolvedTemplateId}</span>
                            ) : (
                              <span className="text-red-600">—</span>
                            )}
                          </td>
                          <td className="p-2 text-red-600 text-xs">{row.error || ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {isAnyBatchProcessing && (
                  <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm">
                    <span className="font-medium text-yellow-900">Another batch is currently running.</span>{" "}
                    <span className="text-yellow-800">
                      Your CSV is validated and ready. The Start button activates once the running batch finishes or is cancelled.
                    </span>
                  </div>
                )}

                <Button
                  onClick={handleStartBatch}
                  disabled={!allValid || isAnyBatchProcessing}
                  className="w-full"
                >
                  <Play className="w-4 h-4 mr-2" />
                  {isAnyBatchProcessing
                    ? "Waiting for current batch to finish…"
                    : `Start Batch (${validCount} articles)`}
                </Button>

                {invalidCount > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Fix invalid rows or remove them from the CSV before starting.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Progress Phase */}
      {phase === "progress" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Batch In Progress</span>
              <Button onClick={handleBackToList} variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-1" />
                Back to Batches
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {batchStatus ? (
              <>
                <Progress
                  value={
                    batchStatus.total_articles > 0
                      ? ((batchStatus.completed_count + batchStatus.failed_count) / batchStatus.total_articles) * 100
                      : 0
                  }
                />

                <div className="flex justify-between text-sm">
                  <span>
                    {batchStatus.completed_count + batchStatus.failed_count} / {batchStatus.total_articles} processed
                  </span>
                  <span className="text-muted-foreground">
                    {batchStatus.total_articles - batchStatus.completed_count - batchStatus.failed_count} remaining
                  </span>
                </div>

                {batchStatus.current_keyword && (
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating: <strong>{batchStatus.current_keyword}</strong>
                  </div>
                )}

                <div className="flex gap-3 text-sm">
                  <Badge variant="outline" className="bg-green-50 text-green-700">
                    {batchStatus.completed_count} completed
                  </Badge>
                  {batchStatus.failed_count > 0 && (
                    <Badge variant="outline" className="bg-red-50 text-red-700">
                      {batchStatus.failed_count} failed
                    </Badge>
                  )}
                </div>

                <Button variant="destructive" onClick={handleCancel} className="w-full">
                  <XCircle className="w-4 h-4 mr-2" />
                  Cancel Batch
                </Button>
              </>
            ) : (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Starting batch...
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Results Phase */}
      {phase === "results" && batchStatus && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>
                Batch {batchStatus.status === "completed" ? "Complete" : batchStatus.status === "cancelled" ? "Cancelled" : "Failed"}
              </span>
              <Badge
                variant="outline"
                className={
                  batchStatus.status === "completed"
                    ? "bg-green-50 text-green-700"
                    : batchStatus.status === "cancelled"
                      ? "bg-yellow-50 text-yellow-700"
                      : "bg-red-50 text-red-700"
                }
              >
                {batchStatus.completed_count} completed, {batchStatus.failed_count} failed
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {batchStatus.errors && batchStatus.errors.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Failed Articles</h4>
                <div className="border rounded max-h-60 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left p-2">Keyword</th>
                        <th className="text-left p-2">Client</th>
                        <th className="text-left p-2">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchStatus.errors.map((err, i) => (
                        <tr key={i} className="bg-red-50/50">
                          <td className="p-2">{err.keyword}</td>
                          <td className="p-2">{err.clientName}</td>
                          <td className="p-2 text-red-600 text-xs">{err.error}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <Button onClick={handleRetry} variant="outline" className="w-full">
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Retry Failed ({batchStatus.errors.length})
                </Button>
              </div>
            )}

            <Button onClick={handleBackToList} variant="outline" className="w-full">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Batches
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
