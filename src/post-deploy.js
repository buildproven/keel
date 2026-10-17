import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const POST_DEPLOY_PATH = '.github/workflows/keel-post-deploy.yml';

/**
 * Operate stage of the v2 loop (REQ-PROJ-7, REQ-PROJ-8, DESIGN §9): after a successful production deployment, run
 * the default branch's keel.json `smoke` command against it (three tries). On failure, mark the deployment failed,
 * open a revert PR with auto-merge, and leave the run red; Vercel deploys the revert like any merge. No Vercel
 * rollback: a rollback turns off auto-assignment of production domains and needs a state machine to undo safely.
 * Optional secret KEEL_BOT_TOKEN lets CI run on the revert PR (GitHub starts no workflow for GITHUB_TOKEN pushes).
 */
export const POST_DEPLOY_WORKFLOW = `# Written by keel init (REQ-PROJ-7, REQ-PROJ-8). Smoke-tests production after each deploy; on failure reverts.
name: keel post-deploy

on: deployment_status

permissions:
  contents: read

# One group per run: a newer pending run in a shared group would replace this one (REQ-PROJ-8).
concurrency:
  group: keel-post-deploy-\${{ github.run_id }}
  cancel-in-progress: false

jobs:
  verify:
    if: github.event.deployment_status.state == 'success' && github.event.deployment.environment == 'Production'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    outputs:
      smoke: \${{ steps.smoke.outputs.result }}
    steps:
      # The smoke command is read from the default branch, never from the deployed commit (REQ-PROJ-8).
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.repository.default_branch }}
          persist-credentials: false

      - name: Smoke-test production
        id: smoke
        env:
          KEEL_DEPLOY_URL: \${{ github.event.deployment_status.environment_url }}
        run: |
          cmd="$(jq -r '.smoke // empty' keel.json)"
          if [ -z "$cmd" ]; then
            echo "::warning::keel.json has no smoke command, so this deploy was not verified"
            echo "result=skipped" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          for attempt in 1 2 3; do
            if bash -c "$cmd"; then
              echo "result=pass" >> "$GITHUB_OUTPUT"
              exit 0
            fi
            echo "smoke attempt $attempt failed"
            sleep 20
          done
          echo "result=fail" >> "$GITHUB_OUTPUT"

  respond:
    needs: verify
    if: needs.verify.outputs.smoke == 'fail'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: write
      deployments: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Revert the change
        env:
          GH_TOKEN: \${{ secrets.KEEL_BOT_TOKEN || secrets.GITHUB_TOKEN }}
          HAS_BOT_TOKEN: \${{ secrets.KEEL_BOT_TOKEN != '' }}
          SHA: \${{ github.event.deployment.sha }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          gh auth setup-git
          base="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)"
          git fetch origin "$base"
          if ! git merge-base --is-ancestor "$SHA" "origin/$base"; then
            echo "::error::$SHA is not on $base, so there is nothing to revert there"
            exit 1
          fi
          short="$(git rev-parse --short "$SHA")"
          git config user.name "keel post-deploy"
          git config user.email "keel-post-deploy@users.noreply.github.com"
          git checkout -b "keel/revert-$short" "origin/$base"
          if [ "$(git rev-list --parents -n 1 "$SHA" | wc -w)" -gt 2 ]; then
            git revert --no-commit -m 1 "$SHA"
          else
            git revert --no-commit "$SHA"
          fi
          git commit -m "revert: $short failed the post-deploy smoke test" -m "Reverts $SHA. $RUN_URL"
          git push origin "keel/revert-$short"
          url="$(gh pr create --base "$base" --head "keel/revert-$short" \\
            --title "revert: $short failed the post-deploy smoke test" \\
            --body "Production smoke test failed after deploying $SHA: $RUN_URL. This PR reverts the change on $base; it auto-merges after the required checks and deploys like any merge.")"
          gh pr merge "$url" --auto --squash
          if [ "$HAS_BOT_TOKEN" != true ]; then
            echo "::error::no KEEL_BOT_TOKEN secret: CI will not start on the revert PR, so it waits for a human to start it"
          fi

      - name: Mark the deployment as failed
        if: always()
        env:
          GH_TOKEN: \${{ github.token }}
          DEPLOYMENT_ID: \${{ github.event.deployment.id }}
          REPO: \${{ github.repository }}
        run: |
          gh api -X POST "repos/$REPO/deployments/$DEPLOYMENT_ID/statuses" -f state=failure -f description="keel post-deploy smoke test failed" > /dev/null

      - name: Mark the incident
        if: always()
        run: |
          echo "::error::production smoke test failed; see the steps above for the revert"
          exit 1
`;

const isVercel = (dir) => existsSync(join(dir, 'vercel.json')) || existsSync(join(dir, '.vercel'));

/** Write the post-deploy workflow into a Vercel project; never overwrite one that exists (REQ-PROJ-7). */
export function writePostDeployWorkflow(dir) {
  const path = join(dir, POST_DEPLOY_PATH);
  if (!isVercel(dir)) return { written: false, path, reason: 'not a Vercel project' };
  if (existsSync(path)) return { written: false, path };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, POST_DEPLOY_WORKFLOW);
  return { written: true, path };
}
