import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import {
  FileText,
  Trash2,
  Loader2,
  CheckCircle,
  Clock,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";

interface Document {
  id: string;
  name: string;
  file_type: string;
  file_size: number;
  status: string;
  storage_path: string;
  created_at: string;
}

interface DocumentListProps {
  selectedDocIds: string[];
  onSelectionChange: (ids: string[]) => void;
  refreshTrigger?: number;
}

export function DocumentList({
  selectedDocIds,
  onSelectionChange,
  refreshTrigger,
}: DocumentListProps) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const fetchDocuments = async () => {
    const { data, error } = await supabase
      .from("documents")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching documents:", error);
      return;
    }

    setDocuments(data || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchDocuments();

    // Subscribe to realtime updates
    const channel = supabase
      .channel("documents-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "documents" },
        () => {
          fetchDocuments();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [refreshTrigger]);

  const handleDelete = async (id: string) => {
    const doc = documents.find((d) => d.id === id);
    if (!doc) return;

    try {
      // Delete document chunks first
      const { error: chunksError } = await supabase
        .from("document_chunks")
        .delete()
        .eq("document_id", id);

      if (chunksError) {
        console.error("Error deleting chunks:", chunksError);
      }

      // Delete from storage using the correct storage_path
      const { error: storageError } = await supabase.storage
        .from("documents")
        .remove([doc.storage_path]);

      if (storageError) {
        console.error("Error deleting from storage:", storageError);
      }

      // Delete from database
      const { error } = await supabase.from("documents").delete().eq("id", id);

      if (error) throw error;

      // Remove from selection
      onSelectionChange(selectedDocIds.filter((docId) => docId !== id));

      toast({
        title: "Document deleted",
        description: `${doc.name} has been removed`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const toggleSelection = (id: string) => {
    // Single selection: either select this doc or deselect if already selected
    if (selectedDocIds.includes(id)) {
      onSelectionChange([]);
    } else {
      onSelectionChange([id]);
    }
  };

  const documentCount = documents.length;

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "ready":
        return <CheckCircle className="h-4 w-4 text-success" />;
      case "processing":
        return <Loader2 className="h-4 w-4 text-primary animate-spin" />;
      case "error":
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <FileText className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No documents uploaded yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground mb-2">
        {documentCount}/10 documents
      </div>
      <RadioGroup value={selectedDocIds[0] || ""}>
        {documents.map((doc) => (
          <div
            key={doc.id}
            className={cn(
              "flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer",
              selectedDocIds.includes(doc.id)
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/30 bg-card/50"
            )}
            onClick={() => doc.status === "ready" && toggleSelection(doc.id)}
          >
            <RadioGroupItem
              value={doc.id}
              disabled={doc.status !== "ready"}
              onClick={(e) => e.stopPropagation()}
            />

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary shrink-0" />
              <span className="font-medium truncate text-sm">{doc.name}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {formatFileSize(doc.file_size)} • {doc.file_type.toUpperCase()}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {getStatusIcon(doc.status)}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                handleDelete(doc.id);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          </div>
        ))}
      </RadioGroup>
    </div>
  );
}
