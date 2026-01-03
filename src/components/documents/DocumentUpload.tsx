import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Upload, FileText, X, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import * as PDFJS from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min?url";

// Configure PDF.js worker for Vite
PDFJS.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface UploadingFile {
  file: File;
  progress: number;
  status: "uploading" | "processing" | "done" | "error";
  error?: string;
}

interface DocumentUploadProps {
  onUploadComplete?: () => void;
}

function chunkText(text: string) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const chunkSize = 1000;
  const overlap = 200;
  const chunks: string[] = [];

  for (let i = 0; i < cleaned.length; i += chunkSize - overlap) {
    const chunk = cleaned.slice(i, i + chunkSize).trim();
    if (chunk.length > 50) chunks.push(chunk);
  }

  return chunks;
}

async function extractPdfTextClient(file: File) {
  const buffer = await file.arrayBuffer();
  const pdf = await PDFJS.getDocument({ data: new Uint8Array(buffer) }).promise;

  let fullText = "";
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const textContent = await page.getTextContent();
    const pageText = (textContent.items as any[])
      .map((item) => (typeof item?.str === "string" ? item.str : ""))
      .join(" ");
    fullText += pageText + "\n";
  }

  try {
    (pdf as any)?.destroy?.();
  } catch {
    // ignore
  }

  return fullText;
}

export function DocumentUpload({ onUploadComplete }: DocumentUploadProps) {
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const { toast } = useToast();

  const processFile = async (file: File, userId: string) => {
    const fileExt = file.name.split(".").pop()?.toLowerCase();
    const supported = ["pdf", "docx", "csv", "txt"] as const;
    if (!fileExt || !(supported as readonly string[]).includes(fileExt)) {
      throw new Error("Unsupported file format");
    }

    const filePath = `${userId}/${Date.now()}-${file.name}`;

    // Upload to storage
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .upload(filePath, file);

    if (uploadError) throw uploadError;

    // Create document record
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .insert({
        user_id: userId,
        name: file.name,
        file_type: fileExt,
        file_size: file.size,
        storage_path: filePath,
        status: "processing",
      })
      .select()
      .single();

    if (docError) throw docError;

    // DOCX is still processed on the backend (keeps this change minimal).
    if (fileExt === "docx") {
      const { error: processError } = await supabase.functions.invoke("process-document", {
        body: { documentId: doc.id },
      });

      if (processError) {
        console.error("Processing error:", processError);
        await supabase.from("documents").update({ status: "error" }).eq("id", doc.id);
        throw processError;
      }

      return doc;
    }

    // PDF/CSV/TXT are processed client-side to ensure clean, readable chunks.
    const extractedText =
      fileExt === "pdf" ? await extractPdfTextClient(file) : await file.text();

    if (!extractedText || extractedText.trim().length < 50) {
      await supabase.from("documents").update({ status: "error" }).eq("id", doc.id);
      throw new Error(
        "Could not extract readable text from this file. If it's a scanned PDF, OCR support would be needed."
      );
    }

    const chunks = chunkText(extractedText);

    // Replace any existing chunks
    await supabase.from("document_chunks").delete().eq("document_id", doc.id);

    for (let i = 0; i < chunks.length; i += 100) {
      const batch = chunks.slice(i, i + 100).map((content, index) => ({
        document_id: doc.id,
        content,
        chunk_index: i + index,
        metadata: { source: file.name },
      }));

      const { error: insertError } = await supabase.from("document_chunks").insert(batch);
      if (insertError) throw insertError;
    }

    await supabase.from("documents").update({ status: "ready" }).eq("id", doc.id);

    return doc;
  };

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: "Error",
          description: "You must be logged in to upload documents",
          variant: "destructive",
        });
        return;
      }

      const validFiles = acceptedFiles.filter((file) => {
        const ext = file.name.split(".").pop()?.toLowerCase();
        const isValid = ext === "pdf" || ext === "docx" || ext === "csv" || ext === "txt";
        const sizeOk = file.size <= 10 * 1024 * 1024; // 10MB limit
        return isValid && sizeOk;
      });

      if (validFiles.length !== acceptedFiles.length) {
        toast({
          title: "Some files skipped",
          description: "Only PDF, DOCX, CSV and TXT files under 10MB are supported",
          variant: "destructive",
        });
      }

      if (validFiles.length === 0) return;

      const newUploadingFiles: UploadingFile[] = validFiles.map((file) => ({
        file,
        progress: 0,
        status: "uploading" as const,
      }));

      setUploadingFiles((prev) => [...prev, ...newUploadingFiles]);

      for (let i = 0; i < validFiles.length; i++) {
        const file = validFiles[i];
        const fileIndex = uploadingFiles.length + i;

        try {
          // Simulate progress for better UX
          const progressInterval = setInterval(() => {
            setUploadingFiles((prev) =>
              prev.map((f, idx) =>
                idx === fileIndex && f.progress < 90
                  ? { ...f, progress: f.progress + 10 }
                  : f
              )
            );
          }, 200);

          setUploadingFiles((prev) =>
            prev.map((f, idx) =>
              idx === fileIndex ? { ...f, status: "uploading" } : f
            )
          );

          await processFile(file, user.id);

          clearInterval(progressInterval);

          setUploadingFiles((prev) =>
            prev.map((f, idx) =>
              idx === fileIndex ? { ...f, progress: 100, status: "done" } : f
            )
          );

          toast({
            title: "Document uploaded",
            description: `${file.name} is ready`,
          });
        } catch (error: any) {
          setUploadingFiles((prev) =>
            prev.map((f, idx) =>
              idx === fileIndex
                ? { ...f, status: "error", error: error.message }
                : f
            )
          );

          toast({
            title: "Upload failed",
            description: error.message,
            variant: "destructive",
          });
        }
      }

      onUploadComplete?.();
    },
    [toast, uploadingFiles.length, onUploadComplete]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "text/csv": [".csv"],
      "text/plain": [".txt"],
    },
    maxSize: 10 * 1024 * 1024,
  });

  const removeFile = (index: number) => {
    setUploadingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      <div
        {...getRootProps()}
        className={cn(
          "border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-200",
          isDragActive
            ? "border-primary bg-primary/10"
            : "border-border hover:border-primary/50 hover:bg-card/50"
        )}
      >
        <input {...getInputProps()} />
        <div className="flex flex-col items-center gap-3">
          <div className="p-4 rounded-full bg-primary/10">
            <Upload className="h-6 w-6 text-primary" />
          </div>
          <div>
            <p className="font-medium">
              {isDragActive ? "Drop files here" : "Drag & drop documents"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              PDF, DOCX, CSV and TXT files up to 10MB
            </p>
          </div>
          <Button variant="outline" size="sm" className="mt-2">
            Browse Files
          </Button>
        </div>
      </div>

      {uploadingFiles.length > 0 && (
        <div className="space-y-2">
          {uploadingFiles.map((item, index) => (
            <div
              key={index}
              className="flex items-center gap-3 p-3 bg-card rounded-lg border border-border"
            >
              <FileText className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{item.file.name}</p>
                {item.status === "uploading" || item.status === "processing" ? (
                  <Progress value={item.progress} className="h-1 mt-2" />
                ) : null}
                {item.status === "error" && (
                  <p className="text-xs text-destructive mt-1">{item.error}</p>
                )}
              </div>
              <div className="shrink-0">
                {item.status === "uploading" || item.status === "processing" ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : item.status === "done" ? (
                  <CheckCircle className="h-4 w-4 text-success" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-destructive" />
                )}
              </div>
              <button
                onClick={() => removeFile(index)}
                className="p-1 hover:bg-muted rounded"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
