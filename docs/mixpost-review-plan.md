# Mixpost — light code review, feature analysis, upstream comparison, and plan

**Date:** 2026-09-20 · **Host:** `vinlandclaw` (192.168.1.167) · **Install:** `/home/rm/MixpostApp`
**Method:** read-only throughout — no writes, no restarts, no state-changing artisan commands.
Every claim below carries the evidence that proves it; unverified items are marked **UNKNOWN**.

## Context

This install serves Carlsson Creative's social scheduling. It is one of several tenants on a shared
box. The ask was a light code review plus a feature analysis that could generate a plan, extended with
(a) what a modern social-media integration stack now requires and (b) a GitHub comparison to see what
needs upstreaming.

**Intended outcome:** publishing works again, the work on the box is backed up, known security defects
are closed or explicitly accepted, and capability work is ranked rather than aspirational.

**Scope note:** the standing rule is that Mixpost's **auth stays untouched**. I read that as the
login/identity layer and treated the OAuth-callback XSS as a security patch (see decisions). Nothing
here proposes changing the account/login model.

---

## 1. What the install actually is

| | |
|---|---|
| App | `/home/rm/MixpostApp` — the only install (`MixpostApp-staging` is an empty placeholder dir) |
| Edition | **Mixpost Lite** — `composer.json` name `inovector/mixpostapp`; **no Pro package, no licence key** |
| Package | `inovector/mixpost` **2.6.0** = newest release; vendored, unmodified (`vendor/` is gitignored) |
| Framework | Laravel **12.69.2**, PHP **8.3.6**, SQLite (`database/database.sqlite`, 758 KB + 4 MB WAL) |
| Cache/queue/session | Redis on 127.0.0.1:6379 |
| Git | branch `main` @ `273adf9`, clean tree, **16 commits**, `origin` = private `synchronic1/mixpost-instance` |
| Web tier | `php artisan serve --host=0.0.0.0 --port=8000` — **no PHP-FPM, no opcache** (`opcache.enable_cli=Off`) |
| Public | `https://mixpost.heurchain.com` via cloudflared → `127.0.0.1:8000`. Verified **302 off-box, v4 and v6** |
| Supervision | 5 systemd **user** units (`serve`, `queue`, `scheduler`, `horizon`, `mcp-sse`), alive only because `Linger=yes` |
| Custom layer | AI drafting (Ollama/OpenAI-compatible), approval gate, interaction polling/auto-reply, MCP server (**30 tools**), 18 custom migrations, ~24 `mixpost_*` tables |

A 502 seen from the box is a hairpinning artifact, not an outage — the box cannot validate its own
public URL (same trap as RUNBOOK item 15).

---

## 2. Code review — findings

### P0 — nothing can publish (three independent causes)

1. **The 267-post backlog is provably unreleasable.** All 267 are both past-due *and*
   `held_for_approval_at IS NOT NULL` with `approved_to_publish = 0`, and
   `mixpost_settings.approval_settings = {auto_publish_enabled: false}` — so
   `AutoPublishPendingPosts` returns at its first guard. Zero future-dated scheduled posts exist.
   Last successful publish **2026-06-06**; newest scheduled post 2026-07-11.
2. **Horizon is a zombie.** `laravel/horizon` **5.46.0** against framework **12.69.2**: every
   `horizon:work` child throws `The "stop-when-empty-for" option does not exist`
   (`WorkCommand.php:173` ← `Horizon/Console/WorkCommand.php:52`) and dies. **13,518 occurrences**,
   ~every 30 s, since the Sep 16 upgrade. Both supervisors have **zero children**; `horizon:status`
   still says "running" because the master survives. `PublishPost` dispatches to
   `publish-post`, whose only configured consumer is that dead supervisor; the fallback
   `queue:work` unit consumes `default` only.
3. **The X integration is dead on two axes.** Polling returns **402 credits depleted**
   (`api.x.com/2/problems/credits-depleted`, still firing), and the connected token **lacks
   `tweet.write`** (2 `Forbidden` publishes, 3 failed replies). Polling/metrics data stops ~2026-06-23.

### P0 — unbacked work

4. **Six commits exist only on the box** — including
   `2026_09_19_000001_add_publish_claim_and_body_fingerprint.php` (the DB-level publish claim) and
   `f0682cb` (R9 race conditions + failure blind spots). The remote `main` sits at `f97f273`, 10
   commits from June.

### P0/P1 — security

5. **Reflected XSS in the OAuth callback — no patch exists anywhere.** Confirmed:
   `GHSA-x4g3-x4c9-rjf8` / **CVE-2026-57958**, CVSS **6.1 medium**, published 2026-06-29,
   **"NO PATCH RELEASED"**, summary says *"through 2.6.0"* = our version. Chain verified in the box's
   vendored tree end-to-end: `CallbackSocialProviderController.php:22-23` reflects the `error` param →
   `resources/js/Components/Util/Notifications.vue:118` renders it with `v-html`. The upstream issue
   **#204 is open** and notes the reporter got no response in May and June. One crafted link plus
   operator interaction executes script in a logged-in session. **This is the one finding with no
   upstream exit** — mitigate locally or accept it in writing.
6. **Path traversal in SystemLogs — issue #194, open since 2026-02-24, unfixed.** Verified on the box:
   `src/Support/SystemLogs.php:64-67` returns `$this->basePathForLogs().$name` with no sanitization.
   An authenticated user can download or truncate arbitrary server-readable files — the reporter's own
   example is **`.env` with `APP_KEY`**.
7. **Secrets hygiene.** The cloudflared **tunnel token sits in a world-readable** systemd unit
   (`systemctl cat cloudflared`); `.env` is mode **664**; `APP_ENV=local` with a debug-level log behind
   a public hostname. *(One sweep agent reported it printed `APP_KEY` before its redaction filter
   applied, so treat that value as exposed and consider rotation — see decisions.)*

### P1 — fragility

8. **`php artisan serve` is the production web tier.** PHP's built-in server handles one request at a
   time; with `enable_cli=Off` every request recompiles the framework. Any AI/media/dashboard action
   blocks the whole app. It is also bound `0.0.0.0`, so **:8000 is LAN-reachable, bypassing
   Cloudflare** — note `:8001` is firewalled but `:8000` is not.
9. **`retry_after` (660 s) is shorter than the publish job timeout (3600 s).** Invisible today only
   because no consumer runs; once Horizon works it is a duplicate-publish window.
10. **Command-signature collision.** Our `App\Console\Commands\RunScheduledPosts` and the vendor's
    `Inovector\Mixpost\Commands\RunScheduledPosts` share `mixpost:run-scheduled-posts`; last
    registration wins. Ours (with the approval/claim guard) wins today — verified live — but any
    dependency change can silently revert the deployment's core differentiator. `Kernel.php` also
    hand-mirrors `Schedule::register()`.
11. **SQLite under a concurrent web+queue+scheduler app.** Historical `no such table: job_batches` —
    the very table `Bus::batch` (which `PublishPost` uses) depends on — plus 21 `ON CONFLICT`
    errors. A plausible contributor to posts sitting in SCHEDULED.
12. **Log hygiene.** `laravel.log` is **55.8 MB**, no rotation, ~3.6–3.8k lines/day, dominated by the
    Horizon trace. Real errors are buried in it.
13. **No backup of the SQLite DB** anywhere.
14. **Inert config.** `.env.example` documents `ANTHROPIC_API_KEY`, `MIXPOST_AI_CLAUDE_MODEL`,
    `MIXPOST_HEALTH_WEBHOOK_URL`; none are in the live `.env`, so the Claude provider path and
    health-webhook alerting are dead. The live model also **disagrees across layers** — DB says
    `kimi-k2.6:cloud`, `.env` says `deepseek-v4-flash:cloud`.
15. **Dependency drift.** `phpseclib` SSRF (CVE-2026-55599), `symfony/cache` SQLi (CVE-2026-45073);
    framework a major behind (13.x available). Mixpost itself is current, so drift is entirely ours.
16. **UNKNOWN:** `redis-cli` answered with no auth while `.env` sets `REDIS_PASSWORD` — the server may
    not enforce the password the app sends. Confirm rather than assume.

### P2

17. `public/storage` symlink is **missing**, so public-disk media is not HTTP-served (media library has
    0 rows, so nothing is currently lost).
18. **99 of 114 interactions have `platform = NULL`** — filtering/auto-reply misbehaves on legacy rows.

---

## 3. Feature analysis — built vs actually used

| | Count | Read |
|---|---|---|
| Users / connected accounts | **1 / 1** (X `@PeterJ_Medina`) | single-operator, X-only |
| Posts | 308 = 3 draft / **267 scheduled** / 38 published / 0 failed | stopped June |
| Media items / tags / Sanctum tokens | **0 / 0 / 0** | never used |
| Interactions | 114, **all `draft_pending`** | ingested, zero closed loop |
| Agent suggestions | 47, all auto-`followed`, no triage | agent → queue works; feedback loop absent |
| DM inbox / AI drafts / direct-publish accounts | **0 / 0 / 0** | built, never configured |

**So the honest summary is: a capable single-operator X tool that stopped working in June and has been
idle since.** The custom layer is real and substantial — an approval gate, an AI drafting path, an
interaction poller, and an MCP server exposing **30 tools that are strictly more than the UI**
(batch scheduling, thread publishing, engagement actions, bulk dismiss). Almost none of it has run with
data since June.

**Capabilities that don't exist at all** (not built here, not in Lite): templates, content library,
RSS automation, saved hashtags, webhooks, team roles, report builder, **and any REST API** —
`vendor/inovector/mixpost/routes/` has only `web.php`, zero Sanctum routes, zero tokens. Any
integration must drive `artisan`/MCP, not HTTP.

**MCP bridge:** loopback-firewalled at :8001 (`iptables -I INPUT 1 … ! -s 127.0.0.1 -j REJECT`,
verified active), i.e. **not internet-reachable** — but unauthenticated to any local process. This
Mac registers it as `http://192.168.1.167:8001/mcp`, a LAN URL to a loopback-only port on a machine
with no LAN route: **unreachable as configured**; a `localhost:8001` SSH tunnel is the working shape.

---

## 4. Upstream comparison (GitHub) — the surprising answer

**There is nothing to adopt from the skeleton.** `inovector/MixpostApp` has been frozen since
**v2.1.0, 2025-05-28**. Compared by blob SHA: upstream 85 blobs, local 161 → **71 identical,
14 locally modified, 76 new locally, 0 upstream-only paths**. No missing config keys, no missing or
renamed env vars, no missing migrations, no missing commands. The vendored package is at the newest
release (main is exactly one commit ahead of 2.6.0 — a CHANGELOG edit).

So the real "upstream" for *features* is the **paid Pro line** (v6.3.1 / Enterprise v7.2.0), which
cannot arrive via `composer update`. Two consequences worth stating plainly: Pro ships Engagement and
an MCP server **natively**, so buying it turns our headline custom layers into
duplicate-and-conflicting code rather than additive code; and Pro forces a chained **Laravel 13 +
Inertia v3** move.

**What needs upstreaming is therefore our own work:**

- **Push the six box-only commits** to the private origin. `05dcf72` ("wip(ai-compose)") should be
  squashed or reworded first.
- **Contribute upstream** (all verified open today): the **XSS fix** (#204 — nothing exists, we'd be
  first), **#194** path traversal, **#207** `mixpostAssets()` sub-path (the fork already solved the
  https-scheme half at HEAD — same lineage), **#205** publish-race/idempotency design, and the
  `mixpost_metrics` SQLite unique-index repair.
- **Contribute findings, not layers:** the MCP/approval/AI feature layers are ours; upstream won't
  take them.

**Do not adopt:** the `develop` 432-file reformat (#187), the open community PRs (#202 Pubky draft,
#179 Pixelfed conflicts, #209 port locally instead), or Laravel 13 today.

---

## 5. What a modern social integration now requires

Four groups. The first is "stay working"; the rest are choices.

1. **Platform-API / stay-working.** X pay-as-you-go is *already supported* by 2.6.0 — credits are the
   live blocker, not code. The custom LinkedIn path still uses the legacy `/v2/ugcPosts` endpoint and
   will break on LinkedIn's schedule. Mastodon's connect flow needs the missing-slash fix (#209, port
   locally). The large gap is **platform breadth**: no Meta/Instagram, Threads, TikTok, YouTube,
   Pinterest, Bluesky in Lite. Several of those are **audit-gated and effectively closed** to a
   self-hosted app without partner status — that is a commercial fact, not an engineering one, and it
   should be stated to clients before promising delivery on those networks.
2. **Competitive feature gaps** (vs Buffer/Later/Publer/Metricool/SocialBee/Postiz): client-facing
   **review links without a seat** (highest value — it slots straight into the existing approval gate),
   UTM tagging + link shortening, evergreen recycling, RSS automation, bulk CSV import, alt text,
   best-time-to-post, templates and hashtag groups.
3. **Adjacent-stack integration.** Authenticate the MCP bridge (today: loopback-only, unauthenticated
   locally). **Plane brief-to-post** — issue → draft → approval queue → write the post URL back; must
   route through the approval gate, and must drive artisan/MCP because there is no REST API.
   Email-driven intake reusing the existing `mixpost:ingest-drafts`. **Dropbox asset flow** — Dropbox
   already runs on this box and `mixpost_media` is empty; wiring media in is the single largest
   capability gap, since every MCP compose/schedule tool is text-only today.
4. **EU compliance, already in force.** **AI Act Article 50** disclosure labelling — apply it at
   *publish* time so it cannot be forgotten at compose time. GDPR / AI-inference residency (a local
   Ollama endpoint already exists, at a quality/cost trade-off). Branded client reporting — but note
   **competitor benchmarking is absent from Mixpost at every edition**, so don't promise it; scope
   reports to own-account metrics.

---

## 6. The plan

**Phase 0 — protect what exists (minutes, no box changes).**
Push the six commits to `synchronic1/mixpost-instance` (or snapshot the tree if credentials aren't
handy). Nothing downstream is safe until this is done.

**Phase 1 — stop the bleeding.**
Patch the reflected XSS locally (encode/sanitize the flashed `error` before it reaches the flash bag —
server-side, so it doesn't depend on rebuilding the Vue bundle; vendor overrides must be carried as
**tracked patch files**, since `vendor/` is gitignored and a `composer update` erases them silently).
Patch #194 (reject traversal and assert the resolved path stays under the log dir). `chmod 600 .env`,
move the tunnel token to a root-only `--token-file`, and settle the `APP_KEY` question.

**Phase 2 — make publishing work again.**
Bump `laravel/horizon` 5.46.0 → **5.49.0** (S, no migration, no config key, no asset rebuild). Then
**verify workers actually survive** (`ps --ppid <supervisor>` non-empty — `horizon:status` lies).
Fix `retry_after` vs the 3600 s publish timeout. Rename our command to kill the signature collision
and add a guard test. Reconnect X with write scope and resolve the credits. Then decide the backlog
policy (below) — only after the pipeline is proven with one post end-to-end.

**Phase 3 — durability.**
Real web server (nginx + php-fpm + opcache, bound to loopback; keep Cloudflare as the only public
door), the SQLite-vs-MySQL decision *before* any upgrade lands, log rotation + a sane level, a DB
backup, and wire the health webhook (add the three missing `.env` keys) so a stalled publisher alerts
instead of going quiet.

**Phase 4 — capability roadmap (choose, don't do all).**
Authenticated MCP + a working tunnel from the Mac → media/Dropbox library → Plane brief-to-post →
client review links → AI-Act labelling → the Pro buy-vs-keep decision.

### Verification per phase

- **Phase 1 XSS:** hit the callback with a crafted `error` value off-box and confirm the flash renders
  as **text**, not script (and that `Notifications.vue` is no longer the only guard).
- **Phase 1 #194:** request a log download with `../` in `filename` and confirm rejection, not a file.
- **Phase 2 Horizon:** `ps --ppid <supervisor>` non-empty; `artisan horizon:status` *and* a real
  publish through the gate; then confirm `publish-post` had a consumer by watching one land.
- **Phase 2 backlog:** publish exactly one post first, then a small batch, before any bulk policy.
- **Phase 3 web server:** concurrent request test that previously serialized; confirm `:8000` is no
  longer LAN-reachable and `opcache` is active on the FPM SAPI.
- **Always off-box** for public-URL checks (hairpin trap).

---

## 7. Decisions needed from you

1. **The 267-post backlog** — drain (re-schedule through `PostState::nextSlot` so they don't all fire
   at once), archive, or leave held? All three are defensible; bulk-releasing as-is would dump 10 weeks
   of content at once.
2. **X account status** — is the credits/`tweet.write` situation going to be fixed, or is X being
   retired? Phase 2's value depends on the answer, and the poller is now a recurring cost centre.
3. **Pro: buy or stay Lite?** Buying means retiring or re-homing the custom AI/approval/MCP layers
   rather than running both, plus a Laravel 13 + Inertia v3 move.
4. **`APP_KEY`** — rotating invalidates Mixpost's encrypted provider tokens, so it means reconnecting
   accounts. Rotate now as hygiene, or only if you consider the value burned?
5. **The auth rule** — I've treated "Mixpost auth stays untouched" as the login/identity layer and the
   callback XSS as a patch in scope. Say if you want the callback left alone too.
6. **Sequencing** — stop-the-bleeding only, or run straight into the capability roadmap?

## 8. Not verified / open

- The Redis password mismatch (app sends one; server appeared not to require it).
- Whether June's stop was credits, scope loss, or the gate — the ordering isn't recoverable from data.
- Who pushed the June commits (no remote-tracking refs exist in that clone).
- Pro licensing/edition claims rest on vendor marketing pages; some package names were inferred rather
  than read from licensing docs.
- No requirements baseline exists for "the agency" the roadmap is written for — client count, network
  mix, and volume would sharpen Phase 4 considerably.
- The market-comparison half of the capability sweep carries weaker citations than the security half;
  treat competitor feature claims as directional.

---

## 9. Implementation status — added 2026-09-20

Executed after the review above. Phase 0 and the Phase 1/2 items that are code-fixable are **done**;
everything downstream of a human decision is not.

**Backed up.** The box's six commits now exist on `synchronic1/mixpost-instance` (`github/main` =
`064eaaf`), pushed from the Mac clone — never from the box, which has no GitHub credentials. The box
tree is clean at that SHA, so **deployed state == committed state**. The Mac clone's `gitea` remote is
unreachable (no LAN route), so GitHub is the only live remote.

| Reviewed finding | Status | Commit |
|---|---|---|
| #2 Horizon zombie (`stop-when-empty-for`) | **fixed** — 5.49.0, lock-level only | `910083c` |
| #9 `retry_after` 660 s < 3600 s timeout | **fixed** — 3700 s | `e750ffc` |
| #5 XSS (CVE-2026-57958, no upstream patch) | **fixed** app-side — binding over the vendor class | `55c447a` |
| #6 path traversal (#194) | **fixed** — the two routes are shadowed | `a58f8f4` |
| #10 command-signature collision | **fixed** — renamed, guard test added | `63c95db` |
| #7 secrets hygiene / #12 log hygiene | **fixed** — both chmod 600; `single`→`daily` 14 d | `e750ffc` |
| #1 the 267-post backlog | **untouched, by design** — still fully held | — |
| #3 X integration (402 + no `tweet.write`) | **not fixed** — not fixable in code | — |
| #4 unbacked work | **fixed** — see above | — |
| #8, #11, #13, #14, #15, #16, #17, #18 | **not attempted** (Phase 3 / decisions) | — |

**The honest headline: publishing is still not restored.** Two of the three dead causes are fixed, but
the third is a platform fact — the X API returns **402 "credits depleted"** and the connected token
lacks `tweet.write`. Repairing Horizon makes dispatch *possible*; it does not make X *accept*. The
queue consumer exists and is verified attaching to `publish-post`, but **no publish has been observed
landing** — that remains the missing end-to-end proof, and it needs one real post through the gate.

Two caveats the fixes carry, both documented in the box CHANGELOG: the log rotation is only effective
for processes booted after the change (the 2026-09-16 workers keep writing the old file until
restarted), and the route shadow is **order-dependent** — it must be re-verified after any framework
upgrade or `route:cache`.

Still owed from §7: the backlog policy, the X decision, Pro buy-vs-keep, and `APP_KEY`. The backlog
policy now has a hard dependency worth restating — **the entire 267-post backlog is X-only, so it is
downstream of the X decision.**
