# Dendrite implementation and handoff

This implements the first component of the supplied Ganglion scope:
`HACKATHON_SUBMISSION_DESCRIPTION_AND_SCOPE.md`. Dendrite performs execution;
the [Cloudflare fabric](fabric.md) now supplies the cluster registry and placement.

For Ubuntu VMs, see [remote Linux node setup](remote-linux-node.md): node-bound
credentials, outbound connectivity, ports 18090/18091, and a pinned CPU runtime
build with a small official GGUF model.

## Runtime contract

`dendrite/runtimes/base.py` owns admission, deadline, state transitions, and cache
metadata. Adapters implement `ensure_loaded`, `generate`, and `stop`:

- `ik_llama` / `llama_cpp`: managed native server, or explicitly attached server.
- `helios`: authenticated loopback attachment to a Helios-owned hot model and queue.
- `mock`: deterministic simulation for demonstrating the API without model weights.

Managed mode starts `llama-server` with an operator-configured GGUF, loopback
listener, one slot, CPU/GPU layer count, thread count, and context size. The model
is not advertised as resident until `/health` and `/v1/models` confirm readiness.
A unique alias ties that readiness check to the launched runtime instance.
Switching stops only the child owned by that adapter, then loads the next model.
Shutdown drains the bounded execution lane before stopping owned processes.

Managed native llama inference uses `/completion` with `cache_prompt=true`,
`id_slot=0`, and `stream=false`. Attached raw inference leaves slot selection and
cache policy to the existing server. Raw input is **exactly `prefix + prompt`**:
this path never silently inserts a chat template. Helios and attached llama.cpp
runtimes can also accept structured text-only `messages` through their existing
`/v1/chat/completions` endpoints. For direct llama attachments, Dendrite first
checks `/props` without generating tokens and advertises chat only if the
reported model alias matches and the server reports a nonempty chat template.
An absent or mismatched template leaves raw completion available. The two input
forms are exclusive.
Streaming, embeddings, tools, and multimodal execution are not part of this
node interface. See [the GPU deployment](helios-dendrite.md).

Attached mode verifies the exact `upstream_model` against `/v1/models` before
inference and refreshes discovery before node snapshots and heartbeats. It does
not advertise reusable cache, because other clients may overwrite it. Following
an uncertain inference failure/cancellation, attachment is quarantined: recover
the upstream server and restart Dendrite. It never kills the attached process.
If `/v1/chat/completions` is absent despite `/props`, chat is disabled until
Dendrite restarts; raw attachment remains available. An optional
`api_token_env` supplies a loopback server's bearer token without storing it in TOML.
Attached servers enforce their own context limit; Dendrite's managed
`context_size` setting does not override an already tuned upstream server.

## Prefix-cache semantics

There is at most one advertised candidate per managed runtime slot. An entry
contains the exact prefix's SHA-256, byte length, local model fingerprint,
runtime-instance ID, slot ID, expiry, and simulation status. It contains no prompt
text and explicitly sets `portable=false`.

Entries are cleared on switch, restart, unload, expiry, slot overwrite, in-flight
execution, error, cancellation, and context truncation. A repeated prefix produces
`candidate_before_request=true`; that is a placement hint, not proof of token reuse.

`reported_cached_tokens` is populated only from `timings.cache_n` when provided.
Some IK_Llama versions expose only legacy `tokens_cached`, which is **post-generation
`slot.n_past` in the checked source**. Its value is preserved under
`usage.backend_tokens_cached` for diagnosis, but never counted as reused prompt
tokens. A missing measurement remains `null`; no synthetic cache hit-rate is reported.

The local model fingerprint uses path/device/inode/size/mtime metadata. It is a
fast local invalidator, **not a content checksum or cross-node compatibility proof**.
KV export/import and cross-node transfer are intentionally absent.

## Hardware and model discovery

Discovery reports OS/architecture, CPU counts, memory, current load, known binary
paths, NVIDIA GPU metadata when `nvidia-smi` is available, and Apple Silicon
unified-memory GPU presence. GPU presence does not imply an adapter was compiled
with that accelerator. AMD/Intel accelerator enumeration remains future work.

Configured files are checked for GGUF magic, including extensionless Ollama model
blobs. Additional discovery scans only the first level of configured model
directories, up to 256 entries, at startup. It does not scan the network or infer
capabilities from filenames. Runtimes/models have separate installed, cached,
available, and resident state.

## Node onboarding probe

`dendrite probe` reports what is already running on a machine's loopback ports and
prints a configuration block to paste. It is read-only: it writes no config, starts
nothing, and never adopts an engine, so a probe result cannot become a routing target
by itself. Only loopback is scanned, because `RuntimeConfig.local_endpoint` rejects any
attached origin that is not an http:// loopback address.

Default ports are 8080, 8081, 8000, 1234, 11434, 8090, 18090, 18091, and each finding is
classified:

| Result | Meaning |
| --- | --- |
| `attach-ready` | llama.cpp-family server whose `/completion` accepted the contract |
| `llama-family` | contract not verified; attaching is a guess until `--check-completion` |
| `dendrite-managed-runtime` | a managed runtime owned by another Dendrite; do not attach |
| `dendrite-node` | a Dendrite API is already listening on this port |
| `ollama` | Ollama; it can supply GGUF blobs as files, it cannot be attached |
| `openai-compatible` | `/v1/models` without the llama.cpp contract; cannot be attached |
| `listening-unrecognized` | an open port with no known node API |

The `/completion` check is opt-in, because a completion request can reset the slot prefix
cache of a server other clients share. It sends an empty prompt with `n_predict=0`, so it
verifies the contract without generating tokens. A missing `timings.cache_n` is reported
as a caveat rather than treated as failure: cached-token counts stay `null` on such builds.

A model identifier carrying `@` is a managed alias (`<id>@<instance>`). When every
advertised model looks like that, the port belongs to another Dendrite's managed runtime.
Attaching there would contend with the owner, which terminates that process on model switch
or unload, so the probe reports the finding and does not suggest an attach config.

When a managed runtime is listening but no Dendrite API answered, the probe warns that the
parent may have exited and left it orphaned. The orphan keeps its port and its loaded model,
and a later managed start on that port fails with `Managed port <n> is already in use`.

`--json` emits the same findings with a `schema_version`, a top-level `actionable` flag, the
warnings, each candidate's `supports_chat` observation, and the suggested TOML, for
scripting across a fleet. Chat discovery uses only GET `/props`; it does not send a
completion request. The exit status is 0 when the
node is actionable (an attachable server, or a runtime binary plus weights) and 1 otherwise.

## LAN and control-plane integration

Default binding is loopback. To listen on the private LAN, set `node.host` and
provide `DENDRITE_API_TOKEN` through the environment before launch. Protected
routes use this shared bearer token. This prototype assumes a trusted private
network; HTTP is not encrypted and this is not a production identity system.

The implemented Cloudflare path uses `node.fabric_url` and an outbound secure
WebSocket with a pre-issued node-role Fabric Access Token in
`GANGLION_FABRIC_TOKEN`. The token must be bound to this node ID; bootstrap is
administrator-only and cannot connect a node. See [fabric.md](fabric.md). The older
optional HTTP-heartbeat hook remains available for other control planes:

```text
POST {node.control_plane_url}/v1/nodes/heartbeat
Authorization: Bearer <DENDRITE_API_TOKEN, if configured>
Body: the same schema as GET /v1/node
```

`node.advertise_url` is required in that mode. A heartbeat failure records status
and leaves local execution running. The Cloudflare Worker does not consume this
legacy hook; use its WebSocket bridge instead.

## Reproducing the local native build

Tested IK_Llama source commit: `3bb386eb68ffee0a5dc7db21da0735d594929eeb`.
The ignored source/build tree is `.dendrite/ik_llama.cpp`.

```sh
git clone https://github.com/ikawrakow/ik_llama.cpp.git .dendrite/ik_llama.cpp
git -C .dendrite/ik_llama.cpp checkout 3bb386eb68ffee0a5dc7db21da0735d594929eeb
cmake -S .dendrite/ik_llama.cpp -B .dendrite/ik_llama.cpp/build \
  -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=OFF -DGGML_CUDA=OFF \
  -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF
cmake --build .dendrite/ik_llama.cpp/build --target llama-server -j 4
```

This tests CPU execution on the Mac. The local configuration reuses the
existing Qwen3 1.7B Q4_K_M GGUF; no weights were downloaded or modified.
Another machine needs its own binary and model paths.
Native process working directories are isolated under `node.state_dir`, keeping
backend-created log/cache files inside the ignored `.dendrite` state tree.

## Native timing and historical live verification

Native snapshots may include the latest coherent, non-simulated generation and
prompt timing sample, runtime/model provenance, sample count, and timestamp.
Fabric normalizes timestamps to Unix milliseconds. This is an observed rate—not
a benchmark or capacity promise—and is **Not measured** when absent. A timing
sample does not imply its model remains resident unless the current snapshot says so.

Automated verification: 27 tests passed, including the Oxen task-packet input,
native process fixtures, cache accounting, attachment refresh, and shutdown draining.
Ruff checks passed. The installed test-client dependencies emit two deprecation
warnings; these do not affect the running HTTP service.

Two real requests through Dendrite returned HTTP 200 with `simulated=false`:

| Request | Response | End-to-end time |
| --- | --- | --- |
| What is 2+2? | `4.` | 2,643.75 ms, including model startup |
| What is the capital of France? | `The capital of France is Paris.` | 541.17 ms |

The second request reused the resident model and reported an existing prefix
candidate. The backend processed 18 prompt tokens for a 31-token prompt on the
second request, versus 31/31 on the first. These are observations from this smoke
test, not a controlled latency benchmark. `reported_cached_tokens` remains null
because this backend lacks `timings.cache_n`.

## Development inference routing

The main Codex thread owns integration and verification. Two compact Terra review
assignments ran through `bin/oxen` rather than copying the conversation into new
Codex workers. The first produced design invariants. The second required one
retry because its initial output allowance was consumed with no visible answer.
Returned findings were checked locally; the shutdown and stale-attachment issues
were fixed, while a proposed selection race was rejected because no event-loop
yield exists between selection and uncontended lane acquisition.

Oxen usage returned by those three calls: 1,292 + 5,745 + 6,338 = **13,375 tokens**.
These are Oxen-reported API tokens, not an estimate of Codex allowance. The active
Codex surface does not expose readable usage telemetry here.

## Primary references

- [IK_Llama server documentation](https://github.com/ikawrakow/ik_llama.cpp/blob/main/examples/server/README.md)
- [llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [IK_Llama completion serialization at the tested revision](https://github.com/ikawrakow/ik_llama.cpp/blob/3bb386eb68ffee0a5dc7db21da0735d594929eeb/examples/server/server-context.cpp#L2502)
- [Oxen chat API](https://docs.oxen.ai/inference-api/reference/chat_completions)
