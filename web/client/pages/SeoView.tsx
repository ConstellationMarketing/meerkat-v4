import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Copy, Check, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArticleOutline } from "@/types/article";
import { useState, useEffect } from "react";
import { getArticleOutlineById, saveArticleOutline } from "@/lib/storage";
import { useToast } from "@/hooks/use-toast";
import { slugify, validateSlug } from "../../shared/slug";

function getFleschScoreColor(scoreString: string | undefined): {
  bgColor: string;
  textColor: string;
  score: number;
} {
  if (!scoreString) {
    return { bgColor: "bg-gray-100", textColor: "text-gray-800", score: 0 };
  }

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

export default function SeoView() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [outline, setOutline] = useState<ArticleOutline | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [isEditingSeo, setIsEditingSeo] = useState(false);
  const [editedTitle, setEditedTitle] = useState("");
  const [editedMeta, setEditedMeta] = useState("");
  const [editedSlug, setEditedSlug] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const loadArticle = async () => {
    if (!projectId) {
      setIsLoading(false);
      return;
    }
    try {
      console.log("📥 Fetching article from Supabase...");
      const found = await getArticleOutlineById(projectId);
      console.log("✅ Article loaded:", found);
      setOutline(found);
      setEditedTitle(found?.receivedArticle?.title || "");
      setEditedMeta(found?.receivedArticle?.meta || "");
      setEditedSlug(((found as any)?.["URL Slug"] as string) || "");
    } catch (error) {
      console.error("Error loading article:", error);
      toast({
        title: "Error",
        description: "Failed to load article data",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    loadArticle();
  }, [projectId, toast]);

  useEffect(() => {
    // Only sync the outline data to edit fields when NOT currently editing
    if (outline && !isEditingSeo) {
      setEditedTitle(outline.receivedArticle?.title || "");
      setEditedMeta(outline.receivedArticle?.meta || "");
      setEditedSlug(((outline as any)?.["URL Slug"] as string) || "");
    }
  }, [outline?.receivedArticle?.title, outline?.receivedArticle?.meta, (outline as any)?.["URL Slug"], isEditingSeo]);

  const copyToClipboard = (text: string, sectionId: string) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedSection(sectionId);
      setTimeout(() => setCopiedSection(null), 2000);
      toast({
        title: "Copied",
        description: `${sectionId.charAt(0).toUpperCase() + sectionId.slice(1)} copied to clipboard`,
        duration: 2000,
      });
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const handleSaveSeo = async () => {
    if (!outline) {
      console.error("No outline found");
      toast({
        title: "Error",
        description: "No article found to save",
        variant: "destructive",
      });
      return;
    }

    const normalizedSlug = slugify(editedSlug || "");
    const slugCheck = validateSlug(normalizedSlug, { pageType: outline.template });
    if (!slugCheck.valid) {
      toast({
        title: "Invalid slug",
        description: slugCheck.errors.join(" "),
        variant: "destructive",
      });
      return;
    }

    try {
      setIsSaving(true);
      console.log("🔧 Starting save...", {
        outlineId: outline.id,
        articleId: outline.articleId,
        newTitle: editedTitle,
        newMeta: editedMeta,
      });

      const updatedOutline: ArticleOutline = {
        ...outline,
        receivedArticle: {
          content: outline.receivedArticle?.content || "",
          title: editedTitle,
          meta: editedMeta,
          receivedAt: outline.receivedArticle?.receivedAt || new Date().toISOString(),
        },
      };
      // Carry the new slug into the saved outline so the local cache isn't
      // stale after save (the server call below is authoritative for the DB).
      (updatedOutline as any)["URL Slug"] = normalizedSlug;

      console.log("📝 Saving updated outline to Supabase:", updatedOutline);
      console.log("  ├─ New Title to save:", editedTitle || "(empty)");
      console.log("  ├─ New Meta to save:", editedMeta || "(empty)");
      console.log("  ├─ Content length:", updatedOutline.receivedArticle.content?.length || 0);
      console.log("  └─ receivedArticle object:", JSON.stringify(updatedOutline.receivedArticle, null, 2));

      await saveArticleOutline(updatedOutline);
      console.log("✅ Save to Supabase successful!");

      // Persist the user-editable slug. The server normalizes + validates it
      // and recomputes the Page URL so publishing uses the user-set slug.
      const slugRes = await fetch("/.netlify/functions/update-article", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          articleId: outline.articleId,
          slug: normalizedSlug,
          pageType: outline.template,
        }),
      });
      if (!slugRes.ok) {
        const err = await slugRes.json().catch(() => ({}));
        throw new Error(
          err.errors ? err.errors.join(" ") : err.error || "Failed to save slug",
        );
      }

      // Update local outline state immediately with the new values
      setOutline(updatedOutline);
      console.log("✅ Local state updated with new values");

      // Then refetch from Supabase to ensure consistency
      console.log("🔄 Refetching from Supabase to verify...");
      await loadArticle();
      console.log("✅ Verification refetch complete");

      toast({
        title: "Success",
        description: "SEO information saved successfully!",
      });
      setIsEditingSeo(false);
    } catch (error) {
      console.error("❌ Failed to save SEO information:", error);
      toast({
        title: "Error",
        description: `Failed to save: ${error instanceof Error ? error.message : "Unknown error"}`,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelSeo = () => {
    setEditedTitle(outline?.receivedArticle?.title || "");
    setEditedMeta(outline?.receivedArticle?.meta || "");
    setEditedSlug(((outline as any)?.["URL Slug"] as string) || "");
    setIsEditingSeo(false);
  };

  if (!outline) {
    if (!isLoading) {
      return (
        <div className="flex h-screen flex-col items-center justify-center bg-background">
          <div className="text-center">
            <p className="text-foreground font-medium mb-4">
              Article not found
            </p>
            <Button onClick={() => navigate("/")} variant="default">
              Back to home
            </Button>
          </div>
        </div>
      );
    }
    // While loading, show empty page without spinner
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-secondary/5" />
    );
  }

  const seoFields = [
    { label: "Keyword", value: outline.keyword || "" },
    { label: "Article ID", value: outline.articleId || "" },
    { label: "Content Type", value: outline.template || "" },
    { label: "Word Count", value: outline["word count"]?.toString() || "" },
    {
      label: "Date Created",
      value: new Date(outline.createdAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    },
  ];

  const seoContent = seoFields
    .map((field) => `${field.label}: ${field.value}`)
    .join("\n");

  const getFormattedSchema = (): string => {
    const schema = outline.schema || "{}";
    try {
      const parsed = typeof schema === "string" ? JSON.parse(schema) : schema;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return schema;
    }
  };
  const schemaContent = getFormattedSchema();

  const slugOrigin = (() => {
    try {
      const pu = (outline as any)?.["Page URL"] as string | undefined;
      return pu ? new URL(pu).origin : "";
    } catch {
      return "";
    }
  })();
  const slugValidation = validateSlug(editedSlug || "", { pageType: outline.template });

  // Try to get title and meta from receivedArticle, fall back to schema meta
  let titleTagValue = outline.receivedArticle?.title || "";
  let metaDescValue = outline.receivedArticle?.meta || "";

  // If empty, try to get from schema meta
  if (!titleTagValue && outline.schema) {
    try {
      const schema =
        typeof outline.schema === "string"
          ? JSON.parse(outline.schema)
          : outline.schema;
      titleTagValue = schema.meta?.title || "";
    } catch (e) {
      // ignore parse errors
    }
  }

  if (!metaDescValue && outline.schema) {
    try {
      const schema =
        typeof outline.schema === "string"
          ? JSON.parse(outline.schema)
          : outline.schema;
      metaDescValue = schema.meta?.description || "";
    } catch (e) {
      // ignore parse errors
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-secondary/5 pb-12 flex flex-col">
      <header className="sticky top-0 z-50 border-b border-border/30 bg-background/80 backdrop-blur-lg shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => navigate(-1)}
              className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
              title="Go back"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-2xl font-bold text-foreground">SEO View</h1>
              <p className="text-sm text-muted-foreground mt-1">
                {outline.keyword}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs hover:bg-purple-200 hover:text-purple-800 transition-colors"
                  onClick={() => navigate(`/editor/${projectId}/resource`)}
                  title="Resource Page - Resource information page"
                >
                  Resource Page
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs hover:bg-purple-200 hover:text-purple-800 transition-colors"
                  title="SEO View - Official front page"
                >
                  SEO View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs hover:bg-purple-200 hover:text-purple-800 transition-colors"
                  onClick={() => navigate(`/editor/${projectId}`)}
                  title="Edit View - Expanded editing mode"
                >
                  Edit View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs hover:bg-purple-200 hover:text-purple-800 transition-colors"
                  onClick={() => navigate(`/dev-view`, { state: { outline } })}
                  title="Public View - Public page view"
                >
                  Public View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs hover:bg-purple-200 hover:text-purple-800 transition-colors"
                  onClick={() => navigate(`/client-view`, { state: { outline } })}
                  title="Client View - Client facing view"
                >
                  Client View
                </Button>
              </div>
              <div className="h-6 w-px bg-border/30" />
            </>
            <div className="text-right text-sm text-muted-foreground">
              <p>{outline.clientName}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1 overflow-y-auto w-full">
          <div className="max-w-7xl mx-auto px-6 py-8">
            <div className="grid grid-cols-1 gap-6">
              {/* SEO Metadata Section */}
              <div>
                <div className="bg-card border border-border/30 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                  <div className="bg-gradient-to-r from-primary/10 to-primary/5 border-b border-border/20 px-6 py-4 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-foreground">
                      SEO Metadata
                    </h2>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => copyToClipboard(seoContent, "metadata")}
                      className="hover:bg-primary/10"
                      title="Copy all SEO metadata"
                    >
                      {copiedSection === "metadata" ? (
                        <Check className="w-4 h-4 text-green-600" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <div className="p-6 grid grid-cols-2 gap-6">
                    {seoFields.map((field, index) => (
                      <div key={`${index}-${field.label}`}>
                        <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                          {field.label}
                        </label>
                        <div className="bg-muted/40 border border-border/30 rounded-lg p-3 text-sm text-foreground break-words">
                          {field.value || (
                            <span className="text-muted-foreground italic">
                              —
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                    {/* Flesch Score - displayed specially */}
                    <div>
                      <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                        Flesch Reading Score
                      </label>
                      {outline["flesch score"] ? (
                        (() => {
                          const { bgColor, textColor } = getFleschScoreColor(
                            outline["flesch score"] as string,
                          );
                          return (
                            <span
                              className={`inline-block px-4 py-2 rounded-lg ${bgColor} ${textColor} text-sm font-semibold`}
                            >
                              {outline["flesch score"]}
                            </span>
                          );
                        })()
                      ) : (
                        <span className="inline-block px-2 py-1 rounded bg-gray-100 text-gray-800 text-xs font-medium">
                          Not available
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Title Tag and Meta Description Section */}
              <div>
                <div className="bg-card border border-border/30 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                  <div className="bg-gradient-to-r from-purple-500/10 to-purple-500/5 border-b border-border/20 px-6 py-4 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-foreground">
                      SEO Information
                    </h2>
                    {!isEditingSeo ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setIsEditingSeo(true)}
                        className="hover:bg-purple-500/10"
                        title="Edit SEO information"
                      >
                        <span className="text-xs font-medium">Edit</span>
                      </Button>
                    ) : (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleCancelSeo}
                          disabled={isSaving}
                          className="hover:bg-red-500/10"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={handleSaveSeo}
                          disabled={isSaving}
                          className="hover:bg-green-500/10"
                          title="Save changes"
                        >
                          <Save className="w-4 h-4" />
                          <span className="text-xs font-medium ml-1">
                            {isSaving ? "Saving..." : "Save"}
                          </span>
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="p-6">
                    <div className="grid grid-cols-2 gap-6">
                      {/* Title Tag */}
                      <div>
                        <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                          Title Tag
                        </label>
                        {isEditingSeo ? (
                          <div className="space-y-2">
                            <input
                              type="text"
                              maxLength={70}
                              value={editedTitle}
                              onChange={(e) => setEditedTitle(e.target.value)}
                              placeholder="Enter title tag"
                              className="w-full px-3 py-2 bg-background border border-border/30 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                            />
                            <div className="text-xs text-muted-foreground">
                              {editedTitle.length}/70 characters
                            </div>
                          </div>
                        ) : (
                          <div className="bg-muted/30 border border-border/30 rounded-lg p-4 text-sm text-foreground break-words">
                            {editedTitle || (
                              <span className="text-muted-foreground italic">
                                —
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Meta Description */}
                      <div>
                        <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                          Meta Description
                        </label>
                        {isEditingSeo ? (
                          <div className="space-y-2">
                            <textarea
                              maxLength={156}
                              value={editedMeta}
                              onChange={(e) => setEditedMeta(e.target.value)}
                              placeholder="Enter meta description"
                              rows={3}
                              className="w-full px-3 py-2 bg-background border border-border/30 rounded-lg text-sm text-foreground resize-none focus:outline-none focus:ring-2 focus:ring-teal-500/50"
                            />
                            <div className="text-xs text-muted-foreground">
                              {editedMeta.length}/156 characters
                            </div>
                          </div>
                        ) : (
                          <div className="bg-muted/30 border border-border/30 rounded-lg p-4 text-sm text-foreground break-words">
                            {editedMeta || (
                              <span className="text-muted-foreground italic">
                                —
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {/* URL Slug (editable) */}
                    <div className="mt-6">
                      <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                        URL Slug
                      </label>
                      {isEditingSeo ? (
                        <div className="space-y-2">
                          <input
                            type="text"
                            value={editedSlug}
                            onChange={(e) => setEditedSlug(slugify(e.target.value))}
                            placeholder="my-article-slug"
                            className="w-full px-3 py-2 bg-background border border-border/30 rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                          />
                          <div className="text-xs text-muted-foreground break-words">
                            Published URL: {slugOrigin}/{editedSlug || "…"}
                          </div>
                          {!slugValidation.valid && (
                            <ul className="text-xs text-red-600 list-disc pl-4">
                              {slugValidation.errors.map((er, i) => (
                                <li key={i}>{er}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : (
                        <div className="bg-muted/30 border border-border/30 rounded-lg p-4 text-sm text-foreground break-words">
                          {editedSlug || (
                            <span className="text-muted-foreground italic">—</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Schema Section */}
              <div>
                <div className="bg-card border border-border/30 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                  <div className="bg-gradient-to-r from-green-500/10 to-green-500/5 border-b border-border/20 px-6 py-4 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-foreground">
                      Schema
                    </h2>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => copyToClipboard(schemaContent, "schema")}
                      className="hover:bg-green-500/10"
                      title="Copy schema"
                      disabled={!outline.schema}
                    >
                      {copiedSection === "schema" ? (
                        <Check className="w-4 h-4 text-green-600" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <div className="p-6">
                    {outline.schema ? (
                      <div className="w-full bg-muted/30 rounded-lg border border-border/30">
                        <pre className="p-4 text-xs text-foreground whitespace-pre-wrap break-words font-mono">
                          {schemaContent}
                        </pre>
                      </div>
                    ) : (
                      <div className="text-muted-foreground italic">
                        No schema defined
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
