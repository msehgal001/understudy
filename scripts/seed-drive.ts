/**
 * Provisions the live Drive fixture. Idempotent, and scoped: it only ever touches
 * files it created itself, inside a folder named by DEMO_DRIVE_FOLDER.
 *
 * Two files, mirroring the eval scenarios:
 *   1. A doc shared with the departing employee as a writer. Plain revoke case.
 *   2. A doc shared with them AND published "anyone with the link". Removing the
 *      user permission returns 204 and leaves the file world-readable — the Drive
 *      equivalent of the GitHub org-base trap, and equally plan-proof: there is no
 *      per-user record to delete that closes it.
 *
 * We authenticate as the successor, not the departing user, so no file here is
 * owned by the departing account. The sole-owner transfer case is covered by the
 * eval fixtures instead; standing it up live would need Workspace admin with
 * domain-wide delegation.
 */
import { google } from "googleapis";
import { driveClient } from "@/adapters/drive/live";
import { readConfig } from "@/core/config";
import { green, red, amber, dim, bold, mono } from "@/cli/render";

const FOLDER = process.env.DEMO_DRIVE_FOLDER ?? "understudy-demo";
const DOC_PLAIN = "Q4 Payments Runbook";
const DOC_LINK = "Public Launch Notes";

async function main() {
  const c = readConfig();
  if (!c.googleCreds) { console.error(red("GOOGLE_OAUTH_CREDENTIALS is not set")); process.exit(2); }
  const drive = driveClient(c.googleCreds);
  const departing = c.target.email;
  const step = (s: string) => console.log(`  ${dim("·")} ${s}`);

  const me = await drive.about.get({ fields: "user(emailAddress)" });
  console.log(`\n${bold("SEEDING DRIVE")} ${dim(`as ${me.data.user?.emailAddress} · departing=${departing}`)}\n`);

  const found = await drive.files.list({
    q: `name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id,name)",
  });
  let folderId = found.data.files?.[0]?.id;
  if (!folderId) {
    const made = await drive.files.create({
      requestBody: { name: FOLDER, mimeType: "application/vnd.google-apps.folder" }, fields: "id",
    });
    folderId = made.data.id!;
    step(`created folder ${FOLDER}`);
  } else step(`folder ${FOLDER} exists`);

  async function ensureDoc(name: string): Promise<string> {
    const q = await drive.files.list({
      q: `name='${name}' and '${folderId}' in parents and trashed=false`, fields: "files(id)",
    });
    const existing = q.data.files?.[0]?.id;
    if (existing) { step(`doc "${name}" exists`); return existing; }
    const made = await drive.files.create({
      requestBody: { name, mimeType: "application/vnd.google-apps.document", parents: [folderId!] }, fields: "id",
    });
    step(`created doc "${name}"`);
    return made.data.id!;
  }

  async function ensurePermission(fileId: string, body: { type: string; role: string; emailAddress?: string }) {
    const perms = await drive.permissions.list({ fileId, fields: "permissions(id,type,role,emailAddress)" });
    const match = (perms.data.permissions ?? []).find(
      (p) => p.type === body.type && (body.emailAddress ? p.emailAddress === body.emailAddress : true),
    );
    if (match) return;
    await drive.permissions.create({
      fileId, sendNotificationEmail: false,
      requestBody: { type: body.type, role: body.role, emailAddress: body.emailAddress },
    });
  }

  const plainId = await ensureDoc(DOC_PLAIN);
  await ensurePermission(plainId, { type: "user", role: "writer", emailAddress: departing });
  step(`${departing} is a writer on "${DOC_PLAIN}"`);

  const linkId = await ensureDoc(DOC_LINK);
  await ensurePermission(linkId, { type: "user", role: "writer", emailAddress: departing });
  await ensurePermission(linkId, { type: "anyone", role: "reader" });
  step(`${departing} is a writer on "${DOC_LINK}" AND it is shared with anyone-with-link`);

  // Assert the trap: the link permission is a record independent of the user's.
  const check = await drive.permissions.list({ fileId: linkId, fields: "permissions(id,type,role,emailAddress)" });
  const perms = check.data.permissions ?? [];
  const hasUser = perms.some((p) => p.emailAddress === departing);
  const hasLink = perms.some((p) => p.type === "anyone");
  console.log("");
  if (!hasUser || !hasLink) {
    console.error(red(`FIXTURE ASSERTION FAILED: user=${hasUser} link=${hasLink}`));
    process.exit(2);
  }
  console.log(`  ${green("✓")} fixture verified on ${mono(DOC_LINK)}`);
  console.log(`  ${dim(`paths: user:${departing}(writer) + link-sharing:anyone(reader)`)}`);
  console.log(`\n  ${green("ready.")} ${dim("Deleting the user permission will return 204 and leave the file world-readable.")}`);
  console.log(`  ${amber("note")} ${dim("only files inside " + FOLDER + " are touched by this script.")}\n`);
  void google;
}
main().catch((e) => { console.error(red(e instanceof Error ? e.message : String(e))); process.exit(1); });
