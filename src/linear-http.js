/** Where a follow-up goes (REQ-LINEAR-22): its source issue's team and project, else the named project and its team. */
async function home(apiKey, sourceId, project) {
  if (sourceId) {
    const issue = (await gql(apiKey, ISSUE_HOME, { id: sourceId })).issue;
    return { teamId: issue.team.id, projectId: issue.project?.id };
  }
  const nodes = (await gql(apiKey, PROJECT_HOME, { name: project })).projects.nodes;
  if (nodes.length !== 1 || !nodes[0].teams.nodes.length)
    throw new Error(`Linear project "${project}" not found as exactly one project with a team; cannot file the follow-up`);
  return { teamId: nodes[0].teams.nodes[0].id, projectId: nodes[0].id };
}

const ENDPOINT = 'https://api.linear.app/graphql';

async function gql(apiKey, query, variables) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}: ${body.errors?.[0]?.message ?? 'request failed'}`);
  if (body.errors?.length) throw new Error(`Linear API error: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.data;
}

const LIST_ISSUES = `
  query ($filter: IssueFilter, $after: String) {
    issues(filter: $filter, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        identifier title description priority createdAt estimate labels(first: 10) { nodes { name } }
        inverseRelations(first: 20) { nodes { type issue { identifier state { type } } } }
      }
    }
  }
`;

const COMMENT = `mutation ($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;

const TEAM_STATES = `
  query ($id: String!) {
    issue(id: $id) { team { states { nodes { id name type } } } }
  }
`;

const STATE_TYPE = `query ($id: String!) { issue(id: $id) { state { type } } }`;

const ISSUE_HOME = `query ($id: String!) { issue(id: $id) { team { id } project { id } } }`;

const PROJECT_HOME = `query ($name: String!) { projects(filter: { name: { eq: $name } }, first: 2) { nodes { id teams(first: 1) { nodes { id } } } } }`;

const CREATE_ISSUE = `mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier } } }`;

const BLOCKS = `mutation ($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }`;

const DELETE_ISSUE = `mutation ($id: String!) { issueDelete(id: $id) { success } }`;

const ISSUE_ID = `query ($id: String!) { issue(id: $id) { id } }`;

const SET_DESCRIPTION = `mutation ($id: String!, $description: String!) { issueUpdate(id: $id, input: { description: $description }) { success } }`;

const MOVE_ISSUE = `mutation ($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;

/**
 * Real Linear client (REQ-LINEAR-7): Linear's GraphQL HTTP API with LINEAR_API_KEY. Keel is a plain
 * CLI subprocess with no MCP access, so this — not the session's MCP tools — is what `keel poll` uses.
 */
export function linearHttpClient() {
  const key = () => {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) throw new Error('LINEAR_API_KEY is not set; keel poll needs a Linear personal API key');
    return apiKey;
  };

  return {
    async listIssues(project, { closedWithinDays } = {}) {
      const apiKey = key();
      const open = { state: { type: { nin: ['completed', 'canceled'] } } };
      // Dedupe of found work also counts issues closed lately, so work fixed by hand is not filed again (REQ-LINEAR-22).
      const since = `-P${closedWithinDays}D`;
      const filter = closedWithinDays
        ? { project: { name: { eq: project } }, or: [open, { completedAt: { gt: since } }, { canceledAt: { gt: since } }] }
        : { project: { name: { eq: project } }, ...open };
      // Every page: an issue past the first 100 must still be picked, and a follow-up still deduped (REQ-LINEAR-22).
      const nodes = [];
      let after = null;
      do {
        const page = (await gql(apiKey, LIST_ISSUES, { filter, ...(after ? { after } : {}) })).issues;
        nodes.push(...page.nodes);
        after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
      return nodes.map((n) => ({
        id: n.identifier,
        title: n.title,
        description: n.description,
        priority: n.priority,
        createdAt: n.createdAt,
        estimate: n.estimate,
        labels: n.labels.nodes.map((l) => l.name),
        // Open issues that block this one (REQ-LINEAR-20); a closed blocker no longer holds it back.
        blockedBy: (n.inverseRelations?.nodes ?? [])
          .filter((r) => r.type === 'blocks' && !['completed', 'canceled'].includes(r.issue.state.type))
          .map((r) => r.issue.identifier),
      }));
    },
    async comment(issueId, body) {
      const apiKey = key();
      await gql(apiKey, COMMENT, { issueId, body });
    },
    /** The issue's current state type, read fresh (REQ-LINEAR-16): it may have closed while Keel ran. */
    async stateType(issueId) {
      const data = await gql(key(), STATE_TYPE, { id: issueId });
      return data.issue.state.type;
    },
    /**
     * File found work in the source issue's team and project (REQ-LINEAR-22); returns the new identifier. Each
     * `blockedBy` issue gets a `blocks` relation to it, so the loop waits for that issue (REQ-LINEAR-28, -20).
     */
    async createIssue(sourceId, { title, description, priority, blockedBy = [], parent = null }, project) {
      const apiKey = key();
      const input = { ...(await home(apiKey, sourceId, project)), title, description, priority };
      // A split card is a sub-issue of the issue it came from (REQ-LINEAR-33); Linear takes the parent's UUID.
      if (parent) input.parentId = (await gql(apiKey, ISSUE_ID, { id: parent })).issue.id;
      const data = await gql(apiKey, CREATE_ISSUE, { input });
      if (!data.issueCreate.success) throw new Error(`Linear did not create the follow-up "${title}"`);
      const id = data.issueCreate.issue.identifier;
      for (const blocker of blockedBy) {
        // Created without its relation, the follow-up would be deduped by title on retry and built before its source:
        // delete it, so the next poll files it again whole (REQ-LINEAR-28).
        const linked = await gql(apiKey, BLOCKS, { input: { issueId: blocker, relatedIssueId: id, type: 'blocks' } }).then(
          (d) => (d.issueRelationCreate.success ? null : 'Linear refused the relation'),
          (e) => e.message,
        );
        if (!linked) continue;
        const undone = await gql(apiKey, DELETE_ISSUE, { id }).then(
          (d) => (d.issueDelete.success ? null : 'Linear refused the delete'),
          (e) => e.message,
        );
        // An unlinked follow-up that stays would be deduped by title on retry: say so, so a human removes it.
        if (undone)
          throw new Error(
            `could not mark follow-up ${id} blocked by ${blocker} (${linked}); could not delete ${id} (${undone}); delete it by hand`,
          );
        throw new Error(`could not mark follow-up ${id} blocked by ${blocker} (${linked}); deleted ${id} so the next poll files it again`);
      }
      return id;
    },
    /** Replace an issue's description: a refined card above the original text (REQ-LINEAR-33). */
    async setDescription(issueId, description) {
      const data = await gql(key(), SET_DESCRIPTION, { id: issueId, description });
      if (!data.issueUpdate.success) throw new Error(`Linear did not update the description of ${issueId}`);
    },
    /** Move an issue proven already done (REQ-LINEAR-30) to its team's first completed-type state. */
    async done(issueId) {
      const apiKey = key();
      const data = await gql(apiKey, TEAM_STATES, { id: issueId });
      const target = data.issue.team.states.nodes.find((s) => s.type === 'completed');
      if (!target) throw new Error(`no "completed"-type state found on the team for issue ${issueId}; not closing it`);
      await gql(apiKey, MOVE_ISSUE, { id: issueId, stateId: target.id });
    },
    /** Move a passing issue to review, never to Done: a gate pass is not a human review (REQ-LINEAR-13). */
    async review(issueId) {
      const apiKey = key();
      const data = await gql(apiKey, TEAM_STATES, { id: issueId });
      const started = data.issue.team.states.nodes.filter((s) => s.type === 'started');
      const target = started.find((s) => /review/i.test(s.name)) ?? started[0];
      if (!target) throw new Error(`no "started"-type state found on the team for issue ${issueId}; not moving it`);
      await gql(apiKey, MOVE_ISSUE, { id: issueId, stateId: target.id });
    },
  };
}
