import fs from "node:fs";
import path from "node:path";

/** Minimal .env loader — no dependency needed for KEY=value. */
export function loadEnv(root = process.cwd()) {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export type OffboardTarget = {
  /** The departing employee. */
  githubLogin: string;
  email: string;
  name: string;
  /** Who inherits transferred resources. Must not themselves be departing — scenario 8 tests this. */
  successorEmail: string;
  successorGithubLogin: string;
};

export type Config = {
  githubToken: string;
  githubOrg: string;
  googleCreds: string;
  linearApiKey: string;
  slackBotToken: string;
  slackChannel: string;
  anthropicApiKey: string;
  target: OffboardTarget;
};

export function readConfig(): Config {
  loadEnv();
  const e = process.env;
  return {
    githubToken: e.GITHUB_TOKEN ?? "",
    githubOrg: e.GITHUB_ORG ?? "",
    googleCreds: e.GOOGLE_OAUTH_CREDENTIALS ?? "",
    linearApiKey: e.LINEAR_API_KEY ?? "",
    slackBotToken: e.SLACK_BOT_TOKEN ?? "",
    slackChannel: e.SLACK_CHANNEL ?? "#offboarding",
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? "",
    target: {
      githubLogin: e.DEPARTING_GITHUB_LOGIN ?? "",
      email: e.DEPARTING_EMAIL ?? "",
      name: e.DEPARTING_NAME ?? e.DEPARTING_GITHUB_LOGIN ?? "the departing employee",
      successorEmail: e.SUCCESSOR_EMAIL ?? "",
      successorGithubLogin: e.SUCCESSOR_GITHUB_LOGIN ?? "",
    },
  };
}
