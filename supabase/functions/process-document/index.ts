import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    // Download file from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(doc.storage_path);

    if (downloadError || !fileData) {
      throw new Error("Failed to download file");
    }

    // Extract text based on file type
    let text = "";
    
    if (doc.file_type === "pdf") {
      // For PDF, we'll use a simple text extraction approach
      const arrayBuffer = await fileData.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      
      // Simple PDF text extraction (basic approach)
      const textDecoder = new TextDecoder("utf-8", { fatal: false });
      const rawText = textDecoder.decode(uint8Array);
      
      // Extract text between stream markers (simplified)
      const streamMatches = rawText.match(/stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g) || [];
      for (const match of streamMatches) {
        const content = match.replace(/stream[\r\n]+/, "").replace(/[\r\n]+endstream/, "");
        // Filter printable ASCII
        const filtered = content.replace(/[^\x20-\x7E\n\r\t]/g, " ");
        if (filtered.trim().length > 20) {
          text += filtered + "\n";
        }
      }
      
      // Fallback: extract any readable text
      if (text.length < 100) {
        text = rawText.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s+/g, " ");
      }
    } else if (doc.file_type === "docx") {
      // DOCX is a ZIP with XML content
      const arrayBuffer = await fileData.arrayBuffer();
      const textDecoder = new TextDecoder("utf-8", { fatal: false });
      const rawContent = textDecoder.decode(new Uint8Array(arrayBuffer));
      
      // Extract text from XML tags
      const textMatches = rawContent.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
      text = textMatches
        .map((m) => m.replace(/<[^>]+>/g, ""))
        .join(" ");
    }

    console.log("Extracted text length:", text.length);

    // Chunk the text
    const chunkSize = 1000;
    const overlap = 200;
    const chunks: string[] = [];
    
    for (let i = 0; i < text.length; i += chunkSize - overlap) {
      const chunk = text.slice(i, i + chunkSize).trim();
      if (chunk.length > 50) {
        chunks.push(chunk);
      }
    }

    console.log("Created chunks:", chunks.length);

    // Store chunks in database
    if (chunks.length > 0) {
      const chunkRecords = chunks.map((content, index) => ({
        document_id: documentId,
        content,
        chunk_index: index,
        metadata: { source: doc.name },
      }));

      const { error: insertError } = await supabase
        .from("document_chunks")
        .insert(chunkRecords);

      if (insertError) {
        console.error("Error inserting chunks:", insertError);
        throw insertError;
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
