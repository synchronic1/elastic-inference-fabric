# Model gateway instructions

When a task benefits from external model inference, use `bin/oxen` from the
repository root. Start with `bin/oxen models --search TERM` and inspect
`bin/oxen schema MODEL_ID` before choosing a model or passing model-specific
parameters.

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
