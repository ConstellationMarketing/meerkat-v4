import { useState, useEffect } from "react";
import { ChevronDown, Clock, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Revision {
  id: string;
  version_number: number;
  edited_at: string;
  html_content: string;
}

interface RevisionHistoryProps {
  articleId: string;
  onRestore?: (content: string) => void;
}

export function RevisionHistory({
  articleId,
  onRestore,
}: RevisionHistoryProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedRevision, setSelectedRevision] = useState<Revision | null>(
    null,
  );

  const fetchRevisions = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(
        `/.netlify/functions/get-article-revisions?article_id=${articleId}`,
      );

      if (!response.ok) {
        throw new Error(
          `Failed to fetch revisions: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();
      setRevisions(data.revisions || []);
    } catch (error) {
      console.error("Error fetching revisions:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && revisions.length === 0 && !isLoading) {
      fetchRevisions();
    }
  }, [isOpen]);

  const handleRestore = (revision: Revision) => {
    if (onRestore) {
      onRestore(revision.html_content);
      setIsOpen(false);
      setSelectedRevision(null);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className="gap-2 text-xs"
      >
        <Clock className="h-3 w-3" />
        History
        <ChevronDown
          className={`h-3 w-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </Button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-80 bg-card border border-border rounded-lg shadow-lg z-50">
          <div className="p-4 border-b border-border">
            <h3 className="font-semibold text-sm text-foreground">
              Revision History
            </h3>
            {revisions.length === 0 && !isLoading && (
              <p className="text-xs text-muted-foreground mt-2">
                No revisions yet
              </p>
            )}
          </div>

          {isLoading ? (
            <div className="p-4 text-center">
              <p className="text-xs text-muted-foreground">
                Loading revisions...
              </p>
            </div>
          ) : revisions.length > 0 ? (
            <div className="max-h-96 overflow-y-auto">
              {revisions.map((revision) => (
                <div
                  key={revision.id}
                  className={`p-3 border-b border-border hover:bg-secondary cursor-pointer transition-colors ${
                    selectedRevision?.id === revision.id ? "bg-secondary" : ""
                  }`}
                  onClick={() => setSelectedRevision(revision)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="text-xs font-medium text-foreground">
                        Version {revision.version_number}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatDate(revision.edited_at)}
                      </p>
                    </div>
                  </div>

                  {selectedRevision?.id === revision.id && (
                    <Button
                      size="sm"
                      variant="default"
                      className="w-full mt-2 h-7 text-xs gap-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRestore(revision);
                      }}
                    >
                      <RotateCcw className="h-3 w-3" />
                      Restore
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
