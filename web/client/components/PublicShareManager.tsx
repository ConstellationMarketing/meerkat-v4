import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { X, Share2, Copy, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Share {
  id: string;
  email: string;
  created_at: string;
}

interface PublicShareManagerProps {
  articleSlug: string; // client-name/keyword format
  clientName: string;
  keyword: string;
}

export function PublicShareManager({
  articleSlug,
  clientName,
  keyword,
}: PublicShareManagerProps) {
  const [shares, setShares] = useState<Share[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const { toast } = useToast();

  const shareLink = `${window.location.origin}/share/${clientName}/${keyword}`;

  const handleCopyLink = () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(shareLink)
          .then(() => {
            setCopiedLink(true);
            toast({
              title: "Copied",
              description: "Share link copied to clipboard",
            });
            setTimeout(() => setCopiedLink(false), 2000);
          })
          .catch(() => {
            copyUsingSelection(shareLink);
          });
      } else {
        copyUsingSelection(shareLink);
      }
    } catch (error) {
      console.error("Failed to copy link:", error);
      toast({
        title: "Error",
        description: "Failed to copy link",
        variant: "destructive",
      });
    }
  };

  const copyUsingSelection = (text: string) => {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);

      setCopiedLink(true);
      toast({
        title: "Copied",
        description: "Share link copied to clipboard",
      });
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (error) {
      console.error("Fallback copy failed:", error);
      toast({
        title: "Error",
        description: "Failed to copy link. Please copy manually.",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    if (isOpen && articleSlug) {
      fetchShares();
    }
  }, [articleSlug, isOpen]);

  const fetchShares = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(
        `/api/public-shares?slug=${encodeURIComponent(articleSlug)}`,
      );
      if (!response.ok) throw new Error("Failed to fetch shares");
      const data = await response.json();
      setShares(data || []);
    } catch (error) {
      console.error("Error fetching shares:", error);
      toast({
        title: "Error",
        description: "Failed to load share list",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddShare = async () => {
    if (!newEmail.trim()) return;

    try {
      const response = await fetch("/api/public-shares", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          slug: articleSlug,
          clientName,
          keyword,
          email: newEmail,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to add share");
      }
      const newShare = await response.json();
      setShares([...shares, newShare]);
      setNewEmail("");
      toast({
        title: "Success",
        description: `${newEmail} can now view this article`,
      });
    } catch (error) {
      console.error("Error adding share:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to add share",
        variant: "destructive",
      });
    }
  };

  const handleRemoveShare = async (shareId: string) => {
    try {
      const response = await fetch("/api/public-shares", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ shareId }),
      });

      if (!response.ok) throw new Error("Failed to remove share");
      setShares(shares.filter((s) => s.id !== shareId));
      toast({
        title: "Success",
        description: "Share access removed",
      });
    } catch (error) {
      console.error("Error removing share:", error);
      toast({
        title: "Error",
        description: "Failed to remove share",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <Share2 className="w-4 h-4 mr-2" />
          Share
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Share Article (View Only)</DialogTitle>
          <DialogDescription>
            Add emails to allow people to view this article. Recipients can view
            but cannot comment.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <label className="text-sm font-medium text-blue-900">
              Share Link
            </label>
            <p className="text-xs text-blue-700 mb-2">
              Send this link to anyone. They can view the article (no login
              required).
            </p>
            <div className="flex gap-2">
              <Input
                type="text"
                value={shareLink}
                readOnly
                className="text-xs bg-white"
              />
              <Button
                onClick={handleCopyLink}
                size="sm"
                variant="outline"
                className="shrink-0"
              >
                {copiedLink ? (
                  <Check className="w-4 h-4 text-green-600" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Email Address</label>
            <div className="flex gap-2">
              <Input
                type="email"
                placeholder="user@example.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddShare();
                }}
              />
            </div>
          </div>

          <Button
            onClick={handleAddShare}
            disabled={!newEmail.trim() || isLoading}
          >
            Add Viewer
          </Button>

          <div className="space-y-2">
            <label className="text-sm font-medium">Viewers</label>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {isLoading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : shares.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No one has been invited yet
                </p>
              ) : (
                shares.map((share) => (
                  <div
                    key={share.id}
                    className="flex items-center justify-between p-2 rounded-lg border border-border bg-muted/30"
                  >
                    <div>
                      <p className="text-sm font-medium">{share.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(share.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemoveShare(share.id)}
                      className="h-8 w-8 p-0 text-destructive"
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
