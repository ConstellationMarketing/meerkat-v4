import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TimePicker } from "@/components/TimePicker";

interface EditingFeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  articleTitle?: string;
  articleId?: string;
  onSubmit: (data: {
    timeSpent: string;
    issues: string;
    articleTitle?: string;
    articleLink?: string;
    userEmail?: string;
  }) => void;
}

export function EditingFeedbackModal({
  isOpen,
  onClose,
  articleTitle,
  articleId,
  onSubmit,
}: EditingFeedbackModalProps) {
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [issues, setIssues] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    try {
      setIsSubmitting(true);
      const timeSpentString = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

      // Construct article link if articleId is available
      // Always use meerkatv3.netlify.app as the domain
      const articleLink = articleId
        ? `https://meerkatv3.netlify.app/editor/${articleId}`
        : undefined;

      onSubmit({
        timeSpent: timeSpentString,
        issues,
        articleTitle,
        articleLink,
      });
      setHours(0);
      setMinutes(0);
      setIssues("");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-gradient-to-br from-slate-700 via-slate-600 to-slate-700 text-white px-8 py-6 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-40 h-40 bg-white/5 rounded-full -mr-20 -mt-20" />
          <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/5 rounded-full -ml-16 -mb-16" />
          <div className="relative flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold">Editing Feedback</h2>
              <p className="text-white/80 text-sm mt-1">
                Share your editing experience
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-white hover:bg-white/20 p-2 rounded-lg transition-all duration-200 hover:scale-110"
              title="Close"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-8 py-8 bg-gradient-to-b from-gray-50 to-white space-y-6">
          {/* Time Spent Section */}
          <div>
            <label className="block text-sm font-semibold text-foreground mb-3">
              How long did this take to edit?
            </label>
            <TimePicker
              hours={hours}
              minutes={minutes}
              onHoursChange={setHours}
              onMinutesChange={setMinutes}
            />
          </div>

          {/* Issues Section */}
          <div>
            <label className="block text-sm font-semibold text-foreground mb-3">
              What issues did the original output have?
            </label>
            <textarea
              placeholder="Describe any problems, errors, or areas that needed improvement..."
              value={issues}
              onChange={(e) => setIssues(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-transparent resize-none"
              rows={5}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-8 pb-8 pt-4 bg-gray-50 border-t border-gray-200 flex gap-3">
          <Button
            onClick={onClose}
            variant="outline"
            className="flex-1"
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            className="flex-1 bg-slate-700 hover:bg-slate-800 text-white"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Saving..." : "Save Feedback"}
          </Button>
        </div>
      </div>
    </div>
  );
}
