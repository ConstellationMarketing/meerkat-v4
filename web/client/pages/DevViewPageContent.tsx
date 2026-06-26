import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Copy, Check, MessageCircle, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ArticleOutline } from "@/types/article";
import { useToast } from "@/hooks/use-toast";
import { CommentsSidebar } from "@/components/CommentsSidebar";
import { FloatingCommentBox } from "@/components/FloatingCommentBox";
import { ArticleAccessManager } from "@/components/ArticleAccessManager";
import { PublicShareButton } from "@/components/PublicShareButton";
import { SelectableArticleContent } from "@/components/SelectableArticleContent";
import { saveArticleOutline, getArticleOutlineById } from "@/lib/storage";
import { TranslationControls } from "@/components/TranslationControls";
import type { TranslationLanguage } from "@/lib/translate";

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

interface DevViewPageContentProps {
  outline: ArticleOutline;
  guestEmail?: string;
  isPublicView?: boolean;
  isSharedView?: boolean;
}

export default function DevViewPageContent({
  outline: initialOutline,
  guestEmail,
  isPublicView = false,
  isSharedView = false,
}: DevViewPageContentProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [copiedSection, setCopiedSection] = useState<string | null>(null);
  const [outline, setOutline] = useState(initialOutline);
  const { toast } = useToast();

  const isClientView = location.pathname === "/client-view";
  const viewTitle = isClientView ? "Client View" : "Public View";

  console.log("📌 DevViewPageContent rendered");
  console.log("  ├─ Received outline ID:", initialOutline.id);
  console.log("  ├─ View mode:", viewTitle);
  if (initialOutline.receivedArticle) {
    console.log("  ├─ Received outline has receivedArticle:");
    console.log("  │  ├─ Title:", initialOutline.receivedArticle.title || "(empty)");
    console.log("  │  └─ Meta:", initialOutline.receivedArticle.meta || "(empty)");
  } else {
    console.log("  └─ ⚠️ No receivedArticle in outline!");
  }

  // In client view, collapse by default. In public/shared view, always expand.
  // Restore from sessionStorage only for client view (for back navigation across pages)
  const [isMetadataCollapsed, setIsMetadataCollapsed] = useState(() => {
    if (isSharedView || isPublicView) return false; // Always expand for public/shared views
    const stored = sessionStorage.getItem("devview_isMetadataCollapsed");
    return stored !== null ? JSON.parse(stored) : isClientView;
  });
  const [isSchemaCollapsed, setIsSchemaCollapsed] = useState(() => {
    if (isSharedView || isPublicView) return false; // Always expand for public/shared views
    const stored = sessionStorage.getItem("devview_isSchemaCollapsed");
    return stored !== null ? JSON.parse(stored) : isClientView;
  });
  const [isCommentsOpen, setIsCommentsOpen] = useState(false);
  const [selectedText, setSelectedText] = useState<string>("");
  const [selectedPosition, setSelectedPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [showFloatingComment, setShowFloatingComment] = useState(false);
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);
  const [currentUser] = useState(guestEmail || "user@example.com"); // Use guestEmail if provided, fallback to example
  const [isEditingSeo, setIsEditingSeo] = useState(false);
  const [editedTitle, setEditedTitle] = useState(outline.receivedArticle?.title || "");
  const [editedMeta, setEditedMeta] = useState(outline.receivedArticle?.meta || "");
  const [isSaving, setIsSaving] = useState(false);
  const [activeLanguage, setActiveLanguage] = useState<TranslationLanguage | null>(null);

  useEffect(() => {
    setOutline(initialOutline);
  }, [initialOutline.id]);

  useEffect(() => {
    adjustLabelPositions();
    window.addEventListener("resize", adjustLabelPositions);
    return () => window.removeEventListener("resize", adjustLabelPositions);
  }, [outline]);

  useEffect(() => {
    // Only sync the outline data to edit fields when NOT currently editing
    if (!isEditingSeo) {
      setEditedTitle(outline.receivedArticle?.title || "");
      setEditedMeta(outline.receivedArticle?.meta || "");
    }
  }, [outline.receivedArticle?.title, outline.receivedArticle?.meta, isEditingSeo]);

  // Preserve collapsed state in sessionStorage when it changes (but not for shared views)
  useEffect(() => {
    if (!isSharedView && !isPublicView) {
      sessionStorage.setItem(
        "devview_isMetadataCollapsed",
        JSON.stringify(isMetadataCollapsed),
      );
      sessionStorage.setItem(
        "devview_isSchemaCollapsed",
        JSON.stringify(isSchemaCollapsed),
      );
    }
  }, [isMetadataCollapsed, isSchemaCollapsed, isSharedView, isPublicView]);

  const handleCommentClick = (comment: any) => {
    if (comment.selected_text) {
      try {
        // Normalize the search text
        const searchText = comment.selected_text.trim().toLowerCase();
        const articleContent = document.querySelector(".article-content");

        if (articleContent) {
          // Get all text content and find the matching section
          const allText =
            articleContent.innerText || articleContent.textContent || "";
          const normalizedText = allText.toLowerCase();

          if (normalizedText.includes(searchText)) {
            // Find the actual element containing the text
            const walker = document.createTreeWalker(
              articleContent,
              NodeFilter.SHOW_TEXT,
              null,
              false,
            );

            let node;
            let bestMatch = null;
            let bestMatchNode = null;

            while ((node = walker.nextNode())) {
              const nodeText = (node.textContent || "").toLowerCase();
              if (nodeText.includes(searchText)) {
                // Prefer exact matches over partial matches
                if (!bestMatch || nodeText === searchText) {
                  bestMatch = node.textContent;
                  bestMatchNode = node;
                }
              }
            }

            if (bestMatchNode) {
              // Create selection around the found text
              try {
                const range = document.createRange();

                // Try to select the exact matched text within the node
                const text = bestMatchNode.textContent || "";
                const index = text.toLowerCase().indexOf(searchText);

                if (index !== -1) {
                  range.setStart(bestMatchNode, index);
                  range.setEnd(bestMatchNode, index + searchText.length);
                } else {
                  // Fallback to selecting the whole node
                  range.selectNodeContents(bestMatchNode);
                }

                const selection = window.getSelection();
                if (selection) {
                  selection.removeAllRanges();
                  selection.addRange(range);
                }

                // Scroll the parent element into view
                let scrollTarget = bestMatchNode.parentElement;
                while (scrollTarget && scrollTarget !== articleContent) {
                  if (scrollTarget.offsetParent !== null) {
                    break;
                  }
                  scrollTarget = scrollTarget.parentElement;
                }

                if (scrollTarget) {
                  scrollTarget.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  });
                }
              } catch (e) {
                // If selection fails, just scroll to the parent
                bestMatchNode.parentElement?.scrollIntoView({
                  behavior: "smooth",
                  block: "center",
                });
              }
            } else {
              toast({
                title: "Info",
                description: "Text found but could not navigate to it",
              });
            }
          } else {
            toast({
              title: "Info",
              description: "Could not find the commented text in the article",
            });
          }
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

  const handleSaveSeo = async () => {
    try {
      setIsSaving(true);

      console.log("🔧 Starting SEO save...", {
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

      console.log("📝 Saving updated outline to Supabase:", updatedOutline);
      console.log("  ├─ New Title to save:", editedTitle || "(empty)");
      console.log("  ├─ New Meta to save:", editedMeta || "(empty)");
      console.log("  ├─ Content length:", updatedOutline.receivedArticle.content?.length || 0);
      console.log("  └─ receivedArticle object:", JSON.stringify(updatedOutline.receivedArticle, null, 2));

      await saveArticleOutline(updatedOutline);
      console.log("✅ Save to Supabase successful!");

      // Update local outline state immediately with the new values
      setOutline(updatedOutline);
      console.log("✅ Local state updated with new values");

      // Then refetch from Supabase to ensure consistency
      console.log("🔄 Refetching from Supabase to verify...");
      if (outline.id) {
        const freshOutline = await getArticleOutlineById(outline.id);
        setOutline(freshOutline);
        console.log("✅ Verification refetch complete");
      }

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
    setEditedTitle(outline.receivedArticle?.title || "");
    setEditedMeta(outline.receivedArticle?.meta || "");
    setIsEditingSeo(false);
  };

  const copyToClipboard = async (text: string, sectionId: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopiedSection(sectionId);
      setTimeout(() => setCopiedSection(null), 2000);
    } catch (error) {
      console.error("Failed to copy:", error);
    }
  };

  const copyArticleWithFormatting = async () => {
    try {
      const htmlContent = getArticleHtml();

      // Strip style and class attributes to remove background colors
      const stripStylesFromHtml = (html: string): string => {
        let cleaned = html.replace(/\s+style="[^"]*"/gi, "");
        cleaned = cleaned.replace(/\s+style='[^']*'/gi, "");
        cleaned = cleaned.replace(/\s+class="[^"]*"/gi, "");
        cleaned = cleaned.replace(/\s+class='[^']*'/gi, "");
        return cleaned;
      };

      const cleanedContent = stripStylesFromHtml(htmlContent);

      // Create a hidden container to preserve formatting
      const container = document.createElement("div");
      container.innerHTML = cleanedContent;
      container.style.position = "fixed";
      container.style.left = "-99999px";
      container.style.top = "-99999px";
      container.style.opacity = "0";
      container.style.pointerEvents = "none";
      container.style.whiteSpace = "normal";

      // Add CSS to ensure proper rendering of lists and elements
      const styleEl = document.createElement("style");
      styleEl.textContent = `
        div[data-article-copy] * {
          background: transparent !important;
          background-color: transparent !important;
          background-image: none !important;
        }
        div[data-article-copy] ul { list-style-type: disc; margin-left: 20px; padding-left: 20px; margin-top: 15px; margin-bottom: 15px; }
        div[data-article-copy] ol { list-style-type: decimal; margin-left: 20px; padding-left: 20px; margin-top: 15px; margin-bottom: 15px; }
        div[data-article-copy] li { display: list-item; margin: 8px 0; }
        div[data-article-copy] p { margin: 12px 0; }
        div[data-article-copy] h1 { margin: 24px 0 12px 0; font-weight: bold; }
        div[data-article-copy] h2 { margin: 20px 0 10px 0; font-weight: bold; }
        div[data-article-copy] h3 { margin: 16px 0 8px 0; font-weight: bold; }
        div[data-article-copy] h4, h5, h6 { margin: 12px 0 6px 0; font-weight: bold; }
        div[data-article-copy] a { color: inherit; text-decoration: underline; }
        div[data-article-copy] strong, div[data-article-copy] b { font-weight: bold; }
        div[data-article-copy] em, div[data-article-copy] i { font-style: italic; }
      `;
      document.head.appendChild(styleEl);
      container.setAttribute("data-article-copy", "true");
      document.body.appendChild(container);

      // Select and copy the content
      const range = document.createRange();
      range.selectNodeContents(container);
      const sel = window.getSelection();

      let successful = false;
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
        successful = document.execCommand("copy");
        sel.removeAllRanges();
      }

      // Clean up
      document.body.removeChild(container);
      if (styleEl.parentNode) {
        document.head.removeChild(styleEl);
      }

      if (successful) {
        setCopiedSection("article");
        setTimeout(() => setCopiedSection(null), 2000);
      } else {
        throw new Error("execCommand copy returned false");
      }
    } catch (error) {
      console.error("Failed to copy article with formatting:", error);
    }
  };

  const adjustLabelPositions = () => {
    setTimeout(() => {
      const labels = document.querySelectorAll(".element-label");
      labels.forEach((label) => {
        const wrapper = label.parentElement;
        if (!wrapper) return;

        const firstChild = wrapper.querySelector(
          "h1, h2, h3, h4, h5, h6, p, ul, ol",
        );
        if (!firstChild) return;

        const firstRect = (firstChild as HTMLElement).getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();

        const labelHeight = (label as HTMLElement).offsetHeight;
        const elementCenterY = firstRect.height / 2;
        const topOffset = elementCenterY - labelHeight / 2;

        (label as HTMLElement).style.top = `${Math.max(0, topOffset)}px`;
      });
    }, 0);
  };

  const getArticleHtml = (): string => {
    // Try to get content from multiple places
    let content = outline.receivedArticle?.content;

    // Fallback to html_content if receivedArticle.content is empty
    if (!content && (outline as any).html_content) {
      content = (outline as any).html_content;
    }

    // If still no content, generate sample content from outline data
    if (!content || content.trim() === "") {
      const keyword = outline.keyword || "Article";
      const clientName = outline.clientName || "Client";
      const template = outline.template || "General";

      return `
        <h1>${keyword}</h1>
        <p>This article for <strong>${clientName}</strong> covers the topic of <strong>${keyword}</strong> and is designed as a <strong>${template}</strong> content piece.</p>

        <h2>Overview</h2>
        <p>Professional content addressing key aspects and considerations related to ${keyword}. This section provides readers with a comprehensive introduction to the subject matter, establishing context and importance.</p>

        <h2>Key Points</h2>
        <ul>
          <li>Detailed analysis of important aspects related to ${keyword}</li>
          <li>Expert insights and professional recommendations</li>
          <li>Best practices and industry standards</li>
          <li>Case studies and practical applications</li>
          <li>Implementation strategies and recommendations</li>
        </ul>

        <h2>What You Need to Know</h2>
        <p>Understanding ${keyword} is essential for businesses and professionals in this field. This comprehensive guide provides the foundational knowledge needed to make informed decisions and implement effective strategies.</p>

        <h2>Getting Started</h2>
        <p>Whether you're new to ${keyword} or looking to deepen your expertise, this resource offers actionable insights and practical guidance. Take the next step in your professional journey with the strategies and recommendations outlined in this article.</p>

        <h2>Conclusion</h2>
        <p>For more information about how ${clientName} can help with your ${keyword} needs, please contact us directly. Our team of experts is ready to assist you with customized solutions tailored to your specific requirements.</p>
      `;
    }

    return content;
  };

  const getArticleText = (): string => {
    try {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = getArticleHtml();
      return tempDiv.textContent || "";
    } catch {
      return "";
    }
  };

  const getArticleHtmlWithLabels = (): string => {
    // Return plain HTML without labels for client view and public guest view
    if (isClientView || (isPublicView && guestEmail)) {
      return getArticleHtml();
    }

    const html = getArticleHtml();
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = html;

    const allElements: Element[] = [];
    const walker = document.createTreeWalker(
      tempDiv,
      NodeFilter.SHOW_ELEMENT,
      null,
      false,
    );

    let node;
    while ((node = walker.nextNode())) {
      allElements.push(node as Element);
    }

    const elementsList: Array<{ element: Element; label: string }> = [];
    allElements.forEach((element) => {
      const tagName = element.tagName.toLowerCase();

      if (tagName.match(/^h[1-6]$/)) {
        const level = parseInt(tagName[1]);
        elementsList.push({ element, label: `H${level}` });
      } else if (tagName === "p") {
        elementsList.push({ element, label: "P" });
      } else if (tagName === "ul") {
        elementsList.push({ element, label: "UL" });
      } else if (tagName === "ol") {
        elementsList.push({ element, label: "OL" });
      }
    });

    const groups: Array<{ elements: Element[]; label: string }> = [];
    let currentGroup: Element[] = [];
    let currentLabel = "";
    let hasListInGroup = false;

    elementsList.forEach(({ element, label }) => {
      if (label.match(/^H[1-6]$/)) {
        if (currentGroup.length > 0) {
          groups.push({
            elements: currentGroup,
            label: hasListInGroup
              ? currentLabel.match(/^UL|OL$/)
                ? currentLabel
                : "UL"
              : currentLabel,
          });
          currentGroup = [];
          currentLabel = "";
          hasListInGroup = false;
        }
        groups.push({ elements: [element], label });
      } else {
        if (!currentLabel) {
          currentLabel = label;
        }
        if (label.match(/^UL|OL$/)) {
          hasListInGroup = true;
          currentLabel = label;
        }
        currentGroup.push(element);
      }
    });

    if (currentGroup.length > 0) {
      groups.push({
        elements: currentGroup,
        label: hasListInGroup
          ? currentLabel.match(/^UL|OL$/)
            ? currentLabel
            : "UL"
          : currentLabel,
      });
    }

    groups.forEach(({ elements, label }) => {
      const wrapper = document.createElement("div");
      wrapper.className = "labeled-element";

      const labelDiv = document.createElement("div");
      labelDiv.className = "element-label";
      labelDiv.textContent = label;

      wrapper.appendChild(labelDiv);

      const firstElement = elements[0];
      firstElement.parentNode?.insertBefore(wrapper, firstElement);

      elements.forEach((element) => {
        wrapper.appendChild(element);
      });
    });

    return tempDiv.innerHTML;
  };

  const activeTranslation = activeLanguage
    ? outline.translations?.[activeLanguage]
    : null;
  const displayTitle =
    activeTranslation?.title || outline.receivedArticle?.title || "";
  const displayMeta =
    activeTranslation?.meta || outline.receivedArticle?.meta || "";
  const displaySlug = activeTranslation?.slug || outline["URL Slug"] || "";

  const metadataFields: { label: string; value: string; copyId?: string }[] = [
    { label: "Keyword", value: outline.keyword || "" },
    { label: "Client Name", value: outline.clientName || "" },
    { label: "Page URL", value: outline["Page URL"] || "" },
    { label: "URL Slug", value: displaySlug, copyId: "url-slug" },
    { label: "Content Type", value: outline.template || "" },
    { label: "Word Count", value: outline["word count"]?.toString() || "" },
    { label: "Version", value: outline.version || "" },
  ];

  // Add Page Update URL if available
  if (outline["page-update-type"] === "update" && outline["page-url"]) {
    metadataFields.push({
      label: "Page Update URL",
      value: outline["page-url"],
    });
  }

  // Debug logging
  console.log("📊 Metadata fields for outline:", {
    "page-update-type": outline["page-update-type"],
    "page-url": outline["page-url"],
    willShowPageUpdateUrl:
      outline["page-update-type"] === "update" && !!outline["page-url"],
  });

  const metadataContent = metadataFields
    .map((field) => `${field.label}: ${field.value}`)
    .join("\n");

  const titleTag = outline.receivedArticle?.title || "";
  const metaDescription = outline.receivedArticle?.meta || "";
  const titleTagCharCount = titleTag.length;
  const metaDescriptionCharCount = metaDescription.length;
  const isTranslationActive = activeLanguage !== null;

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

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-secondary/5 pb-12 flex flex-col">
      <header
        className={`sticky top-0 z-50 border-b border-border/30 bg-background/80 backdrop-blur-lg shadow-sm transition-all duration-200 ${isClientView && isCommentsOpen ? "pr-80" : ""}`}
      >
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {!isSharedView && !isPublicView && (
              <button
                onClick={() => navigate(-1)}
                className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                title="Go back"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
            )}
            <div>
              <h2 className="text-2xl font-bold text-foreground">
                {viewTitle}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {outline.keyword}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 ml-auto">
            <TranslationControls
              outline={outline}
              onLanguageChange={setActiveLanguage}
              activeLanguage={activeLanguage}
            />

            {!isSharedView && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setIsMetadataCollapsed(!isMetadataCollapsed);
                  setIsSchemaCollapsed(!isSchemaCollapsed);
                }}
                className="h-8 px-3"
                title={isMetadataCollapsed ? "Expand all" : "Collapse all"}
              >
                <span className="text-xs font-medium">
                  {isMetadataCollapsed ? "Expand" : "Collapse"}
                </span>
              </Button>
            )}
            {(isClientView || (isPublicView && guestEmail && !isSharedView)) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIsCommentsOpen(!isCommentsOpen)}
                className="h-8 w-8 p-0"
                title="Comments"
              >
                <MessageCircle className="w-4 h-4" />
              </Button>
            )}
            {isClientView && (
              <ArticleAccessManager
                articleId={outline.articleId || outline.article_id}
                currentUserId={currentUser}
              />
            )}
            {!isClientView &&
              !isSharedView &&
              !(isPublicView && guestEmail) && (
                <PublicShareButton
                  articleId={outline.articleId || outline.article_id}
                />
              )}
            {!isSharedView && (
              <div className="text-right text-sm text-muted-foreground">
                <p>{outline.clientName}</p>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <main
          className={`flex-1 overflow-y-auto w-full transition-all duration-200 ${isClientView && isCommentsOpen ? "pr-80" : ""}`}
        >
          <div className="max-w-7xl mx-auto px-6 py-8">
            <div className="grid grid-cols-1 gap-6">
              {!isMetadataCollapsed && (
                <div>
                  <div className="bg-card border border-border/30 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                    <div className="bg-gradient-to-r from-primary/10 to-primary/5 border-b border-border/20 px-6 py-4 flex items-center justify-between">
                      <h2 className="text-lg font-semibold text-foreground">
                        Metadata
                      </h2>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          copyToClipboard(metadataContent, "metadata")
                        }
                        className="hover:bg-primary/10"
                        title="Copy all metadata"
                      >
                        {copiedSection === "metadata" ? (
                          <Check className="w-4 h-4 text-green-600" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                    <div className="p-6 grid grid-cols-2 gap-6">
                      {metadataFields.map((field, index) => (
                        <div key={`${index}-${field.label}`}>
                          <div className="flex items-center justify-between mb-2">
                            <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                              {field.label}
                            </label>
                            {field.copyId && field.value && (
                              <button
                                onClick={() =>
                                  copyToClipboard(field.value, field.copyId!)
                                }
                                className="text-muted-foreground hover:text-foreground transition-colors"
                                title={`Copy ${field.label}`}
                              >
                                {copiedSection === field.copyId ? (
                                  <Check className="w-3.5 h-3.5 text-green-600" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                          </div>
                          <div className="bg-muted/40 border border-border/30 rounded-lg p-3 text-sm text-foreground break-words">
                            {field.value || (
                              <span className="text-muted-foreground italic">
                                —
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

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
                        disabled={isTranslationActive}
                        className="hover:bg-purple-500/10"
                        title={
                          isTranslationActive
                            ? "Switch to English to edit"
                            : "Edit SEO information"
                        }
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
                        <div className="flex items-center justify-between mb-2">
                          <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            Title Tag
                          </label>
                          {!isEditingSeo && displayTitle && (
                            <button
                              onClick={() =>
                                copyToClipboard(displayTitle, "title-tag")
                              }
                              className="text-muted-foreground hover:text-foreground transition-colors"
                              title="Copy Title Tag"
                            >
                              {copiedSection === "title-tag" ? (
                                <Check className="w-3.5 h-3.5 text-green-600" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </div>
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
                          <div className="bg-muted/40 border border-border/30 rounded-lg p-4 text-sm text-foreground break-words min-h-20 flex items-center">
                            {displayTitle || (
                              <span className="text-muted-foreground italic">
                                —
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Meta Description */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            Meta Description
                          </label>
                          {!isEditingSeo && displayMeta && (
                            <button
                              onClick={() =>
                                copyToClipboard(displayMeta, "meta-description")
                              }
                              className="text-muted-foreground hover:text-foreground transition-colors"
                              title="Copy Meta Description"
                            >
                              {copiedSection === "meta-description" ? (
                                <Check className="w-3.5 h-3.5 text-green-600" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </div>
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
                          <div className="bg-muted/40 border border-border/30 rounded-lg p-4 text-sm text-foreground break-words min-h-20 flex items-center">
                            {displayMeta || (
                              <span className="text-muted-foreground italic">
                                —
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {!isSchemaCollapsed && (
                <div>
                  <div className="bg-card border border-border/30 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                    <div className="bg-gradient-to-r from-blue-500/10 to-blue-500/5 border-b border-border/20 px-6 py-4 flex items-center justify-between">
                      <h2 className="text-lg font-semibold text-foreground">
                        Schema
                      </h2>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => copyToClipboard(schemaContent, "schema")}
                        className="hover:bg-blue-500/10"
                        title="Copy schema"
                      >
                        {copiedSection === "schema" ? (
                          <Check className="w-4 h-4 text-green-600" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                    <div className="p-6">
                      <textarea
                        readOnly
                        value={schemaContent}
                        className="w-full h-48 p-4 bg-muted/30 text-sm text-foreground resize-none rounded-lg border border-border/30 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div>
                <div className="bg-card border border-border/30 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                  <div className="bg-gradient-to-r from-purple-500/10 to-purple-500/5 border-b border-border/20 px-6 py-4 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-foreground">
                      Full Article
                    </h2>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={copyArticleWithFormatting}
                      className="hover:bg-purple-500/10"
                      title="Copy article"
                    >
                      {copiedSection === "article" ? (
                        <Check className="w-4 h-4 text-green-600" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                  <div className="p-6">
                    <style>{`
                  .article-content { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; position: relative; }
                  .labeled-element {
                    position: relative;
                    margin-left: 70px;
                    padding-top: 4px;
                    margin-bottom: 1rem;
                  }
                  .element-label {
                    position: absolute;
                    left: -65px;
                    top: 0;
                    font-size: 11px;
                    font-weight: 800;
                    background-color: #d0d0d0;
                    color: #333;
                    padding: 4px 6px;
                    border-radius: 3px;
                    border: 1px solid #999;
                    white-space: nowrap;
                    min-width: 45px;
                    text-align: center;
                    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
                  }
                  .labeled-element h1,
                  .labeled-element h2,
                  .labeled-element h3,
                  .labeled-element h4,
                  .labeled-element h5,
                  .labeled-element h6 {
                    border: none;
                    border-radius: 0;
                    background-color: transparent;
                  }
                  .labeled-element p {
                    border: none;
                    border-radius: 0;
                    background-color: transparent;
                  }
                  .labeled-element ul,
                  .labeled-element ol {
                    border: none;
                    border-radius: 0;
                    background-color: transparent;
                    margin: 1rem 0;
                    padding-left: 2rem;
                    list-style-position: outside;
                  }
                  .labeled-element ul li,
                  .labeled-element ol li {
                    margin-bottom: 0.5rem;
                    line-height: 1.6;
                  }
                  .article-content h1 {
                    font-size: 2rem;
                    font-weight: 700;
                    margin: 0;
                    color: #16a5a5;
                    line-height: 1.3;
                  }
                  .article-content h2 {
                    font-size: 1.5rem;
                    font-weight: 700;
                    margin: 0;
                    color: #1a1a1a;
                    line-height: 1.4;
                  }
                  .article-content h3 {
                    font-size: 1.25rem;
                    font-weight: 700;
                    margin: 0;
                    color: #1a1a1a;
                  }
                  .article-content h4 {
                    font-size: 1.125rem;
                    font-weight: 700;
                    margin: 0;
                  }
                  .article-content h5 {
                    font-size: 1rem;
                    font-weight: 700;
                    margin: 0;
                  }
                  .article-content h6 {
                    font-size: 0.875rem;
                    font-weight: 700;
                    margin: 0;
                  }
                  .article-content p {
                    margin: 1rem 0;
                    line-height: 1.6;
                    color: #333;
                  }
                  .article-content ul {
                    margin: 1rem 0;
                    padding-left: 2rem;
                    line-height: 1.6;
                    list-style-type: disc;
                    list-style-position: outside;
                  }
                  .article-content ol {
                    margin: 1rem 0;
                    padding-left: 2rem;
                    line-height: 1.6;
                    list-style-type: decimal;
                    list-style-position: outside;
                  }
                  .article-content li {
                    margin: 0.5rem 0;
                    color: #333;
                    display: list-item;
                    margin-left: 0;
                  }
                  .article-content blockquote {
                    margin: 1rem 0;
                    padding-left: 1.5rem;
                    border-left: 4px solid #16a5a5;
                    font-style: italic;
                    color: #666;
                  }
                  .article-content strong {
                    font-weight: 700;
                  }
                  .article-content em {
                    font-style: italic;
                  }
                  .article-content code {
                    background-color: #f5f5f5;
                    padding: 0.2rem 0.4rem;
                    border-radius: 3px;
                    font-family: "Monaco", "Courier New", monospace;
                    font-size: 0.9em;
                  }
                  .article-content pre {
                    background-color: #f5f5f5;
                    padding: 1rem;
                    border-radius: 4px;
                    overflow-x: auto;
                    line-height: 1.5;
                  }
                  .article-content a {
                    color: #16a5a5;
                    text-decoration: underline;
                  }
                `}</style>
                    {isClientView && (
                      <style>{`
                    .element-label { display: none !important; }
                    .labeled-element { margin-left: 0 !important; }
                  `}</style>
                    )}
                    {activeLanguage && outline.translations?.[activeLanguage]?.content ? (
                      <div
                        className="article-content"
                        dangerouslySetInnerHTML={{
                          __html: outline.translations[activeLanguage].content!,
                        }}
                      />
                    ) : (
                      <SelectableArticleContent
                        content={getArticleHtmlWithLabels()}
                        articleId={outline.article_id}
                        onCommentClick={(text, position) => {
                          setSelectedText(text);
                          setSelectedPosition(position || null);
                          setShowFloatingComment(true);
                        }}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </main>
        {(isClientView || (isPublicView && guestEmail && !isSharedView)) && (
          <>
            <CommentsSidebar
              articleId={outline.articleId || outline.article_id}
              currentUserEmail={currentUser}
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
                articleId={outline.articleId || outline.article_id}
                selectedText={selectedText}
                currentUserEmail={currentUser}
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
    </div>
  );
}
