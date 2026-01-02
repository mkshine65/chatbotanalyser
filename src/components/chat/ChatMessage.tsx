import { cn } from "@/lib/utils";
import { Bot, User, FileText } from "lucide-react";

interface Source {
  documentName: string;
  chunkIndex: number;
  content: string;
}

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  isStreaming?: boolean;
}

export function ChatMessage({ role, content, sources, isStreaming }: ChatMessageProps) {
  const isUser = role === "user";

  return (
    <div
      className={cn(
        "flex gap-4 px-4 py-6 animate-slide-up",
        isUser ? "bg-transparent" : "bg-card/50"
      )}
    >
      <div
        className={cn(
          "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center",
          isUser
            ? "bg-primary/20 text-primary"
            : "gradient-primary text-primary-foreground"
        )}
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      <div className="flex-1 space-y-3 min-w-0">
        <div className="prose prose-invert max-w-none">
          <p className="text-foreground leading-relaxed whitespace-pre-wrap">
            {content}
            {isStreaming && (
              <span className="inline-block w-2 h-5 ml-1 bg-primary animate-pulse-subtle" />
            )}
          </p>
        </div>

        {sources && sources.length > 0 && (
          <div className="pt-3 border-t border-border">
            <p className="text-xs text-muted-foreground mb-2 font-medium">
              Sources:
            </p>
            <div className="flex flex-wrap gap-2">
              {sources.map((source, index) => (
                <div
                  key={index}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-secondary/50 rounded-md text-xs text-secondary-foreground hover:bg-secondary transition-colors cursor-default"
                >
                  <FileText className="h-3 w-3" />
                  <span className="truncate max-w-[150px]">
                    {source.documentName}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
