# Plane handoff — self-hosted Plane at plane.heurchain.com

Briefing for an agent (or person) picking this up cold. Everything below was read
off the running box; **last verified 2026-09-18/19**, with corrections folded in
from a 2026-09-22 verification pass (see `docs/plane-crm-plan.md` §9) — the LAN IP
in `vinlandclaw-access.md` and the `plane-source` WIP status in §5/§8 below. The box itself carries the
same material as `/home/rm/plane-selfhost/RUNBOOK.md` — that copy is authoritative
for anything that changes on the box, this one is authoritative for orientation.

---

## 1. The one-paragraph version

Plane **v1.3.1** runs self-hosted on a shared KVM guest in Sweden
(`ssh vinlandclaw`, LAN `192.168.1.167`) for the Carlsson Creative agency. It is
**not a fork** — it is the stock `makeplane/plane-*:v1.3.1` images plus a small
overlay of custom Python **bind-mounted in at runtime**. There is no image build
anywhere. Backend overlays live in `/home/rm/plane-selfhost`; frontend changes live
in a *separate* checkout, `/home/rm/plane-source`, and are applied by a full
`pnpm build` copied into the nginx container. Two repos, one deployment. Both are
mirrored to the LAN Gitea since 2026-09-19 (see §9 item 5), but the box cannot push there
itself — mirrors update only when someone re-syncs from the Mac.

## 2. Access

| | |
|---|---|
| SSH | `ssh vinlandclaw` — Cloudflare tunnel `plane-heurchain` (`d2d3ec82-64f7-4263-a8fe-b0a221fcd158`), not a LAN route. `scp`/`rsync`/`sftp` work over the same path. |
| User | `rm` — in the `docker` group, `NOPASSWD` sudo |
| Public URL | <https://plane.heurchain.com> (tunnel also carries `ssh.heurchain.com`, `mixpost.heurchain.com`) |
| LAN | `192.168.1.167`; the origin proxy also listens on host `:443` and `:8090`→80 |
| Access doc | `AiTinkerersVenice/docs/vinlandclaw-access.md` |

**Read this before blaming a 502 on the network.** A 502 on `/api/*` (also
`/auth/*`, `/static/*`) — while `/`, `/god-mode/*` and `/uploads/*` still answer —
is **Caddy unable to reach the `api` container**, not the tunnel and not the LAN.
It appears whenever `api`, `worker` or `beat-worker` is restarting:

```
"msg":"dial tcp 172.18.0.4:8000: connect: connection refused"
"uri":"/api/instances/"  "status":502  "err_trace":"reverseproxy.statusError"
```

Read it off directly — this is the fastest diagnosis on this box:

```bash
docker logs plane-app-proxy-1 --since 15m 2>&1 | grep 'http.log.error' | tail
```

The failure is **path-specific only because those three prefixes are the ones routed
to `api:8000`** — the paths routed to `web`, `admin` and `minio` keep serving through
the same outage, and the origin answers 200 throughout, which makes it look like
something above the tunnel. It isn't. Wait for the containers to settle
(`~/plane-deploy.sh verify`) and retry; if it persists with `api` up, *then* debug.

SSH hiccups on `ssh vinlandclaw` are a separate matter and do trace to the tunnel/LAN.

## 3. Topology

Cloudflare edge → tunnel → `cloudflared.service` on the box → `localhost:8090` →
`plane-app-proxy-1` (Caddy) → the app containers. Caddy routes:

```
/                → web:3000          /god-mode/*  → admin:3000
/api/*, /auth/*  → api:8000          /spaces/*    → space:3000
/static/*        → api:8000          /live/*      → live:3000 (WS)
/uploads/*       → plane-minio:9000  (BUCKET_NAME=uploads; object path-style)
```

12 containers in compose project **`plane-app`** (dir
`/home/rm/plane-selfhost/plane-app`): `proxy` (Caddy — the only one published to the
host), `web`, `space`, `admin`, `live`, `api` (Django+gunicorn), `worker`,
`beat-worker` (Celery), `plane-db` (postgres 15.7), `plane-redis` (valkey),
`plane-mq` (rabbitmq), `plane-minio`, plus an exited `migrator`.

Footprint is light: worker ~711 MiB, everything else <250 MiB, **~2.2 GiB of 19 GiB**.
The old "~12 GB, in-container `manage.py` will OOM-kill" note is **obsolete**.

Only workspace: **CC** (slug `cc`), owner `peter@carlssoncreative.com`.

```bash
# DB (credential is container-local; nothing is published)
docker exec -e PGPASSWORD=plane plane-app-plane-db-1 psql -U plane -d plane
```

**The box is shared.** Other tenants you will trip over: SearXNG (compose, :8080),
**Ollama (:11434 — this is Plane's LLM backend)**, Mixpost (php8.3 built-in server
:8000 + MCP via supergateway :8001), OpenClaw gateway (:18789), `~/.browser-agent`
(:8771), Dropbox (:17500), Apache2 (:80), postfix (:25), cloudflared.
`curl` is **not** installed in the api container — run curl on the host.

## 4. The overlay model — read this before changing any code

`plane-app/docker-compose.override.yaml` defines a YAML anchor `&api_common` that
bind-mounts overlay paths **into `api`, `worker` and `beat-worker` at
`/code/plane/...`, read-only**. Editing an overlay file on the host changes it inside
the container instantly; gunicorn and Celery do **not** auto-reload, so a container
**restart** is what applies the change.

**Four classes of change, four different procedures:**

| Class | Examples | How it applies |
|---|---|---|
| Mounted backend overlay | all of `overlays/plane/**` (incl. `settings/storage.py` since 2026-09-19) | already live via bind mount; **restart** the container |
| Frontend (web/admin) | `~/plane-source/apps/{web,admin}` | `pnpm build` + `docker cp` into nginx; no mounts |
| Container config | `overlays/web/nginx.conf`, `overlays/proxy/Caddyfile` | mount changed → `docker compose up -d <svc>` (recreate) |

⚠️ **`docker cp` into a mounted path always fails** with `Read-only file system`.
The *old* deploy script ignored those errors with `|| true`, so its api copy loop was
a silent no-op; the restart was doing the real work all along. `plane-deploy.sh`
now distinguishes the two cases and warns loudly about the unmounted one.

⚠️ **Mount mapping gotcha** — source and destination basenames can differ:

```
./overlays/plane/app/services_package  →  /code/plane/app/services     # NOT "services_package"
./overlays/plane/email_feed            →  /code/plane/email_feed
```

`plane-deploy.sh` parses the override to build this mapping. Do not hand-roll it.

**Third-party Python libs.** The stock image lacks e.g. a PDF library and there is no image
build, so pure-Python packages live in the gitignored host dir `overlays/pylibs/`, bind-mounted
at `/opt/pylibs` with `PYTHONPATH=/opt/pylibs` on the `api_common` anchor (currently `pypdf`).
`overlays/pylibs.requirements.txt` says how to rebuild it; adding a mount/env needs a compose
**recreate**, not a restart. Details in the box RUNBOOK.

Also: `web`'s nginx reads **`/etc/nginx/nginx.conf`** (server on :3000). The
vestigial `/etc/nginx/conf.d/default.conf` on :80 is not loaded — editing it does nothing.

⚠️ **`docker compose up -d` needs `--env-file plane.env`** (`cd ~/plane-selfhost/plane-app &&
docker compose --env-file plane.env up -d ...`). Without it, `${LISTEN_HTTP_PORT}`
interpolates to the stock default `80` and the proxy fails to start — Apache owns
host :80. Verified the hard way 2026-09-19.

## 5. Deploying

`~/plane-deploy.sh` (a symlink to the repo copy at
`/home/rm/plane-selfhost/plane-deploy.sh`; Mac mirror:
`AiTinkerersVenice/scripts/plane-deploy.sh`).

```bash
~/plane-deploy.sh web            # build + deploy the SPA   (default)
~/plane-deploy.sh admin          # build + deploy god-mode
~/plane-deploy.sh api            # apply backend overlays + restart api/worker/beat
~/plane-deploy.sh all            # all three
~/plane-deploy.sh check          # overlay drift: host vs container, mount coverage
~/plane-deploy.sh verify         # health-check the running stack
~/plane-deploy.sh rollback-web   # restore the newest pre-build bundle backup
```

From a Mac: `ssh vinlandclaw '~/plane-deploy.sh api'`.

Notes that will save you time:

- **Frontend builds from `~/plane-source`**. Backend overlays are in `plane-selfhost`;
  frontend changes are in `plane-source`. Whatever is in that working tree gets built —
  the script prints a warning listing uncommitted files, so treat that warning as the
  live source of truth rather than a commit hash noted here. (As of 2026-09-22 the
  tree was clean: the `place-in-store-modal.tsx` WIP noted in §8 landed in `ea277fabb`.
  That can drift again — re-check with `git status` before deploying.)
- The web deploy backs the previous bundle up to `~/overlay-backups/web-build-*.tgz`
  **before** rebuilding, then prunes stale hashed chunks. The container is **BusyBox**
  — POSIX `sh` only, no `find -printf`.
- After any frontend deploy: `/assets/*` is served
  `public, max-age=31536000, immutable`, so a returning tab can keep running an
  **old** bundle. Verify by grepping the container for a string unique to your change,
  and load with a cache-buster (`?cb=$(date +%s)`). The SPA *shell* is `no-store`
  (an overlay nginx fix), so only already-loaded bundles can go stale.
- Adding a new overlay file requires adding it **and** a mount line in
  `docker-compose.override.yaml`, then `docker compose up -d api worker beat-worker`.

## 6. Configuration and secrets

**Boundary:** `plane-app/plane.env` holds every secret (DB, RabbitMQ, MinIO,
`SECRET_KEY`, bot keys, IMAP creds) and is **gitignored — never commit it, never
print it**. Non-secret deployment values belong in `docker-compose.override.yaml` or
the docs.

Runtime configuration that is *not* in `plane.env` lives in the DB table
**`instance_configurations`**, set through the god-mode UI, keyed by `category`
(`AI`, `SMTP`, …). This is the usual source of confusion — SMTP is configured there,
which is why `plane.env` has no mail settings yet mail "is" configured.

```bash
# inspect without printing secrets
docker exec -e PGPASSWORD=plane plane-app-plane-db-1 psql -U plane -d plane -c \
  "select key, category, length(value) len, is_encrypted from instance_configurations order by category, key;"
```

## 7. AI stack

Extended beyond upstream: overlay `app/services_package/llm/` adds an
**`OllamaProvider`** to Plane's OpenAI/Anthropic/Gemini registry, pointed at the
box's own Ollama (`http://192.168.1.167:11434/v1`), and rewires the `ai-assistant`
endpoints through `LLMService`. Upstream's hardcoded model allow-list is relaxed for
Ollama — arbitrary model names, empty API key substituted with the literal `"ollama"`.

Live config (2026-09-18, category `AI`):

| Key | Value |
|---|---|
| `LLM_PROVIDER` | `ollama` |
| `LLM_MODEL` | `deepseek-v4.1-flash:cloud` |
| `LLM_API_KEY` | *empty* (expected for Ollama) |
| `GPT_ENGINE` | `hermes3:latest` (legacy, unused) |

Ollama on the box serves `kimi-k3:cloud`, `deepseek-v4.1-flash:cloud`,
`kimi-k2.7-code:cloud`, `gemma4:31b-cloud`, `deepseek-v4-flash:cloud`,
`deepseek-v4-pro:cloud`, `kimi-k2.6:cloud`, `hermes3:latest`. The `:cloud` models are
**hosted on ollama.com and proxied through the local daemon** — so inference is *not*
fully local, and it draws on an ollama.com account quota (**429 weekly-limit errors
already seen in `~/email-ingest.log`**). A local-only model avoids that.

`InstanceAIProvidersEndpoint` (`overlays/plane/license/api/views/ai_providers.py`)
lists providers for god-mode and queries Ollama `/api/tags` live for the real
installed models.

**Former gap — FIXED 2026-09-19.** `has_llm_configured` computed `bool(LLM_API_KEY)`,
which was empty under Ollama, so the frontend hid the AI buttons although the backend
worked. Fixed via the config route (not code): `LLM_API_KEY` is now the encrypted
literal `"ollama"` — the local Ollama daemon ignores the key, so this is a no-op for
inference, and the flag is now `true` in `/api/instances/`. If the buttons ever
disappear again, check that key first; the structural fix would be overlaying
`license/api/views/instance.py` (not currently overlaid). Do **not** add a model
list to `OllamaProvider` — that would break live model discovery.

Upstream's `POST /api/workspaces/{slug}/rephrase-grammar/` (Pages "Ask Pi") **does
not exist** here, and the overlays do not add it.

## 8. Email ingestion and the deliverable store

`plane/email_feed/` polls each workspace inbox with a complete IMAP config, persists
messages to the `email_ingest` table (deduped by Message-ID), and — with
`EMAIL_INGEST_AUTOSCOPE=1` — runs AI scope analysis on arrival. `EmailIngest` is an
**unmanaged** model: the table is created via `CREATE TABLE IF NOT EXISTS`, so there
is no migration to run.

**Scheduled by host cron, every 5 minutes, inside the api container** (email_feed is
not in `INSTALLED_APPS`, so Celery autodiscovery would not register a task without
overlaying `celery.py`):

```
*/5 * * * * docker exec plane-app-api-1 python3 manage.py shell -c \
  "from plane.email_feed.ingest import poll_and_ingest_once; poll_and_ingest_once()" \
  >> /home/rm/email-ingest.log 2>&1  # plane-email-ingest
```

Manual trigger / inspection, as InstanceAdmin:
`POST /api/email-feed/ingest/run/` (poll now), `GET /api/email-feed/ingest/` (list rows).

**Deliverables land in Dropbox and are surfaced in Plane.** The host directory
`/home/rm/Dropbox/PlaneArtifacts` is mounted into the api container at
`/mnt/dropbox-store` (`rw`). Store API (`email_feed/store_views.py`):

| Route | Who | Purpose |
|---|---|---|
| `store/list/` | workspace member | browse the store |
| `store/download/` | member, **or** anyone with signed `?t=<token>` | view/download a file or index page |
| `store/place/`, `store/place-target/` | member | copy a Plane attachment into the store |
| `store/pull/` | member | **pull a store file into Plane as a `FileAsset`** |

`StoreDownloadPermission` allows a valid `t` token whose workspace matches, otherwise
falls back to `WorkspaceMemberPermission`. `store/pull/` deliberately bypasses the
5 MiB `FILE_SIZE_LIMIT` and writes `f"{workspace_id}/{uuid4().hex}-{sanitize(name)}"`.

Store contents verified 2026-09-18: **19 files, 9.0 MB**, all under
`cc/Sares-Regis_Colorado_Market_Map/…` — `_source_email/` images plus
`JN Property History - SRG.xlsx`; `Reconciled_Colorado_asset_list_CO-only_extract_from_JN_Prope/SRG_Colorado_Assets_Reconciled.{csv,xlsx}`;
`Supporting_data_table_legend_sheet_for_the_map_units_type_ho/…`; and the
`Colorado_submarket_map_dot-marker_version_in_Illustrator_pri/` PNG/PDF set.

**The store is a superset of Plane — never assume a file is in Plane because it is in
Dropbox.** Checked 2026-09-19: the store holds **19 files**, but Plane has only **4
`FileAsset` rows** ever (3 pulled 19:11, one — the group logo — 19:59). So **15 of the
19 store files have no Plane counterpart at all**, including all ten
`Colorado_submarket_map…/*.png|pdf` exports, which were written at **20:18, 20:44 and
20:50 — after Plane's last pull (19:59)**. Those deliverables were produced and dropped
into the Dropbox directory directly; they were never created in, or imported into,
Plane, and Plane cannot see them. Their only route to a human is the store browser
(`store/list/`, `store/download/`), which needs `/api/*` — i.e. the API this doc's §2
covers. Anything that must appear in Plane has to be brought in deliberately via
`store/pull/`.

```bash
# reconcile the two sides yourself
find /home/rm/Dropbox/PlaneArtifacts -type f -printf '%TY-%Tm-%Td %TH:%TM %P\n' | sort
docker exec -i plane-app-api-1 python3 manage.py shell -c \
  "from plane.db.models import FileAsset
for a in FileAsset.objects.order_by('created_at'):
    print(a.created_at, a.entity_type, a.attributes.get('name'))"
```

**Email-inbox attachment previews (2026-09-23).** Attachments in the inbox previously carried only
extracted text (PDF extraction was a naive scanner that returned nothing for compressed PDFs, and
the bytes were never served). Now `pypdf` extracts real text, and `email-feed/attachment/`
(`attachment_views.py`) streams the actual attachment — located by Message-ID, type-whitelisted with
magic-byte checks, `nosniff`, CSP-sandboxed except PDFs — so the inbox previews images, PDFs, audio,
video and CSVs in place. Chrome refuses its PDF viewer in *any* sandboxed iframe, so PDFs use
`<object>`. Not covered: HTML email bodies, HEIC, legacy .doc/.xls, OCR. See the box RUNBOOK.

Attachments in Plane live in **`FileAsset`** (v1.3.1 has no separate
`IssueAttachment` model); issues attach as rows with
`entity_type='ISSUE_ATTACHMENT'` and an `issue` FK.

The frontend adds `place-in-store-modal.tsx` (copy a Plane attachment into the
store, destination chosen server-side and shown before writing) plus modified
`attachment-item-list.tsx` / `attachment-list-item.tsx` for this flow —
**committed** `ea277fabb` as of 2026-09-22 (was untracked WIP at last
verification; see `docs/plane-crm-plan.md` §9). Pre-edit backups remain at
`~/overlay-backups/*.20260918-215149`.

## 9. Known issues (verified, current)

1. **`docker cp` into mounted overlay paths silently fails** — read-only bind mounts.
   Fixed in `plane-deploy.sh`; the old script's api loop was a no-op.
2. ~~**`storage.py` not bind-mounted**~~ — FIXED 2026-09-19: bind-mounted into
   api/worker/beat-worker via the `api_common` anchor; all three verified identical.
3. ~~**AI buttons hidden**~~ — FIXED 2026-09-19, see §7.
4. **`rephrase-grammar` absent**, so Pages "Ask Pi" has no backend.
5. **Off-box backup now exists but is pull-based** (2026-09-19): both repos are
   mirrored to the LAN Gitea (`192.168.1.203:3000/synchronic1/plane-selfhost` and
   `…/plane-source`, both private) via Mac working clones in
   `~/Documents/SysDev/plane-box/`. The box cannot reach that LAN, so mirrors update
   only on a manual re-sync from the Mac (`git -C ~/Documents/SysDev/plane-box/<repo>
   fetch origin && git push gitea <branches>`). `plane-selfhost` also has a GitHub
   origin (`synchronic1/plane-heurchain`) the box **can** reach — as of 2026-09-19 it
   is 2 commits behind. Uncommitted work in either box repo is still unprotected
   in general — though the specific `plane-source` WIP noted in §8 was committed
   (`ea277fabb`) by 2026-09-22; don't assume that state persists, re-check before
   relying on it.
6. **Ollama cloud quota** — 429 weekly-limit errors in `~/email-ingest.log`.
7. ~~**Outbound SMTP broken**~~ — FIXED 2026-09-19: the aplus.net-hosted mail
   server presents a `*.aplus.net` cert on `mail.carlssoncreative.com`, and
   `mail.aplus.net` resolves to the **same IP** (64.29.151.235), so `EMAIL_HOST`
   was changed to `mail.aplus.net` in `instance_configurations` — hostname
   verification passes against the same server, verified with
   `manage.py test_email`. The overlay `plane/utils/email_backend.py` (hostname
   check off via `EMAIL_BACKEND`) stays as defense-in-depth but is no longer
   load-bearing. Signups should now receive magic codes; the ORM user-creation
   workaround is no longer needed.
8. **A UI change may look like it needs a re-login** — the SPA shell was served
   without `Cache-Control`, so Cloudflare applied its default 14 400 s browser TTL.
   Fixed at the origin by `overlays/web/nginx.conf`.
9. **Two UI-verification traps.** Plane's `CustomMenu.MenuItem` puts `role="menuitem"`
   on a wrapper `div`; the real `<button>` (and the React `onClick`) is inside — click
   `item.querySelector('button')`. And a 404 on a session-minted cookie usually means
   the wrong session store: `SESSION_ENGINE` is the module path
   `plane.db.models.session` (**table `sessions`**, not `django_session`).
10. **Server-side scripts write `created_by = NULL`.** `BaseModel.save()` ignores a
    `created_by=` kwarg and reads crum's thread-local user, unset outside a request.
    Wrap with `crum.set_current_user(user)` … `finally: None`, and verify in the DB —
    HTTP 201 does not mean attribution was set.
11. ~~**502s trace to the Sweden LAN flapping**~~ — **wrong, corrected 2026-09-19.** A
    502 on `/api/*`/`/auth/*`/`/static/*` is Caddy failing to reach a **restarting
    `api` container** (`connect: connection refused` in `http.log.error`), and clears
    itself when the container is up. Verify with `docker logs plane-app-proxy-1`.
    See §2. Only *SSH* hiccups trace to the tunnel/LAN.
12. **The old "~12 GB / `manage.py` will OOM-kill" note is obsolete** — 19 GiB
    reported, ~2.2 GiB used, the 5-minute cron runs `manage.py shell` indefinitely.

## 10. Attachments — FIXED 2026-09-19

Root cause (confirmed by reproduction, no browser needed): the attachment endpoint's
302 redirect carried `Location: http://…/uploads/<key>?X-Amz-…` with scheme **http**.
cloudflared reaches Caddy over plain HTTP on :8090, Caddy told Django the scheme was
http, and Django built the presigned URL from it. Chrome blocks an http download
initiated from an https page ("Insecure download blocked") — the click neither
downloaded nor opened, while every server-side test passed.

**Fix:** `overlays/proxy/Caddyfile` (bind-mounted at `/etc/caddy/Caddyfile`) adds
`header_up X-Forwarded-Proto https` on the `/api/*`, `/auth/*`, `/static/*` upstreams;
Django already trusts the header via `SECURE_PROXY_SSL_HEADER`. Verified end-to-end
through Cloudflare: the 302 now carries `Location: https://plane.heurchain.com/uploads/…`
and following it returns the file (200, correct content-type).

Caveat: anyone browsing Plane by LAN IP (`http://192.168.1.167:8090`) now receives
https download URLs — fine for the origin proxy on :443, broken if hitting :8090 http
directly. Everyone uses the public https URL, so this is theoretical. If LAN-direct
access ever matters, scope the header by Host in the Caddyfile.

Reproducing the redirect needs a minted session — see the `plane-ui-verification-session`
memory (session store `plane.db.models.session`, cookie `session-id`, delete the row
afterwards). Note the box's own curl to its public URL is unreliable (hairpin + LAN
flap); always verify the public path **from the Mac**.

Latent bug found alongside it: the overlay `S3Storage.url()` returns the **bare object
name** (`def url(self, name, ...): return name`). Attachments are unaffected because
they use the API path, but anything else calling `storage.url()` gets a relative
fragment — worth auditing before it bites.

## 10a. Multiple mailboxes per workspace — BUILT 2026-09-23

The inbox is no longer tied to one IMAP account. `email_account` (unmanaged
table, `email_feed/accounts.py`) holds any number of mailboxes per workspace,
each with enabled / AI-on-arrival (default OFF) / messages-per-check /
shared-or-private, Fernet-encrypted password, and a colour. The old single
mailbox is adopted automatically; `email_ingest` dedupe is unchanged so nothing
is re-ingested. Admins can pause/edit/remove a private mailbox but not read it;
non-admins cannot add loopback/LAN hosts (SSRF guard). One broken mailbox is
reported in the inbox and does not block the others. Cross-mailbox threads merge
by Message-ID. The "only 22 threads" symptom was the UI's hardcoded
`?limit=30`; the inbox now has "Load older mail" (30 -> 150).

Not verified against a real second mailbox (no credentials to hand) — the merge
logic was tested with mocked IMAP and the UI with a deliberately unreachable
mailbox. Details: box `RUNBOOK.md`, "Email inbox: multiple mailboxes".

## 11. Standing constraints that apply to this work

- `plane-app/plane.env` holds secrets and is gitignored — **never commit or print it**.
- **Do not add or delete the Cloudflare Workers-managed DNS record** (see
  `AiTinkerersVenice/docs/dns-repair.md`).
- Web browsing goes through the `/browse` skill; never `mcp__claude-in-chrome__*`.
- External model inference goes through `bin/oxen`; the Oxen key must never appear in a
  prompt, log, source file, commit, or file, and Keychain is never called directly.
- Prefer read-only diagnosis on this box. It is shared, unbacked-up, and serves a live
  agency workflow — confirm before restarting containers or recreating them.

## 12. Quick reference

| Need to… | Do |
|---|---|
| Reload a backend overlay change | `~/plane-deploy.sh api` |
| Ship a UI change | commit/stash WIP in `~/plane-source`, then `~/plane-deploy.sh web` |
| Check a container matches the repo | `~/plane-deploy.sh check` |
| Check the deployment is healthy | `~/plane-deploy.sh verify` |
| Roll back the SPA | `~/plane-deploy.sh rollback-web` |
| Read/repair instance config | query `instance_configurations`, §6 |
| See why email ingest failed | `grep ERROR ~/email-ingest.log \| tail` |
| Add a new overlay file | add it **and** a mount line, then `docker compose up -d api worker beat-worker` |
| Understand the email pipeline | `/home/rm/plane-selfhost/plane-app/overlays/INGEST.md` |
| Reach the box / CIFS share / RDP | `AiTinkerersVenice/docs/vinlandclaw-access.md` |
| Full box-side runbook | `/home/rm/plane-selfhost/RUNBOOK.md` |
