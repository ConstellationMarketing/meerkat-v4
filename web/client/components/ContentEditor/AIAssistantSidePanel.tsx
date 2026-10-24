import { useState, useRef, useEffect } from "react";
import { MessageCircle, Send, X, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ReactMarkdown from "react-markdown";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface AIAssistantSidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  position?: "left" | "right";
  positionType?: "fixed" | "absolute";
}

const INITIAL_GREETING: Message = {
  id: "greeting",
  role: "assistant",
  content:
    "Ask me anything about editing your article! I can help you with:\n\n• Improving readability and grammar\n• Making content more engaging\n• Changing tone and style\n• Reorganizing sections\n• Expanding or condensing content\n\nWhat would you like help with?",
};

export function AIAssistantSidePanel({
  isOpen,
  onClose,
  position = "left",
  positionType = "fixed",
}: AIAssistantSidePanelProps) {
  const [messages, setMessages] = useState<Message[]>([INITIAL_GREETING]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const fetchAIResponse = async (userMessage: string): Promise<string> => {
    try {
      // Calls the /api/chat Netlify function which proxies to OpenRouter
      // server-side (so the OPENROUTER_API_KEY never ships to the browser).
      // Replaces the dead n8n webhook this used to call.
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessage,
          sessionId: sessionIdRef.current,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errMsg =
          data?.error || `Chat API responded with status: ${response.status}`;
        throw new Error(errMsg);
      }

      return (
        data.output ||
        data.message ||
        data.response ||
        data.text ||
        JSON.stringify(data)
      );
    } catch (error) {
      console.error("Error fetching AI response:", error);
      return "Sorry, I encountered an error connecting to the AI service. Please try again in a moment.";
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input,
    };

    const userInput = input;
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    const assistantContent = await fetchAIResponse(userInput);
    const assistantResponse: Message = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: assistantContent,
    };
    setMessages((prev) => [...prev, assistantResponse]);
    setIsLoading(false);
  };

  if (!isOpen) return null;

  return (
    <div
      className={`${positionType} flex flex-col p-0 gap-0 rounded-lg shadow-2xl border-0 bg-white transition-all duration-300 z-50 ${
        isExpanded
          ? "inset-12 w-auto h-auto max-w-2xl max-h-[90vh]"
          : `w-96 max-w-[90vw] h-auto max-h-[60vh] bottom-8 ${position === "right" ? "right-8" : "left-8"}`
      }`}
    >
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white px-6 py-4 rounded-t-lg shrink-0">
        <div className="flex items-center gap-3 w-full justify-between">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 bg-blue-400 rounded-lg">
              <MessageCircle className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-white text-lg font-semibold">
                AI Assistant
              </h3>
              <p className="text-blue-100 text-sm font-normal">Help with editing</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-white hover:bg-blue-700 p-1 rounded transition-colors"
              title={isExpanded ? "Collapse AI Assistant" : "Expand AI Assistant"}
            >
              {isExpanded ? (
                <Minimize2 className="w-5 h-5" />
              ) : (
                <Maximize2 className="w-5 h-5" />
              )}
            </button>
            <button
              onClick={onClose}
              className="text-white hover:bg-blue-700 p-1 rounded transition-colors"
              title="Close AI Assistant"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Messages Container */}
      <div className={`flex-1 overflow-y-auto flex flex-col gap-4 bg-gray-50 ${isExpanded ? "p-6" : "p-4"}`}>
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex ${
              message.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            {message.role === "assistant" && (
              <div className="w-7 h-7 rounded-full bg-blue-100 flex-shrink-0 flex items-center justify-center mr-3 mt-1">
                <MessageCircle className="w-4 h-4 text-blue-600" />
              </div>
            )}
            <div
              className={`rounded-lg px-3 py-2 text-sm break-words ${
                isExpanded ? "max-w-md" : "max-w-xs"
              } ${
                message.role === "user"
                  ? "bg-blue-500 text-white rounded-br-none"
                  : "bg-gray-100 text-gray-900 rounded-bl-none border border-gray-200"
              }`}
            >
              {message.role === "assistant" ? (
                <div className={`prose ${isExpanded ? "prose-base" : "prose-sm"} max-w-none`}>
                  <ReactMarkdown
                    components={{
                      p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                      strong: ({ children }) => <strong className="font-bold">{children}</strong>,
                      em: ({ children }) => <em className="italic">{children}</em>,
                      ul: ({ children }) => <ul className="list-disc list-inside mb-2">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal list-inside mb-2">{children}</ol>,
                      li: ({ children }) => <li className="mb-1">{children}</li>,
                      blockquote: ({ children }) => (
                        <blockquote className="border-l-2 border-blue-400 pl-2 italic mb-2">{children}</blockquote>
                      ),
                      code: ({ children }) => (
                        <code className="bg-gray-200 px-1 py-0.5 rounded text-xs font-mono">{children}</code>
                      ),
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <span className="whitespace-pre-wrap">{message.content}</span>
              )}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="w-7 h-7 rounded-full bg-blue-100 flex-shrink-0 flex items-center justify-center mr-3 mt-1">
              <div className="w-2 h-2 bg-blue-600 rounded-full animate-pulse" />
            </div>
            <div className="bg-gray-100 text-gray-900 rounded-lg px-3 py-2 border border-gray-200 rounded-bl-none">
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                <div
                  className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                  style={{ animationDelay: "0.1s" }}
                />
                <div
                  className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                  style={{ animationDelay: "0.2s" }}
                />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className={`border-t border-gray-200 shrink-0 bg-white rounded-b-lg ${isExpanded ? "px-6 py-4" : "px-6 py-4"}`}>
        <form onSubmit={handleSendMessage} className={`flex gap-2 items-center ${isExpanded ? "gap-3" : "gap-2"}`}>
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask me anything..."
            disabled={isLoading}
            className={`flex-1 bg-white border-gray-300 focus:ring-blue-500 ${isExpanded ? "text-base h-11" : "text-sm h-9"}`}
          />
          <Button
            type="submit"
            disabled={isLoading || !input.trim()}
            className={`bg-blue-500 hover:bg-blue-600 text-white rounded ${isExpanded ? "px-4 h-11" : "px-3 h-9"}`}
          >
            <Send className={isExpanded ? "w-5 h-5" : "w-4 h-4"} />
          </Button>
        </form>
      </div>
    </div>
  );
}
