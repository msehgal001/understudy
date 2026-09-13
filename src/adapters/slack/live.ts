import type { SlackAdapter, WriteResult } from "@/adapters/types";
import { httpJson } from "@/adapters/http";
import { UnverifiableError } from "@/core/action";

export class LiveSlackAdapter implements SlackAdapter {
  readonly mode = "live" as const;
  constructor(private token: string) {}

  async postMessage(channel: string, text: string): Promise<WriteResult> {
    const res = await httpJson("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text }),
    });
    // Slack answers 200 with ok:false for application errors. Surface that honestly.
    const body = res.body as { ok?: boolean; error?: string };
    return { status: body?.ok ? 200 : 400, body: res.body };
  }

  async listMessages(channel: string) {
    const res = await httpJson(
      `https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=20`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    const body = res.body as { ok?: boolean; error?: string; messages?: { ts: string; text: string }[] };
    // Returning [] on an API error would convert "I could not look" into "it is
    // not there" — a check would then report the message as missing when the real
    // answer is unknown. Unknown must stay unknown.
    if (!body?.ok) throw new UnverifiableError(`slack conversations.history: ${body?.error ?? "unknown error"}`);
    return (body.messages ?? []).map((m) => ({ ts: m.ts, text: m.text }));
  }

  async deleteMessage(channel: string, ts: string): Promise<WriteResult> {
    const res = await httpJson("https://slack.com/api/chat.delete", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, ts }),
    });
    const body = res.body as { ok?: boolean };
    return { status: body?.ok ? 200 : 400, body: res.body };
  }
}
