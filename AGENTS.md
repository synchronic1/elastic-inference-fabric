# Model gateway instructions

When a task benefits from external model inference, use `bin/oxen` from the
repository root. Start with `bin/oxen models --search TERM` and inspect
`bin/oxen schema MODEL_ID` before choosing a model or passing model-specific
parameters.

The gateway reads the key from macOS Keychain service `oxen.ai/hackathon`, with
`OXEN_API_KEY` as a fallback. Never put the key in prompts, logs, source,
commits, or files, and never call Keychain directly. Use `--dry-run` when
checking a request shape. Prefer the OpenAI-compatible `chat` command for text
work; use `queue` and `status` for long-running image/video tasks.
