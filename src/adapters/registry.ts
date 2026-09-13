import type { AdapterSet, AdapterMode } from "@/adapters/types";
import type { WorldState } from "@/core/world";
import type { Config } from "@/core/config";
import type { Fault } from "@/adapters/faults";

import { LiveGithubAdapter } from "@/adapters/github/live";
import { LiveLinearAdapter } from "@/adapters/linear/live";
import { LiveSlackAdapter } from "@/adapters/slack/live";
import { LiveDriveAdapter, driveClient } from "@/adapters/drive/live";
import { UnconfiguredDriveAdapter } from "@/adapters/drive/unconfigured";

import { ShadowGithubAdapter } from "@/adapters/github/shadow";
import { ShadowDriveAdapter } from "@/adapters/drive/shadow";
import { ShadowLinearAdapter } from "@/adapters/linear/shadow";
import { ShadowSlackAdapter } from "@/adapters/slack/shadow";

/**
 * THE SWITCH. The only place in the codebase that decides live versus shadow.
 * Actions, checks and the agent receive an AdapterSet and cannot tell which they hold.
 */
export function adapterSet(mode: AdapterMode, opts: { config?: Config; world?: WorldState; faults?: Fault[] }): AdapterSet {
  if (mode === "shadow") {
    const world = opts.world;
    if (!world) throw new Error("shadow mode requires a WorldState");
    const f = opts.faults ?? [];
    return {
      mode,
      github: new ShadowGithubAdapter(world, f),
      drive: new ShadowDriveAdapter(world, f),
      linear: new ShadowLinearAdapter(world, f),
      slack: new ShadowSlackAdapter(world, f),
    };
  }

  const c = opts.config;
  if (!c) throw new Error("live mode requires config");
  return {
    mode,
    github: new LiveGithubAdapter(c.githubToken),
    // A missing credential must degrade the app out of the run, not crash the
    // process before discovery starts. The unconfigured adapter is explicit about
    // being absent rather than quietly behaving like an empty account.
    drive: c.googleCreds ? new LiveDriveAdapter(driveClient(c.googleCreds)) : new UnconfiguredDriveAdapter(),
    linear: new LiveLinearAdapter(c.linearApiKey),
    slack: new LiveSlackAdapter(c.slackBotToken),
  };
}
