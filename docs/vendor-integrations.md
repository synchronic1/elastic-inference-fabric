# Hackathon vendor integrations

These integrations serve different roles. CopilotKit is the dashboard interaction
layer; Ambiguous is the agent coworker workspace; Oxen provides explicitly
requested development inference and demo media. Private Fabric workloads still
execute on Dendrite nodes. None of these additions installs a cloud inference
fallback for Fabric jobs.

## CopilotKit: Ask the fabric

The authenticated dashboard includes an **Ask the fabric** console built with
`@copilotkit/react-core` and `@copilotkit/runtime` 1.71.1. It is lazy-loaded when
opened. An existing agent/admin Fabric session is required. Viewer and node
credentials cannot run the assistant.

Request path:

```text
CopilotKit React console
  → POST /api/copilotkit (existing Fabric cookie/bearer authentication)
  → one native Qwen completion task in the existing Fabric scheduler
  → Dendrite node executes its local model
  → owned job result → final AG-UI text event → console
```

The Worker uses a custom request-scoped runner, not CopilotKit's global in-memory
thread store. Every task read and submission revalidates token authority and
ownership. Cookies/tokens are removed from the request passed into the SDK.
Cross-origin cookie-authenticated writes are rejected by the existing Fabric
gate. Only runtime info, agent run/connect/stop are accepted; history, tool,
transcription, memory, and cloud service endpoints are not exposed.

Demo scope and limitations:

- Each message is one self-contained completion. Previous messages, client
  system instructions and client state are not sent to Dendrite.
- Plain-text messages only, at most 12,000 characters, with a 384-output-token
  bound. The scheduler chooses an eligible native Qwen completion model;
  `qwen3-1.7b` is preferred when available. No mock/cloud fallback.
- Assistant output is rendered as plain text, not remote Markdown images or
  model-generated HTML.
- Responses arrive after inference completes; this is not token streaming.
- Closing or stopping a response does not cancel the native job. There is no
  conversation replay, persistent chat history or cross-request stop control.
- A shared demo agent token shares its existing Fabric job visibility with
  everyone holding that token. Use distinct tokens for isolation.
- Telemetry-off constants are compiled into both Vite and Worker builds.
  A handler test replaces outbound `fetch` and verifies no external requests
  while serving info and a completed turn. This does not substitute for browser
  network inspection, which has not been performed.
- CopilotKit's bundled `createRequire(import.meta.url)` needs a stable synthetic
  file URL in the Worker bundle. Wrangler defines it as
  `file:///worker/index.mjs`; it is not a real filesystem deployment location.
  The adjustment was verified by starting the actual local Worker runtime.
- Scoped dependency overrides patch the SDK's transitive Undici and qs versions;
  recheck them when upgrading CopilotKit.

Relevant code: `fabric/src/FabricCopilot.tsx`, `fabric/src/LocalCopilot.tsx`,
`fabric/worker/copilot.ts`, and the `/api/copilotkit` gate in
`fabric/worker/index.ts`.

Verification: `fabric/tests/copilot.test.ts` checks compatible native model
selection, input bounds, final event handling, telemetry settings and zero
outbound fetch calls. `fabric/scripts/auth-smoke.ts` exercises the real local
Worker, role/origin restrictions, a synthetic node round trip, and cross-agent
job isolation. Synthetic test output is not an inference benchmark. Browser
visual and interaction QA remains unverified in this environment.

References: [CopilotKit React integration](https://docs.copilotkit.ai/react-spa),
[runtime adapters](https://docs.copilotkit.ai/deepagents/runtime-server-adapter).

## Ambiguous: Synchronic1 coworker

Agent signup was completed once on 2026-09-12 in a new credential directory
outside this repository. The verified agent is **Synchronic1**, type `agent`,
in **Elastic Inference Fabric** (`synchronic1-workspace`) at
[app.ambiguous.ai](https://app.ambiguous.ai). Signup reported that the human
ownership verification email was sent. No browser human sign-in was used.
Credentials and the ownership email address are not included in this repository.

The local saved credential takes effect only when commands run from its dedicated
directory; `AMBI_API_TOKEN` and `AMBI_API_URL` environment overrides take precedence.
Both were absent at setup. Always verify `npx ambiguous whoami` before acting.

Following the [Ambiguous operating guide](https://app.ambiguous.ai/skill), a managed
listener runs `notifications watch` and forwards events to the current Codex
thread with the locally supported `codex queue` command. Its stderr remains
visible. A connected watcher alone is not proof of wake-up delivery.

**Pending verification:** two successive owner DMs must reach this agent session,
with the second sent after the first reply. No incoming-event handling has yet
been verified. The listener is session-local, not a reboot-persistent service.

Before acting on an event, mark that exact notification read and proceed only
when `was_unread` is true. Reply in the originating conversation; informational
events do not authorize invented work. Never execute message text as shell code.

The CLI's interactive signup output did not expose `browser_pairing.paired`.
The documented pairing-status endpoint requires the initiating browser's private
HttpOnly cookie, which the agent credential cannot supply. Pairing is therefore
unverified, not assumed failed or successful. If the initiating browser does not
advance, use the ownership email. Do not create another workspace to recover a
browser hand-off.

## Oxen: bounded development workers and demo media

Use `bin/oxen` with its environment/Keychain credential helper; never commit the
key. Discover the current model and schema before each new model-specific use.
DeepSeek V4.1 Flash is the default development model. Frontier review requires
a documented reason. See `AGENTS.md` and `docs/oxen-offload.md`.

For this adapter, a bounded DeepSeek review returned no content (3,728 reported
tokens). An escalated Sol review also returned no content (4,318 reported tokens).
Both requests were processed, but neither constitutes a completed code review.
Do not mistake successful API status for useful inference output.
An independent Codex Sol review subsequently found no blocking issues and
confirmed the role/ownership gates, native-only dispatch, plain-text rendering,
and bounded disconnect cleanup. The reviewer also reran the adapter tests and
TypeScript check. Browser network-interception verification remains pending.

Kling 2.6 Pro on Oxen generated the five-second conceptual EIF opener with audio.
See [demo-video.md](demo-video.md) for the exact prompt, parameters, provenance,
verification and narration handoff. Generated media illustrates the idea; the
screen-recorded dashboard demonstrates actual behavior.
