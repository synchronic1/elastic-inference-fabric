# Model gateway instructions

When a task benefits from external model inference, use `bin/oxen` from the
repository root. Start with `bin/oxen models --search TERM` and inspect
`bin/oxen schema MODEL_ID` before choosing a model or passing model-specific
parameters.

For nontrivial development work, prefer offloading a useful, bounded inference
subtask to Oxen rather than doing all reasoning in the main Codex thread.
**DeepSeek V4.1 Flash (`deepseek-v4-1-flash`) is the default first choice for
Oxen development inference**, including code drafting, extraction, planning,
routine debugging, and first-pass analysis. This supersedes the earlier
frontier-first preference. The model ID and inference availability were checked
against Oxen's catalog on 2026-09-12.

Escalate to OpenAI or Anthropic frontier models **only when the problem needs
escalation or a justified independent review**. State the reason before the
call: failed acceptance criteria after at most one targeted retry, a clear
capability gap, unresolved consequential diagnosis, or security/design review.
Do not automatically send every DeepSeek result to a frontier model. Select the
appropriate reviewer, not a compulsory chain: Sol (`gpt-5-6-sol`) for scoped
code/security review, Astra (`gpt-6-astra`) for difficult cross-component
reasoning, or Fable (`claude-fable-5-1`; the earlier `claude-fable-5` is also available) for
independent design/long-form review. Pass a compact task packet, prior findings,
and failing checks; after resolution return ordinary work to DeepSeek.

Recheck model availability/schema before use. These are Oxen provider catalog
identifiers, not native Codex subagents; this policy does not change the main
Codex model or install an automatic production fallback.
Send only the task, acceptance criteria, and relevant source/excerpts;
never send the full conversation, credentials, `.dev.vars`, environment dumps,
or production prompts/results. Set an explicit output bound, inspect returned
usage and finish reason, and verify findings locally before implementing them.
Keep integration, deployment decisions, and final verification in the main
thread. Preserve the distinction between development review on Oxen and private
fabric inference on Dendrite nodes.

The gateway checks `OXEN_API_KEY`, then macOS Keychain service `oxen.ai/hackathon`.
Never put the key in prompts, logs, source,
commits, or files, and never call Keychain directly. Use `--dry-run` when
checking a request shape. Prefer the OpenAI-compatible `chat` command for text
work; use `queue` and `status` for long-running image/video tasks.

# Dendrite node runtime

Read `docs/node-runtime.md` for the implemented scope and control-plane handoff.
Run `uv sync --locked`, `uv run pytest -q`, and `uv run ruff check dendrite tests`.
The machine-local real-runtime configuration is `.dendrite/mac.toml`; portable
examples are in `configs/`. Native builds and model weights are ignored artifacts.

Keep Dendrite execution local. Oxen is an explicitly requested development-worker
tool, not an automatic fallback for private node requests. Treat prefix-cache
candidates separately from measured reuse, and never claim cache portability
without implementing and verifying a compatible runtime transfer protocol.
