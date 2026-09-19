# Connect an Ubuntu CPU node to Elastic Inference Fabric

Use the existing Dendrite checkout on the VM. No public VM address, inbound
firewall opening, GPU, Cloudflare account, or Oxen key is needed. Dendrite opens
an outbound TLS WebSocket on port 443 to the fabric and receives tasks on that
connection. Keep its local HTTP API and native server on loopback.

## 1. Issue a node credential (administrator, not on the VM)

Sign in as an administrator at
https://elasticinferencefabric.airanger.dev/#access-tokens and issue a token:

- Label: `Ubuntu CPU VM`
- Role: **Node connector**
- Node ID: `ubuntu-cpu-01` (choose a unique ID per machine)
- Expiry: choose the desired period; the dashboard defaults to 30 days.

Alternatively, on the configured **Mac**, from this repository:

```sh
bin/fabric issue-token --name node-ubuntu-cpu-01 --label 'Ubuntu CPU VM' \
  --role node --node-id ubuntu-cpu-01 --no-expiry \
  --origin https://elasticinferencefabric.airanger.dev
bin/fabric --identity node-ubuntu-cpu-01 copy-token
```

The helper stores credentials in macOS Keychain: do not run its Keychain commands
on Linux. Transfer only the newly issued **node** token securely to the VM.
The shared demo **agent** token cannot enroll a node. Never copy the bootstrap
administrator token to the VM. Do not reuse a node ID on two machines: a new
connection with the same node ID replaces the old connection.

## 2. Connect immediately using the working mock configuration

In your working TOML, replace its existing `[node]` block with the following,
leaving its current mock `[[runtimes]]` and `[[models]]` blocks unchanged. Save
the complete file as `configs/ubuntu-demo.toml`:

```toml
[node]
id = "ubuntu-cpu-01"
host = "127.0.0.1"
port = 18090
state_dir = "../.dendrite/ubuntu-cpu-01"
fabric_url = "https://elasticinferencefabric.airanger.dev"
fabric_token_env = "GANGLION_FABRIC_TOKEN"
heartbeat_seconds = 10
```

From the repository root in **Bash** on the VM:

```bash
uv sync --locked
read -rsp 'Node Fabric token: ' GANGLION_FABRIC_TOKEN
printf '\n'
export GANGLION_FABRIC_TOKEN
uv run dendrite serve --config configs/ubuntu-demo.toml
```

Leave it running. From another terminal:

```sh
curl -fsS http://127.0.0.1:18090/healthz
curl -fsS http://127.0.0.1:18090/v1/node
```

The dashboard should show `ubuntu-cpu-01` online shortly after its first
heartbeat. A successful local health check alone does not prove a fabric
connection. Mock models are simulated and require `allow_simulated:true` in a
fabric task request. They cannot provide real inference or measured throughput.
If `DENDRITE_API_TOKEN` is set, local protected routes also need that separate
bearer token; `/healthz` remains public on loopback.

## 3. Add a native CPU runtime and weights

Stop only this Dendrite foreground process with Ctrl-C before switching configs;
leave the Plane service on port 8090 alone. From the VM's repository root:

```sh
sudo apt-get update
sudo apt-get install -y build-essential cmake git curl ca-certificates
mkdir -p .dendrite models
git clone https://github.com/ikawrakow/ik_llama.cpp.git .dendrite/ik_llama.cpp
git -C .dendrite/ik_llama.cpp checkout 3bb386eb68ffee0a5dc7db21da0735d594929eeb
cmake -S .dendrite/ik_llama.cpp -B .dendrite/ik_llama.cpp/build \
  -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=OFF -DGGML_CUDA=OFF \
  -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF
cmake --build .dendrite/ik_llama.cpp/build --target llama-server -j 2
.dendrite/ik_llama.cpp/build/bin/llama-server --version
```

This pins the IK_Llama revision already tested by this project. The compiled
binary is named `llama-server`, even though its source project is IK_Llama.
If the source directory already exists, inspect and reuse it rather than
cloning over or resetting local edits. Use fewer build jobs if the VM runs out
of RAM. An executable must be runnable on this VM; copying a Mac binary will
not work.

**Check the node before building on it.** A stock llama.cpp `llama-server` is an
accepted substitute for this build: `ik_llama` and `llama_cpp` select the same
adapter, and the managed command line uses only upstream flags. A different
revision can change `/completion` telemetry — notably `timings.cache_n`, which some
builds omit, leaving cached-token counts `null`:

```sh
uv run dendrite probe --check-completion --model-dirs ../models
```

The probe is read-only, scans loopback only, and prints a config block to paste.
It also reports an existing Ollama store, whose blobs a managed runtime can load as
ordinary GGUF files without involving Ollama's API. See
[the probe reference](node-runtime.md#node-onboarding-probe).

For a small starter model, the official
[Qwen2.5 0.5B Instruct GGUF repository](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/tree/main)
provides `qwen2.5-0.5b-instruct-q4_k_m.gguf` (approximately 491 MB). The model
also needs runtime/context memory; file size is not a RAM requirement.

```sh
curl --fail --location --retry 3 --continue-at - \
  --output models/qwen2.5-0.5b-instruct-q4_k_m.gguf \
  https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf
```

Create `configs/ubuntu-cpu.toml` with this complete configuration:

```toml
[node]
id = "ubuntu-cpu-01"
host = "127.0.0.1"
port = 18090
state_dir = "../.dendrite/ubuntu-cpu-01"
model_dirs = ["../models"]
fabric_url = "https://elasticinferencefabric.airanger.dev"
fabric_token_env = "GANGLION_FABRIC_TOKEN"
heartbeat_seconds = 10

[[runtimes]]
id = "ubuntu-cpu"
kind = "ik_llama"
mode = "managed"
executable = "../.dendrite/ik_llama.cpp/build/bin/llama-server"
port = 18091
threads = 2
context_size = 2048
gpu_layers = 0

[[models]]
id = "qwen2.5-0.5b-instruct"
runtime = "ubuntu-cpu"
path = "../models/qwen2.5-0.5b-instruct-q4_k_m.gguf"
capabilities = ["complete", "classify", "summarize", "extract"]
```

Both 18090 and 18091 must be unused. Paths resolve relative to the TOML file;
this example assumes it is in `configs/`. The explicit executable path means
no PATH modification is necessary. Adjust `threads` for available vCPUs.

Start with the same exported node credential:

```sh
uv run dendrite serve --config configs/ubuntu-cpu.toml
```

Dendrite starts the native server on demand; do not start another managed
`llama-server` manually on port 18091. A cached model is not resident until it
has been loaded. To warm and test it locally in another terminal:

```sh
curl --fail-with-body http://127.0.0.1:18090/v1/execute \
  -H 'Content-Type: application/json' \
  --data '{"capability":"complete","model_id":"qwen2.5-0.5b-instruct","prompt":"<|im_start|>user\nWhat is 2+2? Answer briefly.\n<|im_end|>\n<|im_start|>assistant\n","max_tokens":32,"temperature":0}'
```

Expect `simulated:false`. The native interface sends raw `prefix + prompt`, so
the example supplies ChatML explicitly. After the next heartbeat the node's
model should be resident and valid native timing, if reported, should appear
in the dashboard. This extra small model appears in node inventory; it is not
one of the fixed five primary-model cards. Capabilities are configured routing
labels, not guarantees of model quality.

## 4. Verify cloud dispatch

Sign in to the dashboard using an **agent** token (the shared demo token now
supports this) or an administrator token. Submit capability `complete`, model
`qwen2.5-0.5b-instruct`, and the same ChatML prompt above. Confirm the result's
selected node is `ubuntu-cpu-01` and its response is non-simulated. The scheduler
chooses among eligible nodes; a matching model ID makes this test specific only
when no other connected node advertises that same model.

All holders of the shared demo agent token share a job identity and can see
that identity's results. Use only demo prompts with it. Ordinary capacity,
payload-size, and timeout protections still apply; non-expiring access is not
unlimited physical compute. Node enrollment and token management stay protected.

## Troubleshooting

- **Unknown `fabric_url` config field:** update to a checkout with the WebSocket
  bridge (`dendrite/fabric.py`, dependency `websockets`), then run `uv sync --locked`.
- **No node on dashboard:** check `fabric_url`, the exported variable name,
  token role, exact bound node ID, expiry/revocation, DNS, and outbound TCP 443.
  Use the origin only, not `/mcp`, `/api`, or a WebSocket URL in the TOML.
- **Local health succeeds, cloud connection fails:** local health is independent
  of the bridge. Logs can report retrying while the local API stays available.
- **Proxy-only egress:** the current bridge uses `proxy=None`; it needs direct
  outbound WebSocket connectivity. It does not automatically honor proxy env vars.
- **TLS/HTML challenge instead of JSON or WebSocket upgrade:** check the VM clock,
  CA certificates, egress proxy, and Cloudflare policy. Do not disable TLS verification.
  For isolated custom-domain DNS issues, the same fabric is also at
  `https://ganglion-fabric.medinas-sd.workers.dev`; no credential changes are needed.
- **Native model unavailable:** verify binary execute permission and its `--version`,
  readable GGUF content (not a failed HTML download), and paths relative to TOML.
- **Port already in use:** change the appropriate TOML port; never stop Plane
  simply to free 8090. Dendrite and the native runtime need distinct ports.
- **`Managed port <n> is already in use` after a crash:** a managed `llama-server`
  child can outlive an ungraceful Dendrite exit and keep both its port and its loaded
  model. Check with `ps -Ao pid,ppid,etime,command | grep llama-server`; `dendrite probe`
  warns when it finds a managed runtime whose owning node is gone.
- **No eligible node:** check connected/online state, exact capability/model ID,
  non-simulated availability, and idle runtime. A busy lane is not an auth failure.
- **SSH session closes:** foreground processes/environment do not form a persistent
  service. Once verified, run Dendrite under your VM's service manager with an
  absolute config path and a protected environment file containing only its node
  credential. No service has been installed on your VM by these instructions.

These commands were checked against the repository configuration and bridge;
the remote VM itself has not been accessed or modified from this session.
