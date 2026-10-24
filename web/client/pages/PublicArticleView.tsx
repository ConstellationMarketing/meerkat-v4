import { useState, useEffect } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getAllArticlesPublic } from "@/lib/storage";
import { ArticleOutline } from "@/types/article";
import DevViewPageContent from "./DevViewPageContent";

export default function PublicArticleView() {
  const { articleId } = useParams<{ articleId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [email, setEmail] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
  const [outline, setOutline] = useState<ArticleOutline | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [accessList, setAccessList] = useState<any[]>([]);
  const [verifiedArticleId, setVerifiedArticleId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    const verifyTokenAndLoadArticle = async () => {
      const token = searchParams.get("token");

      try {
        if (token) {
          // Verify token and get article_id and email
          const response = await fetch(`/api/verify-token?token=${token}`);
          if (!response.ok) {
            toast({
              title: "Error",
              description: "Invalid or expired access link",
              variant: "destructive",
            });
            navigate("/");
            return;
          }

          const { articleId: tokenArticleId, email: tokenEmail } =
            await response.json();
          setVerifiedArticleId(tokenArticleId);
          setVerifiedEmail(tokenEmail);

          // Load the article for this token
          const articles = await getAllArticlesPublic();
          const article = articles.find(
            (a) => a.articleId === tokenArticleId || a.id === tokenArticleId,
          );

          if (!article) {
            toast({
              title: "Error",
              description: "Article not found",
              variant: "destructive",
            });
            navigate("/");
            return;
          }

          setOutline(article);
          setIsLoading(false);
          return;
        }

        // No token - fall back to manual email verification
        if (!articleId) {
          navigate("/");
          return;
        }

        // Get all articles without role filtering for public access
        const articles = await getAllArticlesPublic();
        console.log(`Found ${articles.length} articles for public access`);

        const article = articles.find(
          (a) => a.articleId === articleId || a.id === articleId,
        );
        console.log(`Article ${articleId}:`, article);
        console.log(
          `Article receivedArticle content length:`,
          article?.receivedArticle?.content?.length,
        );

        if (!article) {
          toast({
            title: "Error",
            description: "Article not found",
            variant: "destructive",
          });
          navigate("/");
          return;
        }
        setOutline(article);

        // Fetch access list for this article
        const response = await fetch(
          `/api/article-access?articleId=${articleId}`,
        );
        if (response.ok) {
          const data = await response.json();
          setAccessList(data || []);
        }
      } catch (error) {
        console.error("Error loading article:", error);
        toast({
          title: "Error",
          description: "Failed to load article",
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    verifyTokenAndLoadArticle();
  }, [articleId, searchParams, navigate, toast]);

  const handleVerifyEmail = async () => {
    if (!email.trim()) {
      toast({
        title: "Error",
        description: "Please enter your email",
        variant: "destructive",
      });
      return;
    }

    setIsVerifying(true);
    try {
      // Check if email is in the access list
      const emailLower = email.toLowerCase();
      const hasAccess = accessList.some(
        (access) => access.email?.toLowerCase() === emailLower,
      );

      if (!hasAccess) {
        toast({
          title: "Access Denied",
          description: "Your email is not authorized to view this article",
          variant: "destructive",
        });
        return;
      }

      setVerifiedEmail(emailLower);
      toast({
        title: "Success",
        description:
          "Email verified. You can now view and comment on the article",
      });
    } catch (error) {
      console.error("Error verifying email:", error);
      toast({
        title: "Error",
        description: "Failed to verify email",
        variant: "destructive",
      });
    } finally {
      setIsVerifying(false);
    }
  };

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

  if (!verifiedEmail) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="w-full max-w-md space-y-6 p-8">
          <div className="space-y-2 text-center">
            <h1 className="text-2xl font-bold">Article Access</h1>
            <p className="text-muted-foreground">
              Enter your email to view and comment on this article
            </p>
          </div>

          <div className="space-y-4">
            <Input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleVerifyEmail();
                }
              }}
              disabled={isVerifying}
            />
            <Button
              onClick={handleVerifyEmail}
              disabled={isVerifying || !email.trim()}
              className="w-full"
            >
              {isVerifying ? "Verifying..." : "Access Article"}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            You need to be on the authorized email list to access this article
          </p>
        </div>
      </div>
    );
  }

  return (
    <DevViewPageContent
      outline={outline}
      guestEmail={verifiedEmail}
      isPublicView={true}
    />
  );
}
