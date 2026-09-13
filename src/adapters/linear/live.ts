import type { LinearAdapter, WriteResult } from "@/adapters/types";
import { httpJson } from "@/adapters/http";

const API = "https://api.linear.app/graphql";

export class LiveLinearAdapter implements LinearAdapter {
  readonly mode = "live" as const;
  constructor(private apiKey: string) {}

  private async gql(query: string, variables: Record<string, unknown> = {}) {
    const res = await httpJson(API, {
      method: "POST",
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = res.body as { data?: Record<string, unknown>; errors?: { message: string }[] };
    if (body?.errors?.length) throw new Error(`linear: ${body.errors.map((e) => e.message).join("; ")}`);
    return { status: res.status, data: body?.data ?? {} };
  }

  async getUserByEmail(email: string) {
    const { data } = await this.gql(
      `query($f: UserFilter) { users(filter: $f, first: 1) { nodes { id email name active } } }`,
      { f: { email: { eq: email } } },
    );
    const nodes = (data.users as { nodes: { id: string; email: string; name: string; active: boolean }[] })?.nodes ?? [];
    return nodes[0] ?? null;
  }

  async listAssignedIssues(userId: string) {
    const { data } = await this.gql(
      `query($f: IssueFilter) { issues(filter: $f, first: 100) {
         nodes { id identifier title state { name } team { id } assignee { id } } } }`,
      { f: { assignee: { id: { eq: userId } } } },
    );
    const nodes =
      (data.issues as { nodes: { id: string; identifier: string; title: string; state: { name: string }; team: { id: string }; assignee: { id: string } | null }[] })?.nodes ?? [];
    return nodes.map((n) => ({
      id: n.id, identifier: n.identifier, title: n.title,
      teamId: n.team?.id ?? "", assigneeId: n.assignee?.id ?? null, state: n.state?.name ?? "",
    }));
  }

  async listTeamMemberships(userId: string) {
    const { data } = await this.gql(
      `query($id: String!) { user(id: $id) { teamMemberships { nodes { id team { id } } } } }`,
      { id: userId },
    );
    const nodes = (data.user as { teamMemberships: { nodes: { id: string; team: { id: string } }[] } })?.teamMemberships?.nodes ?? [];
    return nodes.map((n) => ({ id: n.id, teamId: n.team.id, userId }));
  }

  async getTeam(teamId: string) {
    const { data } = await this.gql(`query($id: String!) { team(id: $id) { id key name } }`, { id: teamId });
    const t = data.team as { id: string; key: string; name: string } | null;
    return t ?? null;
  }

  async getIssue(issueId: string) {
    const { data } = await this.gql(
      `query($id: String!) { issue(id: $id) { id identifier assignee { id } state { name } } }`,
      { id: issueId },
    );
    const i = data.issue as { id: string; identifier: string; assignee: { id: string } | null; state: { name: string } } | null;
    return i ? { id: i.id, identifier: i.identifier, assigneeId: i.assignee?.id ?? null, state: i.state?.name ?? "" } : null;
  }

  async reassignIssue(issueId: string, assigneeId: string | null): Promise<WriteResult> {
    const { status, data } = await this.gql(
      `mutation($id: String!, $in: IssueUpdateInput!) { issueUpdate(id: $id, input: $in) { success issue { id identifier } } }`,
      { id: issueId, in: { assigneeId } },
    );
    return { status, body: data.issueUpdate };
  }

  async removeTeamMembership(membershipId: string): Promise<WriteResult> {
    const { status, data } = await this.gql(
      `mutation($id: String!) { teamMembershipDelete(id: $id) { success } }`, { id: membershipId },
    );
    return { status, body: data.teamMembershipDelete };
  }

  async addTeamMembership(teamId: string, userId: string): Promise<WriteResult> {
    const { status, data } = await this.gql(
      `mutation($in: TeamMembershipCreateInput!) { teamMembershipCreate(input: $in) { success teamMembership { id } } }`,
      { in: { teamId, userId } },
    );
    return { status, body: data.teamMembershipCreate };
  }

  async createIssue(input: { teamId: string; title: string; description: string }): Promise<WriteResult> {
    const { status, data } = await this.gql(
      `mutation($in: IssueCreateInput!) { issueCreate(input: $in) { success issue { id identifier title } } }`,
      { in: input },
    );
    return { status, body: data.issueCreate };
  }

  async archiveIssue(issueId: string): Promise<WriteResult> {
    const { status, data } = await this.gql(
      `mutation($id: String!) { issueArchive(id: $id) { success } }`, { id: issueId },
    );
    return { status, body: data.issueArchive };
  }
}
