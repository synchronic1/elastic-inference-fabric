# Ganglion Fabric

Dashboard: https://ganglion-fabric.medinas-sd.workers.dev.
Custom hostname: https://elasticinferencefabric.airanger.dev.
The stable `workers.dev` hostname remains the operational fallback. Custom-DNS
authority and managed-record answers are currently unresolved; this is not a
cache-only issue. Do not delete or recreate DNS records to work around it.
See the [DNS support packet](dns-repair.md).

`fabric/` contains a React dashboard and a native Cloudflare Worker. A SQLite
Durable Object holds node metadata, job status, and runtime reservations. Each
Dendrite connects outbound over an authenticated WebSocket; no inbound tunnel
to the node is needed.

Inference stays on the node. **Prompts and results transit Cloudflare.** This is
a cloud-mediated prototype, not an entirely private-network control plane.
Job results become eligible for pruning after 24 hours, and disconnected node
metadata after seven days. Cleanup runs on subsequent API activity/alarms, so
inactive records may remain longer. Prompts aren't stored in the
job table. Hostnames and capacity/model metadata are sent to the Worker;
binary paths, local process IDs, and runtime errors are omitted.

## Access tokens and sessions

Fabric uses pre-issued Fabric Access Tokens (FATs), with `admin`, `agent`, or
`node` roles. Node tokens require a bound `node_id`; agent jobs are scoped to
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

Task fields are `capability`, `prompt`, optional `prefix`, `model_id`,
`max_tokens`, `temperature`, and `allow_simulated` (default false).
Native input is exactly **prefix + prompt**. Use the model's chat template;
the dashboard's Qwen example supplies one. Results are not streamed.

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

The live topology renders only actual authenticated node snapshots: agent or
harness → MCP router → Dendrite node → local runtime/model. Heartbeats and
results travel back from nodes. Online/stale/offline state and resident, cached,
or unprovisioned model chips come from live reports; no node or model is invented.

Generation rate is the latest coherent native timing observation with its
reporting model/runtime and timestamp. It is not a benchmark or capacity
guarantee. Missing/null timing displays as **Not measured**; only currently
reported model provision is shown as available.

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

## References

- [Cloudflare Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Worker static assets](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Primary model catalog and source cards](../fabric/src/model-catalog.ts)
