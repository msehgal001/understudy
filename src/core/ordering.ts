import type { Action } from "@/core/action";

export type OrderingViolation = { resourceId: string; transfer: string; revoke: string; message: string };

/**
 * Transfers must precede revocations on the same resource.
 *
 * Enforced here in code rather than trusted to the model. A plan that revokes a
 * departing employee's Drive access before handing ownership on leaves a file
 * nobody can administer, and a model that has been asked nicely to order its plan
 * correctly will usually comply — usually is not a reliability property.
 */
export function validateOrdering(actions: Action[]): OrderingViolation[] {
  const violations: OrderingViolation[] = [];
  const firstRevoke = new Map<string, { index: number; id: string }>();

  actions.forEach((a, index) => {
    if (a.kind !== "revoke") return;
    if (!firstRevoke.has(a.resourceId)) firstRevoke.set(a.resourceId, { index, id: a.id });
  });

  actions.forEach((a, index) => {
    if (a.kind !== "transfer") return;
    const rev = firstRevoke.get(a.resourceId);
    if (rev && rev.index < index) {
      violations.push({
        resourceId: a.resourceId,
        transfer: a.id,
        revoke: rev.id,
        message:
          `revoke "${rev.id}" is ordered before transfer "${a.id}" on ${a.resourceId}. ` +
          `Transfers must come first or the resource is orphaned.`,
      });
    }
  });

  return violations;
}
