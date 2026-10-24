import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface EditableArticleContentProps {
  content: string;
  articleId: string;
  isEditMode: boolean;
  onSave?: (content: string) => void;
  onCommentClick?: (text: string) => void;
}

export function EditableArticleContent({
  content,
  articleId,
  isEditMode,
  onSave,
  onCommentClick,
}: EditableArticleContentProps) {
  const [editedContent, setEditedContent] = useState(content);
  const [selectedText, setSelectedText] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    setEditedContent(content);
  }, [content]);

  const handleSave = async () => {
    try {
      const response = await fetch("/.netlify/functions/update-article", {
        method: "PATCH",
        body: JSON.stringify({
          articleId,
          field: "received_article",
          value: {
            ...JSON.parse(localStorage.getItem(`article_${articleId}`) || "{}"),
            content: editedContent,
          },
        }),
      });

      if (!response.ok) throw new Error("Failed to save");

      onSave?.(editedContent);
      toast({
        title: "Success",
        description: "Article saved successfully",
      });
    } catch (error) {
      console.error("Error saving:", error);
      toast({
        title: "Error",
        description: "Failed to save article",
        variant: "destructive",
      });
    }
  };

  const handleTextSelection = () => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      setSelectedText(selection.toString());
    }
  };

  const handleCommentOnSelection = () => {
    if (selectedText) {
      onCommentClick?.(selectedText);
      setSelectedText("");
    }
  };

  if (isEditMode) {
    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold">Edit Content</h3>
          <Button onClick={handleSave} size="sm" className="h-8">
            Save Changes
          </Button>
        </div>
        <Textarea
          value={editedContent}
          onChange={(e) => setEditedContent(e.target.value)}
          className="min-h-96 font-mono text-sm resize-none"
          placeholder="Article content in HTML format"
        />
      </div>
    );
  }

  return (
    <div className="relative group">
      <div
        ref={contentRef}
        onMouseUp={handleTextSelection}
        className="article-content w-full p-6 bg-white rounded-lg border border-border/30"
        dangerouslySetInnerHTML={{ __html: editedContent }}
      />
      {selectedText && (
        <div className="absolute top-4 right-4 p-2 bg-white rounded-lg border border-border shadow-lg z-10">
          <Button
            size="sm"
            variant="outline"
            onClick={handleCommentOnSelection}
            className="h-7 px-2 text-xs gap-1"
            title="Comment on selection"
          >
            <MessageCircle className="w-3 h-3" />
            Comment
          </Button>
        </div>
      )}
    </div>
  );
}
