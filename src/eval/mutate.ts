import type { CheckResult } from "@/core/action";

/**
 * Mutation testing for the eval itself.
 *
 * An eval that cannot fail measures nothing. The way to know whether this suite
 * would notice a broken agent is to break the agent on purpose and watch the
 * suite go red. `setMutation("gh.no-access")` makes every check whose id starts
 * with that prefix return a clean pass WITHOUT looking at what it read — the
 * precise failure this project claims to detect, injected deliberately.
 *
 * If the suite still reports a 0% silent failure rate under mutation, the
 * corpus is not exercising that check and the headline number is decoration.
 * `npm run eval:mutation` asserts the opposite: every mutant must be killed.
 *
 * Inert unless setMutation is called, so production runs are untouched.
 */
let mutant: string | null = null;

export function setMutation(checkIdPrefix: string | null) {
  mutant = checkIdPrefix;
}

export function activeMutation(): string | null {
  return mutant;
}

/** Applied by the executor immediately after a check returns. */
export function applyMutation(checkId: string, result: CheckResult): CheckResult {
  if (mutant && checkId.startsWith(mutant)) {
    return { pass: true, observed: { mutated: true, suppressed: result.observed } };
  }
  return result;
}

/**
 * The mutants `npm run eval:mutation` must kill. Each one disables a check this
 * project's claims rest on.
 */
export const MUTANTS: { id: string; describe: string }[] = [
  { id: "gh.no-access", describe: "GitHub effective-access check always passes" },
  { id: "gh.not-team-member", describe: "GitHub team-membership check always passes" },
  { id: "drive.no-access", describe: "Drive access check always passes" },
];
