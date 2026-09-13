/** Credential, scope and fixture check. Run before a demo; every row must be green. */
import { readConfig } from "@/core/config";
import { httpJson } from "@/adapters/http";
import { LiveGithubAdapter } from "@/adapters/github/live";
import { green, red, amber, dim, bold, mono } from "@/cli/render";

type Row = { name: string; ok: boolean | "warn"; detail: string };
const rows: Row[] = [];
const add = (name: string, ok: boolean | "warn", detail: string) => rows.push({ name, ok, detail });

async function main() {
  const c = readConfig();
  const REPO = process.env.DEMO_REPO ?? "payments-core";
  const TEAM = process.env.DEMO_TEAM ?? "payments";

  // --- Anthropic
  add("ANTHROPIC_API_KEY", !!c.anthropicApiKey, c.anthropicApiKey ? "set" : "missing — the stub planner will be used instead of claude-sonnet-5");

  // --- GitHub
  if (!c.githubToken) add("GITHUB_TOKEN", false, "missing");
  else {
    try {
      const res = await httpJson("https://api.github.com/user", { headers: { Authorization: `Bearer ${c.githubToken}` } });
      const scopes = res.headers.get("x-oauth-scopes") ?? "";
      const user = (res.body as { login?: string })?.login ?? "?";
      add("GITHUB_TOKEN", res.status === 200, `${user} · scopes: ${scopes || "(fine-grained)"}`);
      const hasOrgWrite = /\badmin:org\b|\bwrite:org\b/.test(scopes);
      add("github org write scope", hasOrgWrite, hasOrgWrite ? "admin:org present" : "MISSING — run: gh auth refresh -h github.com -s admin:org,repo");
    } catch (e) { add("GITHUB_TOKEN", false, String(e)); }
  }

  add("GITHUB_ORG", !!c.githubOrg, c.githubOrg || "missing");
  add("DEPARTING_GITHUB_LOGIN", !!c.target.githubLogin, c.target.githubLogin || "missing");

  if (c.githubToken && c.githubOrg && c.target.githubLogin) {
    const gh = new LiveGithubAdapter(c.githubToken);
    try {
      const m = await gh.getOrgMembership(c.githubOrg, c.target.githubLogin);
      add("org membership state", m.state === "active", `${m.state}${m.state === "pending" ? " — the invitation must be ACCEPTED or the fixture cannot exist" : ""}`);

      const eff = await gh.getEffectivePermission(c.githubOrg, REPO, c.target.githubLogin);
      add("seeded fixture", eff.permission === "admin", `effective permission on ${REPO}: ${eff.permission}${eff.permission !== "admin" ? " — run npm run seed:github" : ""}`);

      const teams = await gh.listRepoTeams(c.githubOrg, REPO);
      const t = teams.find((x) => x.slug === TEAM);
      add("team grant", !!t && t.permission === "admin", t ? `team:${TEAM} has ${t.permission}` : `team:${TEAM} has no access to ${REPO}`);

      const base = await gh.getOrgDefaultRepoPermission(c.githubOrg);
      add("org base permission", base !== "none" ? true : "warn", `default_repository_permission=${base}${base === "none" ? " — the plan-proof failure path is off" : ""}`);
    } catch (e) { add("seeded fixture", false, String(e)); }
  }

  // --- Drive
  if (!c.googleCreds) add("GOOGLE_OAUTH_CREDENTIALS", "warn", "missing — Drive falls back to fixtures");
  else {
    try {
      const { driveClient } = await import("@/adapters/drive/live");
      const d = driveClient(c.googleCreds);
      const about = await d.about.get({ fields: "user(emailAddress)" });
      add("GOOGLE_OAUTH_CREDENTIALS", true, `authorised as ${about.data.user?.emailAddress}`);

      // The Drive fixture: a file the departing user can reach through BOTH a
      // personal permission and an anyone-with-link record.
      const shared = await d.files.list({
        q: `'${c.target.email}' in readers or '${c.target.email}' in writers`,
        fields: "files(id,name)", pageSize: 20,
      });
      const files = shared.data.files ?? [];
      let linkShared = 0;
      for (const f of files) {
        const perms = await d.permissions.list({ fileId: f.id!, fields: "permissions(type)" });
        if ((perms.data.permissions ?? []).some((x) => x.type === "anyone")) linkShared++;
      }
      add("drive fixture", files.length > 0 && linkShared > 0,
        files.length === 0 ? "no files shared with the departing address — run npm run seed:drive"
          : `${files.length} file(s) shared, ${linkShared} also link-shared${linkShared ? "" : " — run npm run seed:drive"}`);
    } catch (e) { add("GOOGLE_OAUTH_CREDENTIALS", "warn", `not usable: ${e instanceof Error ? e.message.slice(0, 80) : e}`); }
  }

  // --- Linear
  if (!c.linearApiKey) add("LINEAR_API_KEY", false, "missing");
  else {
    try {
      const res = await httpJson("https://api.linear.app/graphql", {
        method: "POST", headers: { Authorization: c.linearApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ viewer { id name } }" }),
      });
      const name = (res.body as { data?: { viewer?: { name?: string } } })?.data?.viewer?.name;
      add("LINEAR_API_KEY", !!name, name ? `viewer: ${name}` : `unexpected response: ${JSON.stringify(res.body).slice(0, 80)}`);
    } catch (e) { add("LINEAR_API_KEY", false, String(e)); }

    // Where the audit issue is filed must resolve to a real team BEFORE a run
    // starts. A live run had the model file it into a Linear team named after the
    // GitHub team slug; the precondition refused, nothing was written to the wrong
    // place, and the run ended unresolved over a detail the model could not know.
    try {
      const res = await httpJson("https://api.linear.app/graphql", {
        method: "POST", headers: { Authorization: c.linearApiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ teams(first: 50) { nodes { id key name } } }" }),
      });
      const nodes = (res.body as { data?: { teams?: { nodes?: { id: string; key: string; name: string }[] } } })?.data?.teams?.nodes ?? [];
      if (c.linearTeamId) {
        const hit = nodes.find((t) => t.id === c.linearTeamId);
        add("linear audit team", !!hit, hit ? `LINEAR_TEAM_ID -> ${hit.name} (${hit.key})` : `LINEAR_TEAM_ID=${c.linearTeamId} matches no team in this workspace`);
      } else {
        add("linear audit team", nodes.length > 0, nodes.length ? `unset; resolves to ${nodes[0].name} (${nodes[0].key})` : "no teams in this workspace");
      }
    } catch (e) { add("linear audit team", false, String(e)); }
  }

  // --- Slack. auth.test returning ok is not enough: posting and reading back are
  // separate scopes, and without the read the verify phase cannot confirm anything.
  if (!c.slackBotToken) add("SLACK_BOT_TOKEN", false, "missing");
  else {
    try {
      const res = await httpJson("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${c.slackBotToken}` } });
      const b = res.body as { ok?: boolean; team?: string; error?: string; bot_id?: string };
      const scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      add("SLACK_BOT_TOKEN", !!b?.ok, b?.ok ? `team: ${b.team} · ${b.bot_id ? "bot token" : "USER token (posts appear as you)"}` : `error: ${b?.error}`);
      add("slack chat:write", scopes.includes("chat:write"), scopes.includes("chat:write") ? "can post" : "MISSING — the report cannot be posted");

      const canRead = ["channels:history", "groups:history", "im:history"].some((x) => scopes.includes(x));
      add("slack history scope", canRead ? true : "warn",
        canRead ? "the Slack postcondition can re-read" :
        "MISSING (channels:history) — the Slack post cannot be verified, so runs end `unresolved` rather than `verified`");

      const hist = await httpJson(`https://slack.com/api/conversations.history?channel=${encodeURIComponent(c.slackChannel)}&limit=1`,
        { headers: { Authorization: `Bearer ${c.slackBotToken}` } });
      const hb = hist.body as { ok?: boolean; error?: string };
      add("SLACK_CHANNEL", !!hb?.ok ? true : "warn", hb?.ok ? `${c.slackChannel} readable` : `${c.slackChannel}: ${hb?.error}`);
    } catch (e) { add("SLACK_BOT_TOKEN", false, String(e)); }
  }

  // --- render
  console.log(`\n${bold("PREFLIGHT")}\n`);
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    const mark = r.ok === true ? green("✓") : r.ok === "warn" ? amber("!") : red("✗");
    console.log(`  ${mark} ${mono(r.name.padEnd(width))}  ${r.ok === false ? red(r.detail) : dim(r.detail)}`);
  }
  const failed = rows.filter((r) => r.ok === false);
  console.log(failed.length ? `\n  ${red(`${failed.length} check(s) failed.`)}\n` : `\n  ${green("all required checks passed.")}\n`);
  process.exit(failed.length ? 1 : 0);
}
main();
