# Ganglion Fabric

Dashboard: https://ganglion-fabric.medinas-sd.workers.dev.
Custom hostname: https://elasticinferencefabric.airanger.dev.
The stable `workers.dev` hostname remains the operational fallback. The custom
hostname was reachable from the Mac for live authentication/API checks later
on 2026-09-12. Earlier DNS paths disagreed; the cause of that discrepancy was
not proven. Do not delete or recreate Workers-managed DNS records.
See the [DNS support packet](dns-repair.md).

`fabric/` contains a React dashboard and a native Cloudflare Worker. A SQLite
Durable Object holds node metadata, job status, and runtime reservations. Each
Dendrite connects outbound over an authenticated WebSocket; no inbound tunnel
to the node is needed. The [architecture diagram](../diagrams/ganglion-architecture.svg)
shows the request path, the trust boundary, and the per-node execution chain
(editable source: [`ganglion-architecture.mmd`](../diagrams/ganglion-architecture.mmd)).
The [request-flow diagram](../diagrams/ganglion-flow.svg) shows that same path in
order, including the heartbeat that keeps a node eligible and the read that
collects the result (editable source:
[`ganglion-flow.mmd`](../diagrams/ganglion-flow.mmd)).

Inference stays on the node. **Prompts and results transit Cloudflare.** This is
a cloud-mediated prototype, not an entirely private-network control plane.
Job results become eligible for pruning after 24 hours, and disconnected node
metadata after seven days. Cleanup runs on subsequent API activity/alarms, so
inactive records may remain longer. Prompts aren't stored in the
job table. Hostnames and capacity/model metadata are sent to the Worker;
binary paths, local process IDs, and runtime errors are omitted.

## Access tokens and sessions

The header always links to **Sign in** (`/#fabric-access`) and **Access tokens**
(`/#access-tokens`). The public sign-in form appears immediately, even while
inventory is loading or unavailable. The public token section explains
administrator provisioning; it does not allow anonymous token creation.

For the project owner's first administrator session on the configured Mac,
run `bin/fabric copy-token` from this repository and paste the copied bootstrap
credential into **Sign in**. Under **Access tokens**, an administrator can use
**Issue a Fabric access token**, selecting label, role, node binding when needed,
and expiry. Copy the new secret once and distribute it securely to its intended
agent/node. Never distribute the bootstrap administrator credential.

Fabric uses pre-issued Fabric Access Tokens (FATs), with `admin`, `agent`, `node`,
or read-only `viewer` roles. Node tokens require a bound `node_id`; agent jobs are scoped to
their token identity. Rotation creates new future-job ownership while admins can
view history. Revocation blocks new calls and reads immediately, though already
accepted local work may finish.

Bootstrap creates an administrator only. Nodes must use a node-role FAT. Login
creates an opaque HttpOnly session cookie; token and session secrets are stored
as hashes, never plaintext. Do not put FATs in URLs, config, prompts, commits,
or logs.

An explicit macOS Keychain identity outranks environment fallback:

```sh
bin/fabric issue-token --name codex --role agent
bin/fabric issue-token --name node-peter --role node --node-id peter-mac-cpu
bin/fabric --identity codex copy-token
```

`copy-token` is an explicit clipboard action; clear the clipboard afterward.
No secret is written into tracked configuration. Issuance uses the bootstrap
administrator by default; an existing named administrator can instead be selected
with `--identity NAME` before `issue-token`. Agents cannot issue tokens.

### Shared demo viewer

**Demo policy update:** the existing shared demo token has been upgraded to an
agent identity with no expiry at the operator's explicit request. The viewer
role itself remains read-only; the shared token's original label is historical.
Agent access can submit work to eligible connected nodes and read its own jobs,
but cannot enroll nodes or administer tokens. All holders share the same job
identity. Node enrollment still requires a separate node-bound credential;
see [Ubuntu node setup](remote-linux-node.md).

For a demo, an administrator can issue a short-lived **Viewer (read-only)**
token and share that credential with attendees. It exposes actual node inventory,
hardware, model/runtime state, and reported performance. It does not expose jobs
or their results, and cannot submit workloads, use MCP, connect nodes, or manage
tokens. Both bearer and dashboard-cookie requests enforce these boundaries.
The dashboard labels viewer sessions read-only and hides task submission/results.

```sh
bin/fabric issue-token --name demo-viewer --label 'Shared demo viewer' --role viewer --days 1
bin/fabric --identity demo-viewer copy-token
```

Paste the token into **Sign in**; it is not embedded in the landing-page bundle
or URLs. Shared viewers use one identity (not individual audit attribution),
with the existing 100-active-session cap. An admin can revoke it under
**Access tokens** at any time; all its cookies become invalid immediately.

The viewer upgrade rebuilds only the token table's role constraint, preserving
all token rows and session identities, and recreates the active-token index.
Initialization is wrapped in [Cloudflare's synchronous SQLite transaction](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync)
so a failed upgrade rolls back. Migration preservation/idempotency, viewer
expiry/revocation, and UI restrictions are covered by tests. The local auth
smoke also checks read-only bearer/cookie requests, empty job lists, rejected
workloads/token management/MCP/node upgrades, and immediate revocation.
New tokens default to 30 days (1–365 configurable); metadata is listed at
`GET /api/tokens`. Revoke an ID with `bin/fabric revoke-token TOKEN_ID`.

## Deployment

```sh
bin/fabric init
cd fabric
npm ci
npm run build
npx wrangler deploy
cd ..
bin/fabric publish-secret
```

`bin/fabric init` creates a bootstrap administrator credential in macOS Keychain if absent. The
publish helper passes it to Wrangler through stdin. Deployment fails closed
until the secret is configured. Set your own account and Worker name in
`fabric/wrangler.jsonc` when deploying elsewhere. Cloudflare account limits
and usage charges apply; the code does not upgrade a plan.

Add `fabric_url = "https://YOUR-WORKER.workers.dev"` under `[node]` in the
node's TOML configuration and set `GANGLION_FABRIC_TOKEN` to a node-role FAT,
then:

```sh
bin/fabric --identity node-peter run-node --config .dendrite/mac.toml
```

On another operating system, set `GANGLION_FABRIC_TOKEN` securely and run
`uv run dendrite serve --config CONFIG`. Cloud connections require HTTPS;
HTTP is allowed only for loopback development.

## Agent-native discovery and tasks

Public entry points contain protocol information, not live private inventory:

- `/.well-known/agent.json`: discovery manifest.
- `/llms.txt`: concise model/endpoint/semantics guide.
- `/openapi.json`: HTTP API description.
- `/v1/models`: static five-model roster; not evidence of model installation.

`POST /mcp` is the official stateless Streamable HTTP MCP endpoint. It accepts
JSON POST requests with `Authorization: Bearer <FABRIC_ACCESS_TOKEN>`. MCP uses
pre-provisioned FATs: it has no OAuth, auto-registration, or OAuth-only-client
support. Tools: `fabric_resources`, `fabric_models`, `fabric_submit_task`, and
`fabric_get_task`. Resources: `fabric://resources`, `fabric://models`, and
`fabric://identity`. Visiting the page does not automatically register these
tools: configure the endpoint or stdio gateway in the harness.

For stdio-only clients, use the local gateway. This generic example does not
modify any Codex/client configuration:

```json
{"mcpServers":{"ganglion-fabric":{"command":"/absolute/path/to/repo/bin/fabric","args":["--identity","codex","mcp"]}}}
```

Inspect it with `bin/fabric --identity codex mcp-check --submit`.

Authenticated API:

- `GET /v1/resources` or `/api/fabric`: node snapshots and capacity aggregates.
- `POST /v1/tasks`: capability task, returns HTTP 202 and a job ID.
- `GET /v1/tasks/{id}`: placement, state, result or error.
- `GET /v1/nodes/connect?node_id=...`: Dendrite WebSocket protocol.

The repo helper reads credentials without exposing them:

```sh
bin/fabric --identity codex request https://YOUR-WORKER.workers.dev /v1/resources
bin/fabric --identity codex request https://YOUR-WORKER.workers.dev /v1/tasks \
  --body-file examples/qwen-task.json
```

For ordinary text chat, send `messages` and let the selected node apply its
resident model's template:

```json
{"capability":"complete","messages":[{"role":"user","content":"What is 2+2? Answer briefly."}]}
```

`messages` accepts up to 32 text-only `system`, `user`, or `assistant` entries,
with a user message last. Chat placement requires a runtime that advertises
`supports_chat`; older raw-only nodes are excluded. For advanced raw completion,
send `prompt` and optional `prefix` instead. Raw input remains exactly
**prefix + prompt** with no inserted template. The two input forms cannot be
combined. Either form accepts optional `model_id`, `max_tokens`, `temperature`,
and `allow_simulated` (default false). Results are not streamed.
The dashboard's task form is one independent inference job per submission; it
does not retain conversation history or provide web search. Its output limit is
adjustable (default 512 tokens). If a node returns no visible text, Fabric marks
the job failed and retains usage metadata rather than showing a blank success.

## Placement and liveness

Only connected nodes with heartbeats newer than 30 seconds are eligible.
The scheduler filters by available capability/model, idle runtime, and
simulation policy; then prefers matching node-local prefix candidates and
resident models. Durable per-runtime reservations prevent concurrent dispatch
from relying solely on advisory heartbeat load. There is no inference fallback
to Oxen or another cloud service, and no automatic task retry.

Jobs expire after 180 seconds. Disconnects/replacements fail in-flight jobs.
Timed-out runtime reservations remain quarantined until separated idle
heartbeats demonstrate recovery. Dendrite cancels connection-bound work on
disconnect. An uncertain failure is not proof that no computation occurred.

## Dashboard topology and timing

The landing page shows a clearly labeled architecture-only demo at `/#flow`
without authentication, above the model roster. It shows agent → authenticated
MCP router → illustrative Dendrite/runtime/model, plus returning heartbeat and
result paths. It contains no actual node identities, resource counts, or rates.
Signing in replaces the schematic with live inventory; a connection error keeps
the last snapshot visibly labeled as stale. Private inventory endpoints remain
authenticated.

The live topology renders only actual authenticated node snapshots: agent or
harness → MCP router → Dendrite node → local runtime/model. Heartbeats and
results travel back from nodes. Online/stale/offline state and resident, cached,
or unprovisioned model chips come from live reports; no node or model is invented.

Generation rate is the latest coherent native timing observation with its
reporting model/runtime and timestamp. It is not a benchmark or capacity
guarantee. Missing/null timing displays as **Not measured**; only currently
reported model provision is shown as available.

The throughput bench grows vertically with the reported node inventory, with
one complete lane per node and no four-node height cap. New nodes appear on the
next live snapshot without a page reload; use normal page scrolling to reach
later lanes. Stale/offline nodes retain their labeled lanes while they remain
in inventory. Removing a node from inventory contracts the bench.

Demo presentation labels are shared by the flow diagram, throughput bench/table,
and resource cards: `peter-mac-cpu` displays as **Mac — Portable · Local**;
`ubuntu-desktop-node` displays as **Ubuntu node — Remote · Sweden**. These are
operator-supplied labels, not automatic geolocation. Canonical node IDs remain
visible and unchanged in authentication, routing, and agent APIs. Other nodes
keep their reported IDs without inferred device type or location.

Prefix candidates are hashes/locality hints, not portable KV state or measured
cache hits. CPU/GPU inventory reports detected hardware, not necessarily
accelerators enabled in the compiled runtime. The current Mac native build
uses CPU only. Model roles are configured intent, not evaluated quality scores.

## Local verification

```sh
uv sync --locked
uv run pytest -q
uv run ruff check dendrite tests bin/fabric
cd fabric
npm ci
npm test
npm run build
npm run preview
```

For loopback development, put a non-production token at least 16 characters
long in ignored `fabric/.dev.vars` as `FABRIC_TOKEN=...`. Never reuse the
production token in a tracked file. The preview listens on `127.0.0.1:8787`.
For UI hot reload, run `npm run dev` alongside it.

For the isolated authorization integration test, follow the two-terminal
invocation in `fabric/scripts/auth-smoke.ts`. It uses throwaway credentials and
refuses non-loopback targets. Wrangler can rewrite the internal request origin
from the configured custom domain; the script documents the required local-only
origin override. Do not add that HTTP origin to the production allowlist.

## Verified deployment (2026-09-12)

Worker version: `c01555a7-13da-40cc-a79b-0915b99094b3`.
62 Python tests and 27 Worker/dashboard tests passed, along with Ruff, strict
TypeScript, production assets, and Wrangler deployment. Local integration
verified role boundaries, per-agent job visibility, cookie revocation,
node-token revocation closing its socket, and MCP bearer/Origin enforcement.

The deployed endpoint was tested with the official MCP client over both
Streamable HTTP and the stdio bridge: four tools and three resources discovered.
An agent-role task executed on `peter-mac-cpu` using `qwen3-1.7b` / `ik-cpu`,
returning `4.` with `simulated=false` in 1,169.99 ms including model startup.
The next heartbeat carried generation and prompt timing telemetry. Its
117.37 generated tokens/sec was a **three-token sample**, not a throughput
benchmark or sustained capacity estimate.

The local `codex` agent and `node-peter` connector identities are stored in
macOS Keychain, with 30-day expirations. Bootstrap remains admin-only. The
Mac connector is running with its node-bound identity; no startup-at-boot
service was installed. Browser visual QA remains unavailable due an
administrative computer-use policy; build/SSR and live HTTP checks passed.

The local Git repository is `AiTinkerersVenice` on `main`. Existing history and
remote configuration were preserved; this implementation's working changes
have not been committed or pushed.

Landing-page demo update: `cfa8e774-89d4-4dd6-86e5-859901a85d07`.
The diagram is now above the roster and visible without login, with an explicit
architecture-only label. All 30 Worker/dashboard tests and the production build
passed, including public-demo, empty-live, stale-snapshot, and placement checks.

Auth-discoverability update: `9a4de457-c4f9-454c-b871-516cf90f9fcc`.
31 Worker/dashboard tests and the production build passed. On the custom domain,
a temporary agent token was issued by the administrator, authenticated, denied
token-administration access, listed without revealing its secret, revoked, and
then rejected. The temporary credential is no longer active. Browser inspection
remains blocked by an administrative policy, so this is rendered-markup/build
and live API verification, not a claimed visual browser check.

### Shared viewer deployment — 2026-09-12

Worker version `b2d14789-4e81-4255-aef3-f2c506313cbb` added read-only viewers.
34 Worker/dashboard tests, 15 Fabric CLI tests, and the expanded local auth
smoke passed. Live verification checked viewer bearer/cookie inventory,
empty jobs, rejected task/token/MCP operations, and preservation of the existing
agent and node identities. One temporary verification session was logged out;
the shared token remains active for the requested demo.

Issued identity: `demo-viewer-20260912`; token ID
`88a4aaef-cdfc-43e4-9850-f61f9c72f29f`; label **Shared hackathon demo viewer**.
Original expiry: **2026-09-13 13:43 PDT**, subsequently removed by the approved
demo upgrade below. Its secret is stored in the named macOS
Keychain identity and shared directly with the operator, not committed or
embedded in frontend assets. Retrieve via
`bin/fabric --identity demo-viewer-20260912 copy-token`, or revoke via the admin
dashboard. Anyone holding it can inspect the live inventory until expiry or
revocation; this deliberately does not provide individual attendee attribution.

Local Wrangler logged an unread-request-stream warning for rejected token POSTs
(including the pre-existing agent denial path), while returning the expected
403 responses. This did not fail the smoke assertions; it is not claimed fixed.

### Branding and theme

Deployed Worker version: `d252dab7-3c45-4dd3-9fa9-f9f3a623780d`.
All 38 Worker/dashboard tests and the production build passed.

The public dashboard uses the name **Elastic Inference Fabric**, a monochrome
connected-compute-tile mark, and a matching SVG favicon. Internal Worker,
Durable Object, CLI, and node service names remain unchanged.

The header light/dark button applies to the full dashboard, including topology,
access controls, model cards, and workload panels. First load respects the
device preference; an explicit choice persists under the device-local
`eif-theme` key and is applied before paint. If browser storage is blocked,
switching still works for the current page. No credentials are stored with the
theme preference. Automated tests cover startup priority, both toggle directions,
and storage-denied behavior; these are not visual browser QA.

### Non-expiring demo agent — 2026-09-12

Worker version `e64d0fe6-db8f-4885-8a68-aa8e1e7911f1` adds an administrator-only
PATCH operation for active agent/viewer token role and expiry. The existing
shared token ID `88a4aaef-cdfc-43e4-9850-f61f9c72f29f` now has `role: agent` and
`expires_at: null`; the secret did not change. Its old label containing “viewer”
is historical. Refresh the dashboard to fetch the current role.

Live checks confirmed non-read-only inventory, denied token administration,
MCP discovery, and real inference through the same shared token. Job
`68f5d204-c8e6-4537-a0c0-249a47f11114` succeeded on `peter-mac-cpu` with
`qwen3-1.7b`, returned `4`, and reported `simulated:false` (2,046.87 ms local
elapsed time). This was a connectivity/authorization test, not a benchmark.

Token expiry is optional only when an administrator explicitly requests it;
omitting expiry still defaults to 30 days. CLI issuance supports `--no-expiry`.
Sessions retain a finite 12-hour lifetime; a non-expiring token can sign in again.
Revocation, role restrictions, admission/size/time bounds and actual node
capacity remain enforced. This does not grant unlimited physical compute or
anonymous node enrollment. The new admin PATCH cannot change node/admin tokens
or resurrect expired/revoked tokens. Local integration checked session role
refresh and cookie-Origin restrictions; an initial smoke attempt was interrupted
by local development reload, and the stable rerun passed.

## References

- [Cloudflare Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Worker static assets](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Primary model catalog and source cards](../fabric/src/model-catalog.ts)
