# Ambiguous × Elastic Inference Fabric

The dashboard's **Ambiguous coworker** panel turns selected Fabric work into
tasks in the **Elastic Inference Fabric** Ambiguous workspace. It uses the
existing **Synchronic1** agent identity and the **Fabric handoffs** project.
This is a real server-side API integration, not an embedded human login.

Open [the dashboard panel](https://elasticinferencefabric.airanger.dev/#ambiguous).
The panel is visible before sign-in; connection checks require Fabric access.
Only a **Fabric administrator** may create tasks, share results or read the
private handoff list. The shared demo agent token cannot write to Ambiguous.

## Demo workflow

1. Sign in to EIF with an administrator Fabric access token. Use the
   **Ambiguous coworker** link near the top of the page.
2. Check that the panel says **Connected · Synchronic1 / Elastic Inference Fabric**.
3. Choose **Create a task for Synchronic1**, enter a title and description, and
   select **Create Ambiguous task**. The real task is created as `todo` and
   assigned to Synchronic1 in Fabric handoffs.
4. Alternatively, run a native completion using **Ask the fabric** or the
   workload form. Choose **Publish a completed inference result**, select that
   successful job and inspect the preview. **Publish selected result** creates a
   `done` Ambiguous task containing that result and its job/node/model metadata.
5. Follow **View in Ambiguous**. **Refresh status** retrieves the latest status
   of the ten most recent linked tasks and shows when each was last checked.

```text
Local Dendrite inference → completed Fabric job
                                     ↓ explicit administrator selection
Dashboard → authenticated Worker → Ambiguous task → Synchronic1 workspace
```

There is no automatic export, background job scan, cloud inference fallback,
or autonomous task execution in this bridge. Creating an assigned task does not
guarantee that a coworker has read or completed it. The separate local Ambiguous
notification listener's actual owner-DM wake-up delivery remains unverified.

## Data and authority boundaries

- The Worker stores the Ambiguous agent credential as the encrypted
  `AMBIGUOUS_API_TOKEN` Cloudflare secret. It never returns the credential to
  the frontend, saves it in browser storage, or embeds it in GitHub.
- The verified HTTPS origin is fixed to `https://app.ambiguous.ai`. Requests
  cannot select arbitrary hosts, API paths or redirect destinations.
- Before every new task POST, the Worker verifies `/api/users/me` is the pinned
  agent (not a human) in the pinned workspace, then verifies the pinned project
  belongs to that workspace. Token rotation to another identity fails closed.
- Worker configuration pins `AMBIGUOUS_AGENT_ID`, `AMBIGUOUS_WORKSPACE_ID`, and
  `AMBIGUOUS_PROJECT_ID`. Do not repoint an existing installation's pins to
  another workspace without reviewing its retained handoff records.
- Existing Fabric bearer/cookie authentication, current-role revalidation,
  revocation and cross-origin cookie-write rejection protect every operation.
  Agent/viewer sessions see connection metadata only. Node tokens are rejected.
- Creating a task exports only its title and supplied description. Publishing a
  result exports only that selected successful job's output plus job, model and
  node identifiers. The original inference prompt is not exported. This is an
  explicit disclosure to Ambiguous's cloud workspace even when inference was
  performed on a private LAN.
- Export text is bounded: title 200 characters, task description 8,000,
  completed result 32,000. Oversized exports are rejected, not silently truncated.
  Simulated results, if deliberately selected, are labeled as simulated.
- Result previews are React-escaped plain text. Text published to Ambiguous is
  indented Markdown code, not active model-generated HTML or remote images.
  Downstream agents must still treat result text as untrusted data.

## Durable submission records

The existing Cloudflare **SQLite Durable Object** owns a new
`ambiguous_handoffs` table. It stores operation ID, actor ID, request hash, kind,
optional job ID, title, creation time, outcome, upstream task ID and last-checked
task status. Descriptions, model output and Ambiguous credentials are not copied
into this table. Handoff metadata currently persists until an operator removes
it; the panel shows the latest ten records. Fabric jobs retain their existing
24-hour result retention policy.

Every write must supply a UUID `operation_id`. The Worker records it durably
before the upstream POST, then records the returned verified task ID. A repeated
identical operation returns the existing record without posting again; reusing
the ID with different input conflicts. A successful Fabric job can be exported
at most once, even when a page reload creates a new operation ID.

**A timeout is not evidence that task creation failed.** Ambiguous does not
document upstream task-creation idempotency. Any unverified POST outcome becomes
`uncertain`, including an interruption after the durable claim. It is never
automatically retried by refresh, alarms or a worker restart. A stale pending
record is displayed as uncertain after 60 seconds.

For an uncertain outcome, search/check the Fabric handoffs project in Ambiguous
for `Fabric handoff operation: <operation_id>` before considering a replacement.
The browser locks the current submission form after an uncertain response.
Do not use page reloads or a new operation ID as blind retry mechanisms. This
demo does not implement an operator reconciliation endpoint or delete/reset
action; a retained uncertain result export remains reserved to prevent duplicates.

## API for administrator harnesses

These REST routes are included in the public OpenAPI document and `llms.txt`.
They are not added to the ordinary agent MCP tool list, because those agents do
not have permission to modify this shared Ambiguous workspace.

| Route | Purpose |
| --- | --- |
| `GET /api/ambiguous/status` | Verify connection; administrators also receive recent linked task metadata. |
| `POST /api/ambiguous/handoffs` | Administrator-only explicit task or completed-result handoff. |

Task body:

```json
{
  "operation_id": "a6d3795a-75cc-4196-8d30-263a348ce19c",
  "kind": "task",
  "title": "Review the EIF demo narrative",
  "description": "Explain how idle company CPUs can help agents finish larger tasks."
}
```

Result body: replace `kind` with `result`, omit `description`, and supply `job_id`
for one successful Fabric job. Generate a fresh operation UUID for each
**deliberately new** action, retain it across transport failures, and never blindly
retry a task. Supply the Fabric **administrator** token as a bearer credential;
the Ambiguous credential is not a Fabric token.

Responses: `201` verified creation; `200` existing record (inspect its state);
`202` uncertain outcome requiring reconciliation; `403` insufficient role;
`409` conflicting operation or incomplete job; `413` oversized request/result.
Preflight configuration/identity failures use `502` or `503` and create no task.

## Deployment and verification

Deployed on **2026-09-12**, Worker version
`e0aad4fc-c20a-44af-a6f1-c7075d84bc7a`.

Live verification succeeded on the custom domain:

- `/api/ambiguous/status` verified the pinned agent/workspace/project.
- Explicitly published the existing native Mac/Qwen demo job
  `27793447-ef6d-4836-8fad-fe302958839e`, whose output was `EIF LOCAL OK`
  with the model's empty think wrapper. No unrelated job data was exported.
- Ambiguous returned and independently served
  [the completed demo task](https://app.ambiguous.ai/tasks/17870394-cf3d-441a-810a-95aed63f85e6),
  assigned to Synchronic1 in Fabric handoffs. The operation ID is
  `67992315-bdfb-4dc1-9a09-6d81edf9f469`.
- The refreshed dashboard API listed that real task as `done`.
- The shared demo agent received `403` on a write and connection metadata only
  on status; anonymous status received `401`.
- Both `peter-mac-cpu` and `ubuntu-desktop-node` remained online.
- **79 tests passed**, TypeScript/production build passed, local auth smoke
  passed, and the served dashboard JavaScript contains the panel and both
  actions. These API/asset checks are not a claim of browser interaction QA.

Use the existing native Vite + Wrangler project in `fabric/`. The three
non-secret identity pins are in `wrangler.jsonc`. Provision the agent token with
`npx wrangler secret put AMBIGUOUS_API_TOKEN` from that directory using a secure
operator input path. Never paste it into source or command arguments. Verify the
agent/workspace with the Ambiguous CLI before transferring its saved credential;
environment overrides take precedence over the dedicated directory's config.
Do not rerun signup: the agent and workspace already exist.

Checks:

- `npm test`: authorization, pinning, wrong-origin/redirect failure, bounded
  responses, duplicate/concurrent submissions, unknown-outcome retention,
  input/result validation, status privacy and dashboard wiring.
- `tests/ambiguous-runtime.test.ts` bundles the client into the installed actual
  Worker runtime and uses its native `fetch` with a fake upstream intercepted
  outside the Worker. It verifies identity lookup, task creation and redirect
  rejection, not just Node mocks.
  The deployed workerd runtime rejects `redirect: "error"`; the integration uses
  `manual` and explicitly rejects every non-2xx response (including redirects),
  with no follow-up request. This preserves the no-credential-forwarding boundary.
  Native `fetch` is invoked globally through an arrow wrapper; storing it as a
  client method causes an illegal-receiver error in workerd, unlike Node.
- `npm run build`: TypeScript and production Vite compilation.
- `scripts/auth-smoke.ts`: real local Worker routing, role denial, anonymous
  denial and cross-origin cookie-write rejection. Run with a throwaway local
  bootstrap and an empty `AMBIGUOUS_API_TOKEN` override; unit tests use fake
  upstream responses and never write to the real workspace.
- Browser interaction/visual QA is not verified in this environment; browser
  automation is disabled by the administrator-enforced browser security layer.

Implementation: `fabric/worker/ambiguous.ts`, `fabric/src/AmbiguousPanel.tsx`,
`fabric/src/ambiguous-contracts.ts`, `fabric/src/ambiguous.css`, and
`fabric/tests/ambiguous.test.ts`, with existing Worker/App entry points extended.

API behavior was checked against the installed Ambiguous CLI 0.9.0 OpenAPI
catalog and [the official operating guide](https://app.ambiguous.ai/skill).
