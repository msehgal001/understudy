import fs from "node:fs";
import { google, type drive_v3 } from "googleapis";
import type { DriveAdapter, WriteResult } from "@/adapters/types";
import type { DrivePermission } from "@/core/world";

/**
 * GOOGLE_OAUTH_CREDENTIALS is either a path to a JSON file or the JSON itself,
 * shaped { client_id, client_secret, refresh_token }. A refresh token is required:
 * the agent runs unattended, so there is no consent round-trip at run time.
 */
export function driveClient(credsEnv: string): drive_v3.Drive {
  const raw = fs.existsSync(credsEnv) ? fs.readFileSync(credsEnv, "utf8") : credsEnv;
  const parsed = JSON.parse(raw);
  const c = parsed.installed ?? parsed.web ?? parsed;
  const auth = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uri ?? "http://localhost");
  auth.setCredentials({ refresh_token: c.refresh_token });
  return google.drive({ version: "v3", auth });
}

export class LiveDriveAdapter implements DriveAdapter {
  readonly mode = "live" as const;
  constructor(private drive: drive_v3.Drive) {}

  async listFilesSharedWith(email: string) {
    const res = await this.drive.files.list({
      q: `'${email}' in readers or '${email}' in writers or '${email}' in owners`,
      fields: "files(id,name,owners(emailAddress),trashed)",
      pageSize: 100,
    });
    return (res.data.files ?? []).map((f) => ({
      id: f.id!, name: f.name ?? "", ownerEmail: f.owners?.[0]?.emailAddress ?? "", trashed: !!f.trashed,
    }));
  }

  async listPermissions(fileId: string): Promise<DrivePermission[]> {
    const res = await this.drive.permissions.list({
      fileId, fields: "permissions(id,type,role,emailAddress,domain)",
    });
    return (res.data.permissions ?? []).map((p) => ({
      id: p.id!, fileId,
      type: p.type as DrivePermission["type"],
      role: p.role as DrivePermission["role"],
      emailAddress: p.emailAddress ?? undefined,
      domain: p.domain ?? undefined,
    }));
  }

  async getFile(fileId: string) {
    try {
      const res = await this.drive.files.get({ fileId, fields: "id,name,owners(emailAddress),trashed" });
      const f = res.data;
      return { id: f.id!, name: f.name ?? "", ownerEmail: f.owners?.[0]?.emailAddress ?? "", trashed: !!f.trashed };
    } catch {
      return null;
    }
  }

  async deletePermission(fileId: string, permissionId: string): Promise<WriteResult> {
    const res = await this.drive.permissions.delete({ fileId, permissionId });
    return { status: res.status ?? 204, body: null };
  }

  async createPermission(
    fileId: string,
    p: { type: DrivePermission["type"]; role: DrivePermission["role"]; emailAddress?: string },
  ): Promise<WriteResult> {
    const res = await this.drive.permissions.create({
      fileId, requestBody: { type: p.type, role: p.role, emailAddress: p.emailAddress },
    });
    return { status: res.status ?? 200, body: res.data };
  }

  /** Irreversible: Drive gives no API to hand ownership back without the new owner's consent. */
  async transferOwnership(fileId: string, newOwnerEmail: string): Promise<WriteResult> {
    const perms = await this.listPermissions(fileId);
    const existing = perms.find((p) => p.emailAddress === newOwnerEmail);
    if (existing) {
      const res = await this.drive.permissions.update({
        fileId, permissionId: existing.id, transferOwnership: true, requestBody: { role: "owner" },
      });
      return { status: res.status ?? 200, body: res.data };
    }
    const res = await this.drive.permissions.create({
      fileId, transferOwnership: true, requestBody: { type: "user", role: "owner", emailAddress: newOwnerEmail },
    });
    return { status: res.status ?? 200, body: res.data };
  }
}
