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
    const { message, documentIds, conversationHistory } = await req.json();
    console.log("Chat request:", { message, documentIds: documentIds?.length });

    if (!message || !documentIds?.length) {
      throw new Error("Message and document IDs are required");
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Detect if this is a summary/overview request
    const lowerMessage = message.toLowerCase();
    const isSummaryRequest = lowerMessage.includes("summar") || 
                              lowerMessage.includes("overview") || 
                              lowerMessage.includes("what is this") ||
                              lowerMessage.includes("tell me about");

    // Get chunks from selected documents
    const { data: chunks, error: chunksError } = await supabase
      .from("document_chunks")
      .select("content, chunk_index, document_id, documents(name)")
      .in("document_id", documentIds)
      .order("chunk_index", { ascending: true })
      .limit(isSummaryRequest ? 50 : 100); // More chunks for better context

    if (chunksError) {
      console.error("Error fetching chunks:", chunksError);
      throw chunksError;
    }

    console.log("Fetched chunks:", chunks?.length || 0);

    let relevantChunks: any[];

    if (isSummaryRequest) {
      // For summary requests, take first chunks from each document (they usually contain key info)
      relevantChunks = (chunks || []).slice(0, 15);
    } else {
      // Simple keyword-based relevance scoring for specific questions
      const keywords = lowerMessage.split(/\s+/).filter((w: string) => w.length > 3);
      
      const scoredChunks = (chunks || []).map((chunk: any) => {
        const content = chunk.content.toLowerCase();
        let score = 0;
        for (const keyword of keywords) {
          if (content.includes(keyword)) {
            score += content.split(keyword).length - 1;
          }
        }
        return { ...chunk, score };
      });

      // Sort by relevance and take top chunks
      scoredChunks.sort((a: any, b: any) => b.score - a.score);
      relevantChunks = scoredChunks.slice(0, 10);
    }

    // Build context from chunks
    const context = relevantChunks
      .map((c: any) => `[From: ${c.documents?.name}]\n${c.content}`)
      .join("\n\n---\n\n");

    console.log("Context length:", context.length);

    // Build sources for response
    const sources = relevantChunks.slice(0, 5).map((c: any) => ({
      documentName: c.documents?.name || "Unknown",
      chunkIndex: c.chunk_index,
      content: c.content.slice(0, 200),
    }));

    // Prepare messages for LLM
    const systemPrompt = `You are a helpful AI assistant that answers questions based ONLY on the provided document context. 

IMPORTANT RULES:
1. Only use information from the provided context to answer questions
2. If the answer is not in the context, clearly say "I couldn't find this information in the uploaded documents"
3. Be precise and cite which document the information comes from when possible
4. Format responses clearly with bullet points or numbered lists when appropriate

DOCUMENT CONTEXT:
${context || "No relevant content found in the documents."}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...(conversationHistory || []).slice(-6),
      { role: "user", content: message },
    ];

    // Call Lovable AI Gateway
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY not configured");
    }

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages,
        stream: true,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI Gateway error:", aiResponse.status, errorText);
      
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Usage limit reached. Please add credits." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error("AI Gateway error");
    }

    // Stream the response back with sources prepended
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Send sources first
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ sources })}\n\n`));
        
        const reader = aiResponse.body?.getReader();
        if (!reader) return;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (error: unknown) {
    console.error("Chat error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
