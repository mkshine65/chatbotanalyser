import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Extract text from PDF using pdf.js-extract
async function extractPdfText(arrayBuffer: ArrayBuffer): Promise<string> {
  try {
    // Use pdf.js for proper PDF text extraction
    const pdfjs = await import("https://esm.sh/pdfjs-dist@4.0.379/build/pdf.mjs");
    
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) });
    const pdf = await loadingTask.promise;
    
    let fullText = "";
    
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(" ");
      fullText += pageText + "\n\n";
    }
    
    return fullText;
  } catch (error) {
    console.error("PDF.js extraction failed:", error);
    
    // Fallback: try basic text extraction
    const textDecoder = new TextDecoder("utf-8", { fatal: false });
    const rawText = textDecoder.decode(new Uint8Array(arrayBuffer));
    
    // Extract readable text between parentheses (PDF text objects)
    const textMatches: string[] = [];
    const regex = /\(([^)]+)\)/g;
    let match;
    while ((match = regex.exec(rawText)) !== null) {
      const text = match[1]
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\");
      if (text.length > 1 && /[a-zA-Z0-9]/.test(text)) {
        textMatches.push(text);
      }
    }
    
    if (textMatches.length > 0) {
      return textMatches.join(" ");
    }
    
    // Last resort: filter for printable text
    return rawText
      .replace(/[^\x20-\x7E\n\r\t]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

// Extract text from DOCX
function extractDocxText(arrayBuffer: ArrayBuffer): string {
  const textDecoder = new TextDecoder("utf-8", { fatal: false });
  const rawContent = textDecoder.decode(new Uint8Array(arrayBuffer));
  
  // Extract text from XML tags
  const textMatches = rawContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
  return textMatches
    .map((m) => m.replace(/<[^>]+>/g, ""))
    .join(" ");
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
      const textDecoder = new TextDecoder("utf-8");
      text = textDecoder.decode(new Uint8Array(arrayBuffer));
    }

    console.log("Extracted text length:", text.length);
    console.log("Text preview:", text.substring(0, 500));

    if (text.length < 50) {
      console.error("Insufficient text extracted");
      throw new Error("Could not extract sufficient text from document");
    }

    // Chunk the text with better sentence awareness
    const chunkSize = 1000;
    const overlap = 200;
    const chunks: string[] = [];
    
    // Clean up the text
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
