import type { DriveAdapter, WriteResult } from "@/adapters/types";
import type { DrivePermission, WorldState } from "@/core/world";
import { cloneWorld } from "@/core/world";
import { FaultInjector, type Fault } from "@/adapters/faults";

let permSeq = 1000;

/**
 * Shadow Drive.
 *
 * Permissions are independent ACL records. Deleting the departing user's `user`
 * permission leaves an `anyone`-with-link permission completely untouched, and
 * the delete returns a clean 204. That is the Drive equivalent of the GitHub
 * team-inheritance trap and it is modelled here faithfully.
 */
export class ShadowDriveAdapter implements DriveAdapter {
  readonly mode = "shadow" as const;
  private faults: FaultInjector;
  private stale: WorldState;

  constructor(private world: WorldState, faults: Fault[] = []) {
    this.faults = new FaultInjector(faults);
    this.stale = cloneWorld(world);
  }

  private read(op: string): WorldState {
    return this.faults.check(op) === "stale" ? this.stale : this.world;
  }
  private beforeWrite(op: string) {
    this.faults.check(op);
    this.stale = cloneWorld(this.world);
  }

  async listFilesSharedWith(email: string) {
    const w = this.read("drive.listFilesSharedWith").drive;
    const ids = new Set(w.permissions.filter((p) => p.emailAddress === email).map((p) => p.fileId));
    return w.files.filter((f) => ids.has(f.id) || f.ownerEmail === email).map((f) => ({ ...f }));
  }

  async listPermissions(fileId: string) {
    return this.read("drive.listPermissions").drive.permissions.filter((p) => p.fileId === fileId).map((p) => ({ ...p }));
  }

  async getFile(fileId: string) {
    const f = this.read("drive.getFile").drive.files.find((x) => x.id === fileId);
    return f ? { ...f } : null;
  }

  async deletePermission(fileId: string, permissionId: string): Promise<WriteResult> {
    this.beforeWrite("drive.deletePermission");
    this.world.drive.permissions = this.world.drive.permissions.filter(
      (p) => !(p.fileId === fileId && p.id === permissionId),
    );
    return { status: 204, body: null };
  }

  async createPermission(
    fileId: string,
    p: { type: DrivePermission["type"]; role: DrivePermission["role"]; emailAddress?: string },
  ): Promise<WriteResult> {
    this.beforeWrite("drive.createPermission");
    const id = `perm-${permSeq++}`;
    this.world.drive.permissions.push({ id, fileId, type: p.type, role: p.role, emailAddress: p.emailAddress });
    return { status: 200, body: { id, kind: "drive#permission", type: p.type, role: p.role } };
  }

  async transferOwnership(fileId: string, newOwnerEmail: string): Promise<WriteResult> {
    this.beforeWrite("drive.transferOwnership");
    const file = this.world.drive.files.find((f) => f.id === fileId);
    if (!file) return { status: 404, body: { error: { code: 404, message: "File not found" } } };
    const prevOwner = file.ownerEmail;
    file.ownerEmail = newOwnerEmail;
    for (const p of this.world.drive.permissions) {
      if (p.fileId !== fileId) continue;
      if (p.role === "owner" && p.emailAddress === prevOwner) p.role = "writer";
      if (p.emailAddress === newOwnerEmail) p.role = "owner";
    }
    if (!this.world.drive.permissions.some((p) => p.fileId === fileId && p.emailAddress === newOwnerEmail)) {
      this.world.drive.permissions.push({
        id: `perm-${permSeq++}`, fileId, type: "user", role: "owner", emailAddress: newOwnerEmail,
      });
    }
    return { status: 200, body: { id: fileId, kind: "drive#permission", role: "owner" } };
  }
}
