import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Sanitize text to remove null bytes and non-printable characters
function sanitizeText(text: string): string {
  return text
    // Remove null bytes and other control characters that Postgres can't handle
    .replace(/\x00/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Replace multiple spaces/newlines with single ones
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Extract text from PDF (works in edge/Deno).
async function extractPdfText(arrayBuffer: ArrayBuffer): Promise<string> {
  const { getDocumentProxy, extractText } = await import(
    "https://esm.sh/unpdf@0.7.1"
  );

  const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
  const { text } = await extractText(pdf, { mergePages: true });

  try {
    // Some implementations expose destroy/cleanup
    (pdf as any)?.destroy?.();
  } catch {
    // ignore
  }

  const joinedText = Array.isArray(text) ? text.join("\n\n") : text;
  const cleaned = sanitizeText(joinedText || "");
  const alphaCount = (cleaned.match(/[A-Za-z]/g) || []).length;
  return alphaCount >= 50 ? cleaned : "";
}

// Extract text from DOCX
function extractDocxText(arrayBuffer: ArrayBuffer): string {
  const textDecoder = new TextDecoder("utf-8", { fatal: false });
  const rawContent = textDecoder.decode(new Uint8Array(arrayBuffer));

  // Extract text from XML tags
  const textMatches = rawContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
  const text = textMatches
    .map((m) => m.replace(/<[^>]+>/g, ""))
    .join(" ");

  return sanitizeText(text);
}

// Extract plain text
function extractPlainText(arrayBuffer: ArrayBuffer): string {
  const textDecoder = new TextDecoder("utf-8", { fatal: false });
  const text = textDecoder.decode(new Uint8Array(arrayBuffer));
  return sanitizeText(text);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { documentId } = await req.json();
    console.log("Processing document:", documentId);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get document info
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .single();

    if (docError || !doc) {
      throw new Error("Document not found");
    }

    console.log("Document found:", doc.name, "Type:", doc.file_type);

    // Download file from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(doc.storage_path);

    if (downloadError || !fileData) {
      console.error("Download error:", downloadError);
      throw new Error("Failed to download file");
    }

    console.log("File downloaded, size:", fileData.size);

    // Extract text based on file type
    let text = "";
    const arrayBuffer = await fileData.arrayBuffer();

    if (doc.file_type === "pdf") {
      console.log("Extracting PDF text...");
      text = await extractPdfText(arrayBuffer);
    } else if (doc.file_type === "docx") {
      console.log("Extracting DOCX text...");
      text = extractDocxText(arrayBuffer);
    } else if (doc.file_type === "txt" || doc.file_type === "csv") {
      console.log("Extracting plain text...");
      text = extractPlainText(arrayBuffer);
    }

    console.log("Extracted text length:", text.length);
    console.log("Text preview:", text.substring(0, 500));

    if (text.length < 50) {
      console.error("Insufficient text extracted from document");
      
      // Update document status to error with more info
      await supabase
        .from("documents")
        .update({ status: "error" })
        .eq("id", documentId);
        
      throw new Error("Could not extract sufficient text from document. The PDF may be image-based or protected.");
    }

    // Chunk the text with better sentence awareness
    const chunkSize = 1000;
    const overlap = 200;
    const chunks: string[] = [];
    
    // Clean up the text further
    text = text.replace(/\s+/g, " ").trim();
    
    for (let i = 0; i < text.length; i += chunkSize - overlap) {
      let chunk = text.slice(i, i + chunkSize).trim();
      
      // Try to end at sentence boundary
      if (i + chunkSize < text.length) {
        const lastPeriod = chunk.lastIndexOf(".");
        const lastNewline = chunk.lastIndexOf("\n");
        const boundary = Math.max(lastPeriod, lastNewline);
        if (boundary > chunkSize / 2) {
          chunk = chunk.slice(0, boundary + 1).trim();
        }
      }
      
      // Sanitize each chunk individually to be safe
      chunk = sanitizeText(chunk);
      
      if (chunk.length > 50) {
        chunks.push(chunk);
      }
    }

    console.log("Created chunks:", chunks.length);

    // Delete existing chunks for this document
    await supabase
      .from("document_chunks")
      .delete()
      .eq("document_id", documentId);

    // Store chunks in database
    if (chunks.length > 0) {
      const chunkRecords = chunks.map((content, index) => ({
        document_id: documentId,
        content,
        chunk_index: index,
        metadata: { source: doc.name },
      }));

      // Insert in batches of 100
      for (let i = 0; i < chunkRecords.length; i += 100) {
        const batch = chunkRecords.slice(i, i + 100);
        const { error: insertError } = await supabase
          .from("document_chunks")
          .insert(batch);

        if (insertError) {
          console.error("Error inserting chunks batch:", insertError);
          throw insertError;
        }
      }
    }

    // Update document status
    await supabase
      .from("documents")
      .update({ status: "ready" })
      .eq("id", documentId);

    console.log("Document processed successfully");

    return new Response(JSON.stringify({ success: true, chunks: chunks.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Processing error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
