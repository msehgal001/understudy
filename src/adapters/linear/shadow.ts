import type { LinearAdapter, WriteResult } from "@/adapters/types";
import type { WorldState } from "@/core/world";
import { cloneWorld } from "@/core/world";
import { FaultInjector, type Fault } from "@/adapters/faults";

let seq = 5000;

export class ShadowLinearAdapter implements LinearAdapter {
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

  async listTeams() {
    const w = this.read("linear.listTeams").linear;
    return w.teams.map((t) => ({ id: t.id, key: t.key, name: t.name }));
  }

  async getUserByEmail(email: string) {
    const u = this.read("linear.getUserByEmail").linear.users.find((x) => x.email === email);
    return u ? { ...u } : null;
  }
  async listAssignedIssues(userId: string) {
    return this.read("linear.listAssignedIssues").linear.issues.filter((i) => i.assigneeId === userId).map((i) => ({ ...i }));
  }
  async listTeamMemberships(userId: string) {
    return this.read("linear.listTeamMemberships").linear.memberships.filter((m) => m.userId === userId).map((m) => ({ ...m }));
  }
  async getTeam(teamId: string) {
    const t = this.read("linear.getTeam").linear.teams.find((x) => x.id === teamId);
    return t ? { ...t } : null;
  }
  async getIssue(issueId: string) {
    const i = this.read("linear.getIssue").linear.issues.find((x) => x.id === issueId);
    return i ? { ...i } : null;
  }

  /** Linear returns a success envelope wrapping the mutated entity. Mirrored exactly. */
  async reassignIssue(issueId: string, assigneeId: string | null): Promise<WriteResult> {
    this.beforeWrite("linear.reassignIssue");
    const issue = this.world.linear.issues.find((i) => i.id === issueId);
    if (!issue) return { status: 200, body: { success: false, issue: null } };
    issue.assigneeId = assigneeId;
    return { status: 200, body: { success: true, issue: { id: issue.id, identifier: issue.identifier, assigneeId } } };
  }

  async removeTeamMembership(membershipId: string): Promise<WriteResult> {
    this.beforeWrite("linear.removeTeamMembership");
    this.world.linear.memberships = this.world.linear.memberships.filter((m) => m.id !== membershipId);
    return { status: 200, body: { success: true } };
  }

  async addTeamMembership(teamId: string, userId: string): Promise<WriteResult> {
    this.beforeWrite("linear.addTeamMembership");
    const id = `mem-${seq++}`;
    this.world.linear.memberships.push({ id, teamId, userId });
    return { status: 200, body: { success: true, teamMembership: { id } } };
  }

  async createIssue(input: { teamId: string; title: string; description: string }): Promise<WriteResult> {
    this.beforeWrite("linear.createIssue");
    const n = seq++;
    const id = `iss-${n}`;
    const team = this.world.linear.teams.find((t) => t.id === input.teamId);
    const identifier = `${team?.key ?? "TEAM"}-${n}`;
    this.world.linear.issues.push({
      id, identifier, title: input.title, teamId: input.teamId, assigneeId: null, state: "backlog",
    });
    return { status: 200, body: { success: true, issue: { id, identifier, title: input.title } } };
  }

  async archiveIssue(issueId: string): Promise<WriteResult> {
    this.beforeWrite("linear.archiveIssue");
    const issue = this.world.linear.issues.find((i) => i.id === issueId);
    if (issue) issue.state = "archived";
    return { status: 200, body: { success: true } };
  }
}
