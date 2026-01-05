import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DocumentUpload } from "@/components/documents/DocumentUpload";
import { DocumentList } from "@/components/documents/DocumentList";
import {
  Plus,
  LogOut,
  FileText,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SidebarProps {
  selectedDocIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onNewChat: () => void;
}

export function Sidebar({
  selectedDocIds,
  onSelectionChange,
  onNewChat,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const navigate = useNavigate();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/");
  };

  return (
    <div
      className={cn(
        "flex flex-col h-full bg-sidebar border-r border-sidebar-border transition-all duration-300",
        collapsed ? "w-16" : "w-80"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-sidebar-border">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg gradient-primary">
              <MessageSquare className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="font-semibold text-lg">DocChat</span>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setCollapsed(!collapsed)}
          className="shrink-0"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </Button>
      </div>

      {!collapsed && (
        <>
          {/* New Chat Button */}
          <div className="p-4">
            <Button
              onClick={onNewChat}
              className="w-full gradient-primary"
            >
              <Plus className="h-4 w-4 mr-2" />
              New Chat
            </Button>
          </div>

          {/* Documents Section */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className="px-4 pb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Documents
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowUpload(!showUpload)}
                className="text-xs"
              >
                {showUpload ? "Hide" : "Upload"}
              </Button>
            </div>

            {showUpload && (
              <div className="px-4 pb-4">
                <DocumentUpload
                  onUploadComplete={() => {
                    setRefreshTrigger((t) => t + 1);
                    setShowUpload(false);
                  }}
                />
              </div>
            )}

            <ScrollArea className="flex-1 px-4">
              <DocumentList
                selectedDocIds={selectedDocIds}
                onSelectionChange={onSelectionChange}
                refreshTrigger={refreshTrigger}
              />
            </ScrollArea>

            {selectedDocIds.length > 0 && (
              <div className="px-4 py-3 border-t border-sidebar-border">
                <p className="text-xs text-muted-foreground">
                  1 document selected for chat
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-sidebar-border">
            <Button
              variant="ghost"
              className="w-full justify-start text-muted-foreground hover:text-foreground"
              onClick={handleLogout}
            >
              <LogOut className="h-4 w-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </>
      )}

      {collapsed && (
        <div className="flex-1 flex flex-col items-center py-4 gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={onNewChat}
            title="New Chat"
          >
            <Plus className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(false)}
            title="Documents"
          >
            <FileText className="h-5 w-5" />
          </Button>
        </div>
      )}
    </div>
  );
}
