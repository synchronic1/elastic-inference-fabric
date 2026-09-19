# Oxen development inference

The project's current routing preference is recorded in `AGENTS.md`: start
bounded Oxen development tasks with **DeepSeek V4.1 Flash**
(`deepseek-v4-1-flash`). Use Sol, Astra, or Fable only for a documented escalation
or justified independent review, then return ordinary work to DeepSeek. Do not
automatically frontier-review every response. Keep integration and verification
local. This does not route private Dendrite inference to cloud models.

## DeepSeek-first verification — 2026-09-12

Verified `deepseek-v4-1-flash` in the live catalog and inspected its model schema.
A bounded routing-policy request completed with `finish_reason: stop` and valid
JSON, assigning ordinary drafting/extraction to DeepSeek and frontier routes
only to explicit escalation/review cases. No frontier model was called during
this check. Oxen reported 136 input + 549 output = **685 tokens**, and
USD 0.000909480. These are provider-reported usage/cost fields, not an invoice.
The successful request used the model's default reasoning settings; no
OpenAI-specific reasoning parameter was copied into the DeepSeek request.

## Landing-page diagram review — 2026-09-12

DeepSeek V4.1 Flash reviewed the bounded demo/live-state design and proposed
render/privacy/anchor regression checks. Those checks informed the public
architecture-only state and the tests for missing live data and stale-state
labels. No frontier escalation was needed. Oxen reported 243 input + 774 output
= **1,017 tokens**, `finish_reason: stop`, and USD 0.001302210. The model received
only the component behavior and proposed change, not private node inventory.

## Authentication discoverability review — 2026-09-12

DeepSeek V4.1 Flash checked the proposed immediate sign-in form, stable account
anchors, public provisioning instructions, and retained admin-only issuance.
Its checks informed independent login-error messaging and initial-render
regressions. Oxen reported 244 input + 709 output = **953 tokens**,
`finish_reason: stop`, and USD 0.001201200. No frontier escalation was needed;
no credentials or private inventory were sent to the model.

## Shared demo viewer review — 2026-09-12

DeepSeek V4.1 Flash reviewed a compact, credential-free viewer-role design.
The first call returned null content at its 1,600-output-token cap despite
`finish_reason: stop`: 294 input + 1,600 output = 1,894 tokens, USD 0.002610660.
One targeted retry with a 3,200-output-token cap returned four concrete checks:
exact route/method allowlists, cookie and bearer parity, atomic schema migration,
and disclosure scope. That retry used the CLI's text mode, which omitted raw
usage/finish metadata; no usage estimate is substituted here. Future review
calls should use `bin/oxen --raw chat` to retain both the answer and metadata.
Local tests verified the route, session, migration-preservation, and revocation
boundaries; Cloudflare's storage documentation was checked for transaction
semantics. No frontier escalation or production inference offload was used.

## Logo asset ideation — 2026-09-12

A bounded Terra asset worker developed a monochrome, geometric connected-tile
SVG outside the checkout; the main thread integrated it and the theme UI.
The asset worker attempted one DeepSeek V4.1 Flash design call through Oxen
with raw response capture: 2,937 total tokens, USD 0.00442143,
`finish_reason: stop`, but empty visible content. No usable logo suggestion is
attributed to that call. The worker completed the simple SVG design locally,
validated XML, and did not escalate to a frontier model or edit the site.

## Non-expiring demo access review — 2026-09-12

DeepSeek V4.1 Flash reviewed a compact admin-only token-update design using raw
response capture: 320 input + 3,421 output = 3,741 tokens, USD 0.005461560,
`finish_reason: stop`. No credentials or production data were included. Its
checks informed explicit null/default expiry tests, cookie-Origin rejection,
metadata-only update responses, and both directions of session role changes.
The proposed target-row race was checked against implementation: the active
target is read after the async request body, immediately before synchronous
SQL, with no intervening await. Node/admin targets and expired/revoked tokens
cannot be updated. New non-expiring issuance remains an explicit administrator
option; this work changed only the operator-approved shared demo identity live.
No frontier escalation was needed. The main thread separately checked the Linux
runbook against repository configuration and official model/runtime sources.

## Earlier frontier review pass — 2026-09-12


Historical pass below preceded the DeepSeek-first preference.

Both calls used `bin/oxen`, after live catalog/schema checks, with explicit
output limits and medium reasoning effort. No credentials, environment dumps,
production inference prompts/results, or full conversation history were sent.
The models received selected project code or the DNS evidence packet, not
filesystem/network access. Both returned `finish_reason: stop` with visible
answers.

| Oxen model | Assignment | Input tokens | Output tokens | Total |
| --- | --- | ---: | ---: | ---: |
| `gpt-5-6-sol` | Token/MCP authorization and correctness review | 8,550 | 2,058 | 10,608 |
| `gpt-6-astra` | Independent DNS evidence assessment | 1,159 | 635 | 1,794 |
| Total | | 9,709 | 2,693 | 12,402 |

These are Oxen-reported API usage counts, not Codex usage estimates. The API
reported USD 0.104490 and USD 0.056342 respectively (USD 0.160832 combined), not
an independently verified invoice charge.

### Findings and local verification

- **Sol:** No confirmed authorization regression in the supplied code. Its
  scope did not include full WebSocket frame/result handling. It flagged that
  an unhandled `decodeURIComponent` error in the task route could become HTTP
  500 if malformed encoding reaches that code. A non-mutating check of the
  deployed endpoint returned HTTP 400 already; this is not a reproduced
  production defect. Retain it as a defensive handler/test improvement, not
  evidence of an authorization bypass. No production code was changed based
  on the review.
- **Astra:** Same-network port-53 probes do not establish independent vantage
  points or authenticate an authoritative response. The DNS evidence does not
  prove a Cloudflare defect; cached recursive answers, interception, and
  regional serving differences remain possible. Updated `docs/dns-repair.md`
  with this distinction and discriminating next checks. No DNS mutation or
  networking change was performed.

Fable was found in the live catalog as `claude-fable-5` and
`claude-fable-5-1`, but was not invoked in this pass. Check its schema before a
future design/review assignment; do not claim unused models ran.
