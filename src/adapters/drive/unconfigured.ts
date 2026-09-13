import type { DriveAdapter, WriteResult } from "@/adapters/types";
import type { DrivePermission } from "@/core/world";
import { UnverifiableError } from "@/core/action";

/**
 * Drive with no credentials configured.
 *
 * Reads return empty, so discovery finds no files and the planner never proposes
 * a Drive action — the app is simply absent from the run rather than a crash on
 * startup. Writes and read-backs throw `UnverifiableError` so that if one is
 * somehow reached, the run reports "could not determine" instead of inventing a
 * result. An unconfigured integration must never look like an empty one at
 * verification time.
 */
export class UnconfiguredDriveAdapter implements DriveAdapter {
  readonly mode = "live" as const;

  async listFilesSharedWith(): Promise<{ id: string; name: string; ownerEmail: string; trashed: boolean }[]> {
    return [];
  }
  async listPermissions(): Promise<DrivePermission[]> {
    throw new UnverifiableError("google drive is not configured (GOOGLE_OAUTH_CREDENTIALS is empty)");
  }
  async getFile(): Promise<never> {
    throw new UnverifiableError("google drive is not configured (GOOGLE_OAUTH_CREDENTIALS is empty)");
  }
  async deletePermission(): Promise<WriteResult> {
    throw new UnverifiableError("google drive is not configured; refusing to pretend a write happened");
  }
  async createPermission(): Promise<WriteResult> {
    throw new UnverifiableError("google drive is not configured; refusing to pretend a write happened");
  }
  async transferOwnership(): Promise<WriteResult> {
    throw new UnverifiableError("google drive is not configured; refusing to pretend a write happened");
  }
}
