import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useState, useEffect } from "react";
import { Pencil } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ArticleOutline } from "@/types/article";
import { getCurrentUser } from "@/lib/auth";
import DevViewPageContent from "./DevViewPageContent";

export default function PublicOpenArticleView() {
  const { articleId } = useParams<{ articleId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [outline, setOutline] = useState<ArticleOutline | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRevisionView, setIsRevisionView] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Check whether a Meerkat user is logged in. Used to gate the Edit button —
  // the public view URL is shared with internal team members who are signed
  // in, but if someone hits it logged-out, suppress the Edit affordance.
  useEffect(() => {
    getCurrentUser()
      .then((user) => setIsLoggedIn(!!user))
      .catch(() => setIsLoggedIn(false));
  }, []);

  useEffect(() => {
    const loadArticle = async () => {
      if (!articleId) {
        navigate("/");
        return;
      }

      try {
        let response: Response;

        if (searchParams.get("original") === "true") {
          // Load the originally generated article (from "cleaned content" column)
          response = await fetch(
            `/.netlify/functions/get-article-original?id=${encodeURIComponent(articleId)}`
          );
          setIsRevisionView(true);
        } else {
          // Load current article (editor's version)
          response = await fetch(
            `/.netlify/functions/get-article?id=${encodeURIComponent(articleId)}`
          );
        }

        if (!response.ok) {
          throw new Error("Failed to fetch article");
        }

        const data = await response.json();

        if (!data.article) {
          toast({
            title: "Error",
            description: "Article not found",
            variant: "destructive",
          });
          navigate("/");
          return;
        }

        // Map API response to ArticleOutline format
        const article: ArticleOutline = {
          id: data.article.id || data.article.articleId,
          articleId: data.article.articleId || data.article.id,
          clientName: data.article.clientName,
          clientId: data.article.clientId,
          keyword: data.article.keyword,
          template: data.article.template,
          sections: data.article.sections || [],
          createdAt: data.article.createdAt,
          updatedAt: data.article.updatedAt,
          webhookSent: data.article.webhookSent,
          receivedArticle: data.article.receivedArticle,
          schema: data.article.schema,
          "word count": data.article["word count"],
          "flesch score": data.article["flesch score"],
          "Page URL": data.article["Page URL"],
          "URL Slug": data.article["URL Slug"],
          translations: data.article.translations,
        };

        setOutline(article);
      } catch (error) {
        console.error("Error loading article:", error);
        toast({
          title: "Error",
          description: "Failed to load article. Please check the link and try again.",
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadArticle();
  }, [articleId, navigate, toast]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-muted-foreground">Loading article...</p>
      </div>
    );
  }

  if (!outline) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-muted-foreground">Article not found</p>
      </div>
    );
  }

  // Edit button only renders for signed-in team members on the editor's
  // version of the article. The "original" (V0) view is for comparison;
  // editing from there would land in the editor showing the current version
  // anyway, which is confusing — so we hide the button on that path.
  const showEditButton = isLoggedIn && !isRevisionView && outline.articleId;

  return (
    <div>
      {isRevisionView && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-center text-sm text-amber-800">
          Viewing original generated version (V0) — this is the article before any editor changes
        </div>
      )}
      {showEditButton && (
        <>
          {/* Top-right: rides above the sticky header (which uses z-50) so it
              stays visible at the top of the page. */}
          <Button
            onClick={() => navigate(`/editor/${outline.articleId}`)}
            className="fixed top-3 right-4 z-[60] shadow-md"
            size="sm"
          >
            <Pencil className="w-4 h-4 mr-2" />
            Edit
          </Button>
          {/* Bottom-right: floating action button for long-scroll convenience.
              Always reachable without scrolling back up. */}
          <Button
            onClick={() => navigate(`/editor/${outline.articleId}`)}
            className="fixed bottom-6 right-6 z-[60] shadow-2xl"
            size="lg"
          >
            <Pencil className="w-5 h-5 mr-2" />
            Edit
          </Button>
        </>
      )}
      <DevViewPageContent
        outline={outline}
        guestEmail="public-viewer"
        isPublicView={true}
        isSharedView={true}
      />
    </div>
  );
}
