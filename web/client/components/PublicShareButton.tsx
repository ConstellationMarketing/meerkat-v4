import { Share2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

interface PublicShareButtonProps {
  articleId: string;
}

export function PublicShareButton({ articleId }: PublicShareButtonProps) {
  const [copiedLink, setCopiedLink] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const { toast } = useToast();

  const shareLink = `${window.location.origin}/share-article/${articleId}`;

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
    } catch (err) {
      console.error("Fallback copy failed:", err);
      toast({
        title: "Error",
        description: "Failed to copy link",
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
            Share this link with anyone to let them view this article
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <label className="text-sm font-medium text-blue-900">
              Public Share Link
            </label>
            <p className="text-xs text-blue-700 mb-2">
              Anyone with this link can view this article
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
