import type { SlackAdapter, WriteResult } from "@/adapters/types";
import type { WorldState } from "@/core/world";
import { FaultInjector, type Fault } from "@/adapters/faults";

export class ShadowSlackAdapter implements SlackAdapter {
  readonly mode = "shadow" as const;
  private faults: FaultInjector;
  private tsSeq = 1;

  constructor(private world: WorldState, faults: Fault[] = []) {
    this.faults = new FaultInjector(faults);
  }

  async postMessage(channel: string, text: string): Promise<WriteResult> {
    this.faults.check("slack.postMessage");
    const ts = `1757${String(700000 + this.tsSeq++).padStart(6, "0")}.000100`;
    this.world.slack.messages.push({ channel, ts, text });
    return { status: 200, body: { ok: true, channel, ts, message: { text } } };
  }

  async listMessages(channel: string) {
    this.faults.check("slack.listMessages");
    return this.world.slack.messages.filter((m) => m.channel === channel).map((m) => ({ ts: m.ts, text: m.text }));
  }

  async deleteMessage(channel: string, ts: string): Promise<WriteResult> {
    this.faults.check("slack.deleteMessage");
    this.world.slack.messages = this.world.slack.messages.filter((m) => !(m.channel === channel && m.ts === ts));
    return { status: 200, body: { ok: true, channel, ts } };
  }
}
