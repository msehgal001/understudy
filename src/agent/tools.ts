import { OPERATION_NAMES } from "@/actions/index";

/**
 * The plan schema, used as a STRUCTURED OUTPUT rather than a tool call.
 *
 * This started as a forced `tool_choice` against a `submit_plan` tool, which is
 * the shape most agent code reaches for. It was measurably unreliable: over
 * repeated live calls, roughly two in five returned a well-written `summary` and
 * an empty `decisions` array — a confident narrative over no plan at all, which
 * is precisely the failure this project exists to refuse. Reordering the fields so
 * `decisions` generated first helped but did not fix it.
 *
 * Measured on the same scenario and prompt, ten calls each:
 *
 *     forced tool call      3/5 usable on the first attempt
 *     structured outputs    5/5 usable on the first attempt
 *
 * The reason is semantic, not incidental. Nothing here is a tool — the model is
 * not taking an action, it is returning data. `output_config.format` is the API
 * for returning data, and it constrains generation to the schema instead of
 * hoping a tool call comes back well-formed.
 *
 * `params` is typed as a JSON *string* rather than an object because structured
 * outputs require `additionalProperties: false` throughout, which a free-form
 * parameter bag cannot satisfy. The planner parses it back; see
 * `normaliseDecisions` in loop.ts, which handles this and every other shape the
 * model has been observed to emit.
 */

const PARAMS_BY_OPERATION = [
  "github.removeCollaborator   {repo, login, previousPermission}  — repo is the BARE name, no org/ prefix",
  "github.removeTeamMember     {slug, login, repo}  — repo is the BARE name, no org/ prefix",
  "github.removeOrgMember      {login}",
  "drive.removePermission      {fileId, permissionId, email, role}",
  "drive.transferOwnership     {fileId}",
  "linear.reassignIssue        {issueId, assigneeId, previousAssigneeId, identifier}",
  "linear.removeTeamMembership {membershipId, teamId, userId}",
  "linear.createAuditIssue     {teamId, title, description}",
  "slack.postReport            {text}",
].join("\n  ");

export const PLAN_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  // `decisions` first: JSON keys are generated in schema order, and the substance
  // must be produced before the prose rather than after it.
  required: ["decisions", "summary"],
  properties: {
    decisions: {
      type: "array",
      description:
        "The ordered list of actions. Every transfer on a resource must appear before any revocation on that same resource.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "operation", "params", "rationale"],
        properties: {
          id: { type: "string", description: "Short stable kebab-case id, unique within the plan." },
          operation: { type: "string", enum: OPERATION_NAMES as unknown as string[] },
          params: {
            type: "string",
            description:
              "A JSON object, as a string, with only the fields this operation needs:\n  " + PARAMS_BY_OPERATION +
              "\nNote: the recipient of a Drive ownership transfer and the Slack channel are taken from " +
              "configuration, not from you. Do not supply them.",
          },
          rationale: { type: "string", description: "One sentence: what this action does and why." },
        },
      },
    },
    summary: {
      type: "string",
      description: "One or two sentences, written after the decisions: what this plan does and what it deliberately leaves alone.",
    },
  },
};
