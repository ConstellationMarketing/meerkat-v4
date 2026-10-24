import { useState, useEffect } from "react"; // useEffect is already imported
import { Button } from "@/components/ui/button";
import { X, MessageCircle, Check } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Comment {
  id: string;
  user_id: string;
  comment: string;
  selected_text?: string;
  text_position?: {
    section?: string;
    startOffset?: number;
    endOffset?: number;
    userEmail?: string;
  };
  resolved: boolean;
  created_at: string;
  userEmail?: string;
}

interface CommentsSidebarProps {
  articleId: string;
  currentUserEmail?: string;
  isOpen: boolean;
  onClose: () => void;
  selectedText?: string;
  onCommentClick?: (comment: Comment) => void;
}

export function CommentsSidebar({
  articleId,
  currentUserEmail,
  isOpen,
  onClose,
  selectedText,
  onCommentClick,
}: CommentsSidebarProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filterType, setFilterType] = useState<
    "all" | "unresolved" | "resolved"
  >("all");
  const { toast } = useToast();

  useEffect(() => {
    if (isOpen && articleId) {
      fetchComments();
    }
  }, [articleId, isOpen]);

  const fetchComments = async () => {
    try {
      setIsLoading(true);
      const response = await fetch(`/api/comments?articleId=${articleId}`);
      if (!response.ok) throw new Error("Failed to fetch comments");
      const data = await response.json();
      setComments(data || []);
    } catch (error) {
      console.error("Error fetching comments:", error);
      toast({
        title: "Error",
        description: "Failed to load comments",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResolveComment = async (commentId: string, resolved: boolean) => {
    try {
      const response = await fetch("/api/comments", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          commentId,
          resolved: !resolved,
        }),
      });

      if (!response.ok) throw new Error("Failed to update comment");
      const updated = await response.json();
      setComments(comments.map((c) => (c.id === commentId ? updated : c)));
    } catch (error) {
      console.error("Error resolving comment:", error);
      toast({
        title: "Error",
        description: "Failed to update comment",
        variant: "destructive",
      });
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      const response = await fetch("/api/comments", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ commentId }),
      });

      if (!response.ok) throw new Error("Failed to delete comment");
      setComments(comments.filter((c) => c.id !== commentId));
      toast({
        title: "Success",
        description: "Comment deleted",
      });
    } catch (error) {
      console.error("Error deleting comment:", error);
      toast({
        title: "Error",
        description: "Failed to delete comment",
        variant: "destructive",
      });
    }
  };

  const unresolvedComments = comments
    .filter((c) => !c.resolved)
    .sort((a, b) => {
      const dateA = new Date(a.created_at).getTime();
      const dateB = new Date(b.created_at).getTime();
      return dateB - dateA;
    });

  const resolvedComments = comments
    .filter((c) => c.resolved)
    .sort((a, b) => {
      const dateA = new Date(a.created_at).getTime();
      const dateB = new Date(b.created_at).getTime();
      return dateB - dateA;
    });

  const renderComment = (comment: Comment) => (
    <div
      key={comment.id}
      onClick={() => onCommentClick?.(comment)}
      className={`p-3 rounded-lg border cursor-pointer transition-all hover:shadow-md break-words overflow-hidden ${
        comment.resolved
          ? "bg-muted/50 border-border/50 opacity-60"
          : "bg-secondary/50 border-border hover:border-primary/50"
      }`}
    >
      {comment.selected_text && (
        <p className="text-xs text-muted-foreground italic mb-2 p-2 bg-muted/50 rounded break-words overflow-hidden">
          "{comment.selected_text}"
        </p>
      )}
      <p className="text-sm break-words overflow-hidden">{comment.comment}</p>
      <p className="text-xs text-muted-foreground mt-2 break-words overflow-hidden">
        {comment.userEmail || comment.text_position?.userEmail || "Anonymous"}
      </p>
      <div className="flex gap-1 mt-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleResolveComment(comment.id, comment.resolved)}
          className="h-6 px-2 text-xs flex-1"
        >
          <Check className="w-3 h-3 mr-1" />
          {comment.resolved ? "Unresolve" : "Resolve"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleDeleteComment(comment.id)}
          className="h-6 px-2 text-xs text-destructive flex-1"
        >
          Delete
        </Button>
      </div>
    </div>
  );

  if (!isOpen) return null;

  return (
    <div className="fixed right-0 top-0 w-80 bottom-0 border-l border-border bg-background flex flex-col z-40 shadow-lg">
      <div className="flex items-center justify-between p-4 border-b border-border bg-background sticky top-0 z-50">
        <div className="flex items-center gap-2">
          <MessageCircle className="w-5 h-5" />
          <h3 className="font-semibold">Comments ({comments.length})</h3>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-8 w-8 p-0"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 pt-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading comments...</p>
        ) : (
          <>
            {filterType === "all" || filterType === "unresolved"
              ? unresolvedComments.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2 text-foreground">
                      Unresolved ({unresolvedComments.length})
                    </h4>
                    <div className="space-y-2">
                      {unresolvedComments.map((comment) =>
                        renderComment(comment),
                      )}
                    </div>
                  </div>
                )
              : null}

            {filterType === "all" || filterType === "resolved"
              ? resolvedComments.length > 0 && (
                  <div>
                    <h4 className="text-sm font-semibold mb-2 text-muted-foreground">
                      Resolved ({resolvedComments.length})
                    </h4>
                    <div className="space-y-2">
                      {resolvedComments.map((comment) =>
                        renderComment(comment),
                      )}
                    </div>
                  </div>
                )
              : null}

            {((filterType === "unresolved" &&
              unresolvedComments.length === 0) ||
              (filterType === "resolved" && resolvedComments.length === 0) ||
              (filterType === "all" && comments.length === 0)) && (
              <p className="text-sm text-muted-foreground">
                {filterType === "unresolved"
                  ? "No unresolved comments"
                  : filterType === "resolved"
                    ? "No resolved comments"
                    : "No comments yet"}
              </p>
            )}
          </>
        )}
      </div>

      <div className="p-4 border-t border-border space-y-2 bg-background z-50">
        <div className="flex gap-2">
          <Button
            variant={filterType === "unresolved" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType("unresolved")}
            className="flex-1 text-xs h-7"
          >
            Unresolved
          </Button>
          <Button
            variant={filterType === "resolved" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType("resolved")}
            className="flex-1 text-xs h-7"
          >
            Resolved
          </Button>
          <Button
            variant={filterType === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType("all")}
            className="flex-1 text-xs h-7"
          >
            All
          </Button>
        </div>
      </div>
    </div>
  );
}
