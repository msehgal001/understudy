import fs from "node:fs";
import { adapterSet } from "@/adapters/registry";
import { execute } from "@/core/executor";
import { Tracer } from "@/core/trace";
import { cloneWorld } from "@/core/world";
import { readConfig } from "@/core/config";
import { seedWorldFromLive } from "@/core/seed";
import { stubPlanner } from "@/agent/stub-planner";
import { makePlanner } from "@/agent/loop";
import { saveRun, saveEvents } from "@/core/db";
import { startRun, publish, finishRun } from "@/core/bus";
import type { Scenario } from "@/eval/types";
import type { Action } from "@/core/action";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { scenario?: string; mode?: "live" | "shadow"; approve?: boolean };
  const runId = `run-${Date.now().toString(36)}`;
  const config = readConfig();

  startRun(runId);
  const tracer = new Tracer(runId);
  tracer.subscribe((e) => publish(runId, e));

  // Fire and forget: the client watches progress over SSE.
  (async () => {
    try {
      let live, shadow, build, mode: string;

      if (body.scenario) {
        const file = `src/eval/scenarios/${body.scenario}.json`;
        if (!fs.existsSync(file)) throw new Error(`no such scenario: ${body.scenario}`);
        const s = JSON.parse(fs.readFileSync(file, "utf8")) as Scenario;
        live = adapterSet("shadow", { world: cloneWorld(s.world), faults: s.faults ?? [] });
        shadow = adapterSet("shadow", { world: cloneWorld(s.world) });
        build = { org: s.world.github.org, target: s.target, slackChannel: s.slackChannel };
        mode = `scenario:${s.id}`;
      } else {
        live = adapterSet("live", { config });
        const world = await seedWorldFromLive(live, config.target, config.githubOrg, tracer);
        shadow = adapterSet("shadow", { world });
        build = { org: config.githubOrg, target: config.target, slackChannel: config.slackChannel };
        mode = "live";
      }

      const planner = config.anthropicApiKey ? makePlanner(tracer) : stubPlanner;
      const approver = async (pending: Action[]) => {
        const ids = new Set<string>();
        if (body.approve) for (const a of pending) ids.add(a.id);
        tracer.emit({
          type: "phase", phase: "approve", label: "approve:decision",
          detail: { granted: [...ids], withheld: pending.filter((a) => !ids.has(a.id)).map((a) => a.id) },
        });
        return ids;
      };

      const result = await execute({ runId, tracer, build, live, shadow, planner, approver });
      saveRun(result, { mode, target: build.target.githubLogin, org: build.org });
      saveEvents(runId, tracer.events);
    } catch (err) {
      tracer.emit({ type: "note", label: "run:failed", ok: false, detail: String(err) });
      try { saveEvents(runId, tracer.events); } catch { /* ignore */ }
    } finally {
      tracer.close();
      finishRun(runId);
    }
  })();

  return Response.json({ runId });
}
