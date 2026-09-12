# Ganglion Fabric

Dashboard: **https://elasticinferencefabric.airanger.dev**.
Agent entry point: **https://elasticinferencefabric.airanger.dev/.well-known/agent.json**.
The workers.dev hostname remains available as an operational fallback.
The Mac node currently connects through that stable hostname to the same
Durable Object; dashboard and agent clients can use the custom domain.

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

## Credentials and deployment

The Worker uses `FABRIC_TOKEN`; Dendrite uses `GANGLION_FABRIC_TOKEN`. This is
a single trusted-team credential, not a multi-tenant identity system. It is
separate from the Oxen API key. Do not commit credentials or pass them in URLs.

```sh
bin/fabric init
cd fabric
npm ci
npm run build
npx wrangler deploy
cd ..
bin/fabric publish-secret
```

`bin/fabric init` creates a random token in macOS Keychain if absent. The
publish helper passes it to Wrangler through stdin. Deployment fails closed
until the secret is configured. Set your own account and Worker name in
`fabric/wrangler.jsonc` when deploying elsewhere. Cloudflare account limits
and usage charges apply; the code does not upgrade a plan.

Add `fabric_url = "https://YOUR-WORKER.workers.dev"` under `[node]` in the
node's TOML configuration, then:

```sh
bin/fabric run-node --config .dendrite/mac.toml
```

On another operating system, set `GANGLION_FABRIC_TOKEN` securely and run
`uv run dendrite serve --config CONFIG`. Cloud connections require HTTPS;
HTTP is allowed only for loopback development.

For dashboard access, run `bin/fabric copy-token`, paste into the login field,
and clear the clipboard afterward. Login creates a 12-hour HttpOnly,
SameSite=Strict cookie (Secure on HTTPS). The raw token is not placed in
localStorage. Rotating the shared secret invalidates cookies; restart existing
node connections when rotating. All authenticated users have operator access.

## Agent-native discovery and tasks

Public entry points contain protocol information, not live private inventory:

- `/.well-known/agent.json`: discovery manifest (custom REST protocol, not MCP/A2A).
- `/llms.txt`: concise model/endpoint/semantics guide.
- `/openapi.json`: HTTP API description.
- `/v1/models`: static five-model roster; not evidence of model installation.

Authenticated API:

- `GET /v1/resources` or `/api/fabric`: node snapshots and capacity aggregates.
- `POST /v1/tasks`: capability task, returns HTTP 202 and a job ID.
- `GET /v1/tasks/{id}`: placement, state, result or error.
- `GET /v1/nodes/connect?node_id=...`: Dendrite WebSocket protocol.

The repo helper reads credentials without exposing them:

```sh
bin/fabric request https://YOUR-WORKER.workers.dev /v1/resources
bin/fabric request https://YOUR-WORKER.workers.dev /v1/tasks \
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

Verified in this build: 34 Python tests and 10 Worker/dashboard tests; strict
TypeScript and production build; live session/CSRF checks, node WebSocket
registration, and cloud-routed native Qwen3 inference returning `4.` with
`simulated=false`. Browser visual QA was unavailable due an admin-policy check.

## References

- [Cloudflare Durable Object WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Worker static assets](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Primary model catalog and source cards](../fabric/src/model-catalog.ts)
