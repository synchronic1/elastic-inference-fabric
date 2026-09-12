# Ganglion — local inference fabric

Dendrite turns a machine's local GGUF models into an HTTP execution node for
Ganglion. The **node layer** implements hardware discovery,
runtime adapters, model residency and switching, capability-based execution,
and conservative prefix-cache metadata. The **Cloudflare fabric** adds an
authenticated resource dashboard, outbound node connections, durable task
placement, and machine-readable agent discovery.

## Architecture

![Architecture diagram: an agent or harness sends an authenticated request to the Cloudflare control plane, which authorizes it with a Fabric access token and places it on an outbound-connected Dendrite node; the node executes locally against its runtime and GGUF models and returns results and heartbeats.](diagrams/ganglion-architecture.svg)

Agents reach the authenticated control plane, which places each job on an
outbound-connected Dendrite node. Inference stays on that node; there is no cloud
inference fallback. Nodes report hardware, model residency, and measured
throughput back over the same connection. Each runtime holds one execution slot.

The editable source is [`diagrams/ganglion-architecture.mmd`](diagrams/ganglion-architecture.mmd)
(mermaid; its `.excalidraw` sibling opens at excalidraw.com). The committed SVG
carries an opaque white card background so it stays legible under GitHub's dark
theme, so re-rendering the `.mmd` needs that background rect re-added.

## Fabric dashboard and five-model roster

Live: [Ganglion Fabric](https://elasticinferencefabric.airanger.dev).
Run `bin/fabric copy-token` to copy the dashboard login token from Keychain.

The dashboard lists five intended specializations, with live **Running / Cached /
Not provisioned** status. The public roster is visible without login; live node
inventory and task execution require authentication.

| Model | Intended role |
| --- | --- |
| Qwen3 0.6B | Intent routing / classification |
| Qwen2.5 Coder 1.5B | Code analysis |
| SmolLM2 1.7B | Summarization |
| Qwen2.5 0.5B | Structured extraction |
| Qwen3 1.7B | Reasoning / judging / completion |

These are starting roles, not benchmark claims. Only Qwen3 1.7B is currently
installed on this Mac. See [the portable five-model config](configs/dendrite.five-models.toml)
and [fabric setup and API guide](docs/fabric.md).

## Run on this Mac

The local configuration uses the compiled IK_Llama server and the existing
Qwen3 1.7B GGUF in the Ollama cache. It runs on CPU, with no cloud inference:

```sh
uv sync --locked
bin/fabric run-node --config .dendrite/mac.toml
```

Open [the node API docs](http://127.0.0.1:8090/docs) or inspect
[node state](http://127.0.0.1:8090/v1/node). `.dendrite/mac.toml` is machine-local,
ignored by Git, and must be recreated on a different machine.
The helper injects the Fabric credential from macOS Keychain. For a standalone
node without `node.fabric_url`, run `uv run dendrite serve --config CONFIG` directly.

## Run on another node

Requires Python 3.11+, an IK_Llama/llama.cpp `llama-server` binary, and a local GGUF.
Edit [configs/dendrite.local.toml](configs/dendrite.local.toml) for that machine:

```sh
uv sync --locked
uv run dendrite inspect --config configs/dendrite.local.toml
uv run dendrite serve --config configs/dendrite.local.toml
```

Use [the attach configuration](configs/dendrite.attach.toml) for an existing local
server. Dendrite verifies its model ID and never owns its process lifecycle.
For a no-model plumbing demo, use `configs/dendrite.mock.toml`; every simulated
result is explicitly marked.

## Execute a task

Requests use **raw completion prompts**. `prefix` is prepended exactly to `prompt`;
the caller is responsible for the model's chat template, if one is needed.
This example uses the Qwen3 template for the configured Mac node:

```sh
curl -sS http://127.0.0.1:8090/v1/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "capability": "complete",
    "prefix": "<|im_start|>system\nAnswer briefly.<|im_end|>\n<|im_start|>user\n",
    "prompt": "What is 2+2? /no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
    "max_tokens": 24,
    "temperature": 0
  }'
```

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Daemon liveness; not model readiness |
| `GET /v1/node` | Hardware, load, models, residency, runtime state, cache candidates |
| `POST /v1/execute` | Resolve capability locally, load/reuse a model, execute |
| `POST /v1/models/load` | Preload/switch using `{"model_id":"..."}` |
| `POST /v1/runtimes/{id}/unload` | Release an owned model process |

Each runtime has one execution slot. Busy requests return `429` with `Retry-After`.
Separate configured runtimes use independent slots/ports. GGUFs are not downloaded
automatically, and capability labels are operator declarations, not benchmark results.

## Verification

```sh
uv run pytest -q
uv run ruff check dendrite tests
```

Tests cover subprocess lifecycle with a protocol fixture, concurrency,
timeouts/crashes, immediate switching, attachment protection, authentication,
cache invalidation, and heartbeat failure. The fixture tests are not evidence
of real model quality. See [the build notes](docs/node-runtime.md) for real-model
verification and remaining boundaries.

The [Oxen CLI](docs/oxen-gateway.md) supplies separate, explicitly requested
development-worker inference. Dendrite's execution path never calls Oxen.
