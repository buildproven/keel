// Preload for CLI tests (`node --import`): answers Linear's GraphQL endpoint from memory, so `keel run BUI-N` runs offline.
// KEEL_FAKE_LINEAR is a JSON issue (id, title, description, labels, estimate); KEEL_FAKE_LINEAR_LOG gets each comment body.
import { appendFileSync } from 'node:fs';

const issue = JSON.parse(process.env.KEEL_FAKE_LINEAR);
const ok = (data) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  if (query.includes('commentCreate')) {
    appendFileSync(process.env.KEEL_FAKE_LINEAR_LOG, `${JSON.stringify(variables.body)}\n`);
    return ok({ commentCreate: { success: true } });
  }
  if (query.includes('state { type }') && query.includes('issue(id')) return ok({ issue: { state: { type: 'started' } } });
  // Keel archives the project's closed issues at the start of a pass (REQ-LINEAR-39): none are closed here.
  if (query.includes('nodes { id identifier }')) return ok({ issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } });
  if (query.includes('issues(filter')) {
    return ok({
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            identifier: issue.id,
            title: issue.title,
            description: issue.description,
            priority: 2,
            createdAt: '2026-10-01T00:00:00Z',
            estimate: issue.estimate ?? null,
            labels: { nodes: (issue.labels ?? []).map((name) => ({ name })) },
            inverseRelations: { nodes: [] },
          },
        ],
      },
    });
  }
  throw new Error(`fake Linear: unexpected query ${query.slice(0, 80)}`);
};
