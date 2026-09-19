# Dendrite attached to Helios on the GPU compute VMs

The deployed Dendrite nodes on VM108 and VM404 attach to models already hot in
Helios. Dendrite owns no `llama-server` process or GGUF on these nodes. It
checks Helios health, the exact model selector, and the hot runtime instance
before advertising a model to Fabric. Execution goes through Helios's
authenticated `/v1/completions` route, which provides its local admission and
queue. Dendrite never unloads a Helios runtime.

| VM | Fabric node ID | Helios selector | Dendrite model ID | GPU placement |
| --- | --- | --- | --- | --- |
| 108 | `vm108-gpu-01` | `qwen3.8-27b-atx-iq4_xs` | `qwen3.8-27b-atx-vm108` | Two RTX 3060s |
| 108 | `vm108-gpu-01` | `qwen3.8-27b-q4_k_xl` | `qwen3.8-27b-q4-vm108` | V100 |
| 404 | `r430a-gpu-01` | `bonsai2-27b-pq2_0` | `bonsai2-27b-r430a` | RTX 3060 |

The operator-owned configurations are
[`configs/vm108-gpu.toml`](../configs/vm108-gpu.toml) and
[`configs/r430a-gpu-helios.toml`](../configs/r430a-gpu-helios.toml). Both bind
Dendrite's local HTTP API to `127.0.0.1:18090` and connect outbound to Fabric.
Helios is only contacted at `127.0.0.1:8471`. The node credential is bound to
its exact node ID; the Helios token is a separate credential. The live units
are `dendrite-vm108.service` and `dendrite-r430a.service`, enabled in systemd.
Each uses a root-owned, mode-`0600` environment file in `/etc/dendrite/` with
`GANGLION_FABRIC_TOKEN`, `HELIOS_API_TOKEN`, and a separate
`DENDRITE_API_TOKEN` for the loopback HTTP API. `/healthz` stays public on
loopback; `/v1/node` and execution routes require that local token. Never put
these values in TOML, the repository, shell history, or command-line
arguments. The Fabric node
tokens issued for this pilot expire 30 days after 2026-09-19 and need rotation.

Probe is observational; it does not enroll an engine. Helios attachment must
be configured explicitly because sharing an existing model is an operator
decision. Use one Dendrite runtime per independently hot Helios model. The
`upstream_model` value must be the exact Helios selector, not `ganglion-auto`
or a cold configured model. If a hot instance disappears or its ID changes,
Dendrite stops advertising it until Helios reports a healthy hot instance.
An uncertain in-flight failure quarantines that attachment until Dendrite is
restarted. The process and model remain owned by Helios.

Fabric's recommended `messages` input uses Helios's
`/v1/chat/completions` route on these nodes. Helios applies the resident GGUF's
chat template. A plain user message returned `4` on both VM108 models and
VM404's Bonsai model without caller-supplied template markers. Advanced raw
`prefix + prompt` requests still use `/v1/completions` unchanged. For Bonsai2,
an unformatted raw question produced an empty completion; this explicit raw
prompt produced a plain `4` in the earlier smoke test:

```text
<|im_start|>user
What is 2+2? Answer with just the number.
<|im_end|>
<|im_start|>assistant
<think>

</think>

```

The raw example was checked against the resident Bonsai server's `/props` chat
template. Agents should normally send structured `messages` instead.

## Chat setup probe

An administrator can open **Ask the fabric** and select **Run setup probe** for
an online node. The console calls Fabric's admin-only
`POST /api/nodes/{node_id}/chat-probe`; Fabric asks the connected Dendrite to
probe only its already hot Helios models. The probe submits at most two tiny
synthetic requests per model through Helios's existing queue: first a ChatML
completion with a completed thinking prefill, then structured chat if the first
does not return the exact challenge. It never unloads a model, changes runtime
flags, compiles a binary, or writes a node configuration. Dendrite advertises
the verified format, model ID, hot instance ID, and check time in its runtime
snapshot. A hot instance change clears that result and requires another probe.

The console uses the advertised format for later turns. VM108 and VM404 now
advertise `raw_chatml_no_think` for all three hot models; no model-ID mapping
remains in Fabric. A missing or unverified profile uses structured chat until
the operator reruns the setup probe. No external AI API is needed for this
deterministic contract check.

The current Fabric scheduler reserves one job per Dendrite runtime. A job
admitted by Dendrite can wait in Helios's queue behind local work, but Fabric
does not yet hold a multi-job backlog for one runtime. VM108 has two separate
runtime lanes, so its two models can receive Fabric work independently. VM404's
Helios server has four native slots, but this pilot exposes one Fabric lane for
that model. Increasing Fabric concurrency requires coordinated reservation,
deadline, and cancellation changes; changing a TOML number alone is not
sufficient. Helios may also cold-start a model if it disappears between
Dendrite's hot-instance check and the completion POST. A strict hot-only
admission option would need a Helios API change. The current Helios token is
the host's existing service token, not a credential scoped to metadata reads
and completion submission; a scoped token is a worthwhile Helios follow-up.
