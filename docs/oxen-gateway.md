# Oxen.ai development inference gateway

`bin/oxen` is a tiny, dependency-free command-line gateway to Oxen's Inference
API. It gives Codex and its sub-agents one consistent interface to discover
models and make text, image, or asynchronous media requests. It is deliberately
not an HTTP proxy: Oxen's chat endpoint is already OpenAI-compatible, so the
direct path is the fastest and least failure-prone option.

## One-time activation

1. Create an API key in [Oxen account settings](https://oxen.ai/account/settings).
2. Add it in **Keychain Access** as a Generic Password with service name
   `oxen.ai/hackathon`; use your local macOS username for the Account field.
   This lets all same-user Codex sub-agents use the gateway without a secret in
   the project or in a command argument. Alternatively, set `OXEN_API_KEY` in
   the environment that launches Codex.
3. Verify the connection and choose the exact current model rather than relying
   on a hard-coded name:

   ```sh
   bin/oxen models --search flash
   bin/oxen schema claude-sonnet-4-6
   ```

The CLI refuses to run without a Keychain or environment credential, never
persists the key in this project, and supports `--dry-run` to inspect a request
without sending it.

## Agent-ready commands

```sh
# Fast research, extraction, critique, or planning
bin/oxen chat --model claude-sonnet-4-6 --prompt 'Return three crisp product risks.' --max-tokens 250

# Ask for machine-readable output (where the selected model supports it)
bin/oxen chat --model claude-sonnet-4-6 --prompt 'Return a JSON object with title and tagline.' --json-object

# Make a visual asset synchronously (usually 5–30 seconds)
bin/oxen image --model black-forest-labs-flux-2-klein-4b --prompt 'A friendly autonomous delivery robot, 16:9' --aspect-ratio 16:9

# Queue long-running media and poll with the returned generation ID
bin/oxen queue --model kling-video-v2-6-pro-text-to-video --prompt 'A lantern floating above Venice at dusk' --extra '{"duration": 5}'
bin/oxen status GENERATION_ID
```

For model-specific options, inspect `bin/oxen schema MODEL_ID` first and pass
valid fields through `--extra` as a JSON object. Keep prompts and outputs free
of secrets or data you are not authorized to send to Oxen.

## Verification

```sh
python3 -m unittest discover -s tests -v
bin/oxen --dry-run chat --model claude-sonnet-4-6 --prompt 'ping'
```

Sources: [Inference overview](https://docs.oxen.ai/inference-api/overview),
[chat quick start](https://docs.oxen.ai/inference-api/quickstart/chat), and
[model API reference](https://docs.oxen.ai/inference-api/reference/models/overview).
