import { subscribe } from "@/core/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent events. Node runtime — no edge needed to stream. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("open", { runId: id });

      const unsubscribe = subscribe(id, (e) => {
        if ("done" in e) {
          send("done", { runId: id });
          try { controller.close(); } catch { /* already closed */ }
          return;
        }
        send("trace", e);
      });

      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { clearInterval(keepalive); }
      }, 15_000);

      return () => { clearInterval(keepalive); unsubscribe(); };
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
