import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface FloatingCommentBoxProps {
  articleId: string;
  selectedText: string;
  currentUserEmail?: string;
  onCommentAdded?: () => void;
  onClose: () => void;
  position?: { x: number; y: number };
}

export function FloatingCommentBox({
  articleId,
  selectedText,
  currentUserEmail,
  onCommentAdded,
  onClose,
  position: initialPosition,
}: FloatingCommentBoxProps) {
  const [comment, setComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    const boxWidth = 320; // w-80 = 320px
    const boxHeight = 280; // Approximate height
    const gap = 8; // Gap from selection

    // If position is provided from selection, use it
    if (initialPosition) {
      let leftPos = initialPosition.x + gap;
      let topPos = initialPosition.y + gap;

      // If box would go off screen on the right, position to the left
      if (leftPos + boxWidth > window.innerWidth - 16) {
        leftPos = initialPosition.x - boxWidth - gap;
      }

      // Constrain horizontal position to stay on screen
      leftPos = Math.max(
        16,
        Math.min(leftPos, window.innerWidth - boxWidth - 16),
      );

      // Constrain vertical position to stay on screen
      topPos = Math.max(
        16,
        Math.min(topPos, window.innerHeight - boxHeight - 16),
      );

      setPosition({
        left: leftPos,
        top: topPos,
      });
    } else {
      // Fallback: Calculate position based on current selection
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();

        // Position to the right of the selection, centered vertically
        let leftPos = rect.right + gap;
        let topPos = rect.top + (rect.height - boxHeight) / 2;

        // If box would go off screen on the right, position to the left
        if (leftPos + boxWidth > window.innerWidth - 16) {
          leftPos = rect.left - boxWidth - gap;
        }

        // Constrain horizontal position to stay on screen
        leftPos = Math.max(
          16,
          Math.min(leftPos, window.innerWidth - boxWidth - 16),
        );

        // Constrain vertical position to stay on screen
        topPos = Math.max(
          16,
          Math.min(topPos, window.innerHeight - boxHeight - 16),
        );

        setPosition({
          left: leftPos,
          top: topPos,
        });
      }
    }
  }, [selectedText, initialPosition]);

  const handleSubmit = async () => {
    if (!comment.trim()) {
      toast({
        title: "Error",
        description: "Please enter a comment",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/comments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          articleId,
          userId: currentUserEmail,
          userEmail: currentUserEmail,
          selectedText,
          comment: comment.trim(),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("API error response:", errorData);
        throw new Error(errorData.error || "Failed to add comment");
      }

      toast({
        title: "Success",
        description: "Comment added",
      });

      setComment("");
      onCommentAdded?.();
      onClose();
    } catch (error) {
      console.error("Error adding comment:", error);
      toast({
        title: "Error",
        description:
          error instanceof Error ? error.message : "Failed to add comment",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      ref={boxRef}
      className="fixed bg-white border border-border rounded-lg shadow-xl z-50 w-80"
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-semibold text-muted-foreground">
            ADD COMMENT
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-6 w-6 p-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {selectedText && (
          <p className="text-xs text-muted-foreground italic p-2 bg-muted/50 rounded border border-border/30">
            "{selectedText}"
          </p>
        )}

        <Textarea
          placeholder="Write your comment..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          className="min-h-24 resize-none text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.ctrlKey) {
              handleSubmit();
            }
          }}
        />

        <div className="flex gap-2">
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !comment.trim()}
            className="flex-1 h-8"
            size="sm"
          >
            {isSubmitting ? "Saving..." : "Save"}
          </Button>
          <Button onClick={onClose} variant="outline" className="h-8" size="sm">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
