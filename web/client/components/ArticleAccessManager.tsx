import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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

interface Access {
  id: string;
  email: string;
  access_level: "view" | "comment" | "edit";
  created_at: string;
}

interface ArticleAccessManagerProps {
  articleId: string;
  currentUserId?: string;
}

interface AccessWithToken extends Access {
  access_token?: string;
}

export function ArticleAccessManager({
  articleId,
  currentUserId,
}: ArticleAccessManagerProps) {
  const [accesses, setAccesses] = useState<AccessWithToken[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newAccessLevel, setNewAccessLevel] = useState<
    "view" | "comment" | "edit"
  >("comment");
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  const { toast } = useToast();

  const shareLink = `${window.location.origin}/article/${articleId}`;

  const handleCopyLink = () => {
    try {
      // Try modern Clipboard API first
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
            // Fallback to selection copy
            copyUsingSelection(shareLink);
          });
      } else {
        // Fallback for older browsers
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
      // Create a temporary textarea element
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);

      // Select and copy
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

  const handleCopyTokenLink = (accessId: string, token: string) => {
    const tokenLink = `${window.location.origin}/article/${articleId}?token=${token}`;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(tokenLink)
          .then(() => {
            setCopiedTokenId(accessId);
            toast({
              title: "Copied",
              description: "Personalized link copied to clipboard",
            });
            setTimeout(() => setCopiedTokenId(null), 2000);
          })
          .catch(() => {
            copyTokenUsingSelection(tokenLink, accessId);
          });
      } else {
        copyTokenUsingSelection(tokenLink, accessId);
      }
    } catch (error) {
      console.error("Failed to copy token link:", error);
      toast({
        title: "Error",
        description: "Failed to copy link",
        variant: "destructive",
      });
    }
  };

  const copyTokenUsingSelection = (text: string, accessId: string) => {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);

      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);

      setCopiedTokenId(accessId);
      toast({
        title: "Copied",
        description: "Personalized link copied to clipboard",
      });
      setTimeout(() => setCopiedTokenId(null), 2000);
    } catch (error) {
      console.error("Fallback token copy failed:", error);
      toast({
        title: "Error",
        description: "Failed to copy link. Please copy manually.",
      });
    }
  };

  useEffect(() => {
    if (isOpen && articleId) {
      console.log(`[ArticleAccessManager] useEffect triggered for article: ${articleId}`);
      fetchAccesses();
    }
  }, [articleId, isOpen]);

  const fetchAccesses = async () => {
    try {
      setIsLoading(true);
      if (!articleId) {
        console.error("ArticleAccessManager: Missing articleId");
        throw new Error("Article ID is missing");
      }
      console.log(`[ArticleAccessManager] Fetching accesses for article: ${articleId}`);
      const response = await fetch(
        `/api/article-access?articleId=${articleId}`,
      );
      if (!response.ok) throw new Error("Failed to fetch accesses");
      const data = await response.json();
      console.log(`[ArticleAccessManager] Loaded ${data?.length || 0} access records for article: ${articleId}`);
      setAccesses(data || []);
    } catch (error) {
      console.error("Error fetching accesses:", error);
      toast({
        title: "Error",
        description: "Failed to load access list",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddAccess = async () => {
    if (!newEmail.trim() || !newAccessLevel) return;

    if (!articleId) {
      toast({
        title: "Error",
        description: "Article ID is missing. Please refresh the page.",
        variant: "destructive",
      });
      return;
    }

    const normalizedEmail = newEmail.toLowerCase();
    const existingAccess = accesses.find(
      (a) => a.email.toLowerCase() === normalizedEmail,
    );

    if (existingAccess) {
      // Email already has access - update instead of insert
      if (existingAccess.access_level === newAccessLevel) {
        toast({
          title: "Info",
          description: `${newEmail} already has ${newAccessLevel} access`,
        });
      } else {
        await handleUpdateAccess(existingAccess.id, newAccessLevel);
      }
      setNewEmail("");
      setNewAccessLevel("comment");
      return;
    }

    try {
      console.log(`[ArticleAccessManager] Adding access for ${normalizedEmail} to article: ${articleId}`);
      const response = await fetch("/api/article-access", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          articleId,
          email: newEmail,
          accessLevel: newAccessLevel,
          userId: currentUserId,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to add access");
      }
      const newAccess = await response.json();
      setAccesses([...accesses, newAccess]);
      setNewEmail("");
      setNewAccessLevel("comment");
      toast({
        title: "Success",
        description: `Access granted to ${newEmail}`,
      });
    } catch (error) {
      console.error("Error adding access:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to grant access",
        variant: "destructive",
      });
    }
  };

  const handleUpdateAccess = async (
    accessId: string,
    accessLevel: "view" | "comment" | "edit",
  ) => {
    try {
      const response = await fetch("/api/article-access", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accessId,
          accessLevel,
        }),
      });

      if (!response.ok) throw new Error("Failed to update access");
      const updated = await response.json();
      setAccesses(accesses.map((a) => (a.id === accessId ? updated : a)));
      toast({
        title: "Success",
        description: "Access level updated",
      });
    } catch (error) {
      console.error("Error updating access:", error);
      toast({
        title: "Error",
        description: "Failed to update access",
        variant: "destructive",
      });
    }
  };

  const handleRemoveAccess = async (accessId: string) => {
    try {
      const response = await fetch("/api/article-access", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ accessId }),
      });

      if (!response.ok) throw new Error("Failed to remove access");
      setAccesses(accesses.filter((a) => a.id !== accessId));
      toast({
        title: "Success",
        description: "Access removed",
      });
    } catch (error) {
      console.error("Error removing access:", error);
      toast({
        title: "Error",
        description: "Failed to remove access",
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
          <DialogTitle>Share Article</DialogTitle>
          <DialogDescription>
            Add people by email to grant them access to this article
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <label className="text-sm font-medium text-blue-900">
              Share Link
            </label>
            <p className="text-xs text-blue-700 mb-2">
              This is a unique link that opens the article where clients can
              leave comments.
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
                  if (e.key === "Enter") handleAddAccess();
                }}
              />
              <Select
                value={newAccessLevel}
                onChange={(e) =>
                  setNewAccessLevel(
                    e.target.value as "view" | "comment" | "edit",
                  )
                }
                className="w-32"
              >
                <option value="comment">Comment</option>
              </Select>
            </div>
          </div>

          <Button
            onClick={handleAddAccess}
            disabled={!newEmail.trim() || isLoading}
          >
            Grant Access
          </Button>

          <div className="space-y-2">
            <label className="text-sm font-medium">Access List</label>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {isLoading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : accesses.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No one has access yet
                </p>
              ) : (
                accesses.map((access) => (
                  <div key={access.id} className="space-y-2 p-3 rounded-lg border border-border bg-muted/20">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">{access.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(access.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Select
                          value={access.access_level}
                          onChange={(e) =>
                            handleUpdateAccess(
                              access.id,
                              e.target.value as "view" | "comment" | "edit",
                            )
                          }
                          className="w-28 h-8"
                        >
                          <option value="comment">Comment</option>
                        </Select>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveAccess(access.id)}
                          className="h-8 w-8 p-0 text-destructive"
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    {access.access_token && (
                      <div className="flex gap-2 items-center text-xs bg-white/50 p-2 rounded border border-border/50">
                        <input
                          type="text"
                          value={`${window.location.origin}/article/${articleId}?token=${access.access_token}`}
                          readOnly
                          className="flex-1 text-xs bg-transparent border-0 outline-none"
                        />
                        <Button
                          onClick={() =>
                            handleCopyTokenLink(access.id, access.access_token!)
                          }
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 shrink-0"
                        >
                          {copiedTokenId === access.id ? (
                            <Check className="w-3 h-3 text-green-600" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </Button>
                      </div>
                    )}
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
