import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArticleOutline } from "@/types/article";
import DevViewPageContent from "./DevViewPageContent";
import { useState, useEffect } from "react";
import { getArticleOutlines, getArticleOutlineById } from "@/lib/storage";
import { getCurrentUser } from "@/lib/auth";
import { getUserRole } from "@/lib/team-members";

export default function DevViewPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const passedOutline = (location.state?.outline as ArticleOutline | undefined) || null;

  console.log("📍 DevViewPage mounted");
  console.log("  ├─ Passed outline via state:", passedOutline?.id || "(none)");
  if (passedOutline?.receivedArticle) {
    console.log("  ├─ Passed outline has receivedArticle:");
    console.log("  │  ├─ Title:", passedOutline.receivedArticle.title || "(empty)");
    console.log("  │  └─ Meta:", passedOutline.receivedArticle.meta || "(empty)");
  }

  const [outline, setOutline] = useState<ArticleOutline | null>(passedOutline);
  const [isLoading, setIsLoading] = useState(!passedOutline);

  useEffect(() => {
    // If no outline provided via navigation, fetch the most recent article
    if (!outline) {
      console.log("⏳ No outline in state, fetching most recent article...");
      const loadArticle = async () => {
        try {
          const user = await getCurrentUser();
          let userId: string | undefined;
          let userRole: "admin" | "member" | undefined;

          if (user) {
            userId = user.id;
            userRole = (await getUserRole(user.id)) || undefined;
          }

          const articles = await getArticleOutlines({
            userId,
            userRole: userRole as "admin" | "member" | undefined,
          });
          if (articles && articles.length > 0) {
            console.log("✅ Fetched article from database:", articles[0].id);
            if (articles[0].receivedArticle) {
              console.log("  ├─ Title:", articles[0].receivedArticle.title || "(empty)");
              console.log("  └─ Meta:", articles[0].receivedArticle.meta || "(empty)");
            }
            setOutline(articles[0]);
          }
        } catch (error) {
          console.error("Error loading article:", error);
        } finally {
          setIsLoading(false);
        }
      };
      loadArticle();
    } else {
      console.log("✅ Using outline from navigation state");
      setIsLoading(false);
      // Fetch fresh data from Supabase to pick up translations (state may be stale)
      const articleId = passedOutline?.articleId || passedOutline?.id;
      if (articleId) {
        getArticleOutlineById(articleId).then((fresh) => {
          if (fresh?.translations) {
            setOutline((prev) => prev ? { ...prev, translations: fresh.translations } : prev);
            console.log("✅ Merged fresh translations from Supabase");
          }
        }).catch(() => {});
      }
    }
    // Depend on the article identity, NOT the mutable `outline` state. The
    // effect calls setOutline() to merge fresh translations, which creates a
    // new object; depending on `outline` re-triggered the effect → refetch →
    // setOutline → infinite loop for any article that HAS translations
    // (Public/Client View hanging forever). Keying on the passed article id
    // makes it run once per article.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passedOutline?.articleId, passedOutline?.id]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-border border-t-primary mx-auto"></div>
          <p className="text-sm text-muted-foreground">Loading article...</p>
        </div>
      </div>
    );
  }

  if (!outline) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-foreground font-medium mb-4">
            No article data available
          </p>
          <Button onClick={() => navigate(-1)} variant="default">
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  return <DevViewPageContent outline={outline} />;
}
