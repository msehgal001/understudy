import type { Check } from "@/core/action";
import type { Discovery } from "@/core/discover";
import * as post from "@/checks/postconditions";

/**
 * Goal checks: what must be true when the run is finished, derived from what
 * DISCOVERY found — not from what the plan happened to do.
 *
 * Postconditions answer "did my actions land?". That is necessary and not
 * sufficient, because an action that was never planned has no postcondition to
 * fail. A live scenario made the gap concrete: the plan transferred ownership of a
 * sole-owned Drive file to the successor but never removed the departing
 * employee's own permission on it. Every postcondition passed. The agent reported
 * a clean offboarding over a file the departing employee could still open.
 *
 * These checks close that hole by re-reading every access path discovery found,
 * whether or not the plan addressed it. The goal is "this person has no access",
 * not "my writes succeeded".
 */
export function goalChecks(d: Discovery): Check[] {
  const checks: Check[] = [];
  const seen = new Set<string>();

  for (const g of d.github.grants) {
    const repo = g.resourceName.split("/")[1];
    const key = `gh:${repo}`;
    if (!repo || seen.has(key)) continue;
    seen.add(key);
    checks.push(post.githubNoEffectiveAccess({ org: d.org, repo, login: d.target.githubLogin }));
  }

  for (const f of d.drive.files) {
    const hadPermission = f.permissions.some((p) => p.emailAddress === d.target.email);
    if (!hadPermission && !f.departingIsOwner) continue;
    const key = `drive:${f.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checks.push(post.driveNoAccess({ fileId: f.id, email: d.target.email }));
  }

  return checks;
}
