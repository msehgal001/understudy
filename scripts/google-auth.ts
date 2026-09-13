/**
 * One-time Google OAuth flow: produces google-oauth.json with a refresh token.
 *
 * A refresh token is required because the agent runs unattended — there is no
 * consent round-trip at run time. `prompt=consent` forces Google to issue one even
 * if this client was authorised before; without it a re-authorisation returns an
 * access token only and the file is useless tomorrow.
 */
import fs from "node:fs";
import http from "node:http";
import { google } from "googleapis";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? process.argv[2];
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? process.argv[3];
const PORT = Number(process.env.OAUTH_PORT ?? 8123);
const REDIRECT = `http://localhost:${PORT}/callback`;
const OUT = "google-oauth.json";

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("usage: tsx scripts/google-auth.ts <client_id> <client_secret>");
    process.exit(2);
  }
  const oauth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT);
  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive"],
  });

  const code: string = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      if (!u.pathname.startsWith("/callback")) {
        res.writeHead(404).end("not here");
        return;
      }
      const err = u.searchParams.get("error");
      const c = u.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<body style="font:14px system-ui;background:#0a0b0d;color:#e6e9ef;padding:48px">
           <h2 style="color:${err ? "#f85149" : "#3fb950"}">${err ? "Authorisation failed" : "Authorised"}</h2>
           <p>${err ? err : "You can close this tab and return to the terminal."}</p>
         </body>`,
      );
      server.close();
      if (err || !c) reject(new Error(err ?? "no code returned"));
      else resolve(c);
    });
    server.listen(PORT, () => {
      console.log("\nOpen this URL and approve access:\n");
      console.log(url);
      console.log(`\nwaiting for the redirect on ${REDIRECT} ...`);
    });
    setTimeout(() => { server.close(); reject(new Error("timed out waiting for consent")); }, 300_000);
  });

  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    console.error("\nGoogle returned no refresh token. Revoke this app at https://myaccount.google.com/permissions and run again.");
    process.exit(2);
  }
  fs.writeFileSync(
    OUT,
    JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: tokens.refresh_token }, null, 2) + "\n",
  );
  fs.chmodSync(OUT, 0o600);

  // getToken() returns the tokens but does not attach them to the client.
  oauth.setCredentials(tokens);
  const drive = google.drive({ version: "v3", auth: oauth });
  const me = await drive.about.get({ fields: "user(emailAddress,displayName)" });
  console.log(`\n  wrote ${OUT}`);
  console.log(`  authorised as ${me.data.user?.emailAddress}`);
}
main().catch((e) => { console.error("\n" + (e instanceof Error ? e.message : String(e))); process.exit(1); });
