# CRM / sales-opportunity funnel for the Plane deployment — build plan

How a CRM could be built into, or alongside, the self-hosted Plane at
**plane.heurchain.com**. Every mechanical claim below was verified against the running
box (`ssh vinlandclaw`) and the two repos on 2026-09-22; inferences are marked
`[inference]`. Companion to `docs/plane-handoff.md` — that doc explains the deployment,
this one explains what to build on it.

---

## 1. The one-paragraph version

Plane **v1.3.1 Community Edition** here has **no custom fields, no workspace-level
entities, and no migrations** — so a CRM cannot be modeled as fields on Issues, and it
cannot be added the normal Django way. But the deployment already contains the two
hardest parts of an agency CRM: an **email intake pipeline that has been running for
months** (2,018 ingested messages, deduped, AI-analyzed, every 5 minutes) and a proven
**unmanaged-table pattern** for adding new storage with no rebuild. The realistic plan is
therefore *not* "build a CRM": it is **model the funnel natively in Plane first (zero
code), then add a thin deal layer as overlays reusing the ingest pipeline** — and only
stand up a separate CRM product if someone actually needs a monthly forecast number.

---

## 2. What already exists (the reason this is a small project)

| Asset | State | Why it matters here |
|---|---|---|
| **Email intake** (`overlays/plane/email_feed/`) | **Live, 2,018 rows** (1,957 scoped, 55 error, 6 pending); 11 new in the last 6 hours | This *is* the sales front door. Deals arrive by email; they already land deduped with a stored analysis. |
| **Dedupe** | RFC-822 `Message-ID`, else `uid:seq:subject[:120]`; unique `(mailbox, dedupe_key)` | Safe to poll repeatedly; a CRM can key off it. |
| **AI scope analysis** | `analyze_email()` — injection-hardened (untrusted body fenced + header-stripped), provider-agnostic, timeout-bounded | Reusable extraction engine. Returns 5 prose sections + `suggested_project_id`. |
| **Structured extraction** | `_parse_structured()` — priority, deliverables, next_steps, **no second LLM call** | The pattern to copy for deal fields. |
| **Thread commit** | `threads.py` commits **one Plane issue per inbound email thread** w/ idempotent ledger | "Email as system of record" — the failure mode that kills tracker-CRMs — is largely solved locally. |
| **Deliverable store** | `store/` list·download·place·pull; signed 24 h tokens; atomic chown-aware Dropbox writes; 19 files live | Proposal/contract attachments have a home. |
| **Webhooks** | Schema + dispatch **intact from both write paths**, HMAC-signed — **0 configured** | Stage-change events cost *nothing* to switch on. |
| **`bot_api`** | Self-describing, token-auth agent surface (`/api/bot/v1/`) | Ready-made agent write path. |
| **Plane public API v1** | `X-Api-Key`, 2 live tokens | No new code needed for external read/write. |
| **Activity/notification plumbing** | `fire_issue_activity` / `fire_comment_activity`, working SMTP | CRM-driven changes can appear in History and notify. |

**Counterweight — what does *not* exist:** nothing crosses from ingest into Plane.
`issue_id` is **NULL on all 2,018 ingest rows**; the pipeline only persists analysis text.
There is also no deal value, currency, close date, contact or company anywhere in its
output. That gap is the actual work.

---

## 3. The four constraints that decide the architecture

These are verified, non-negotiable, and between them rule out the obvious approaches.

### 3.1 No custom fields — at v1.3.1 *or* upstream master

There is no `CustomProperty` model, no `issue_properties` table, no endpoint. The
"property" tables that exist (`project_user_properties`, `workspace_user_properties`, …)
are per-user **UI display/filter** state; `IssueProperty` was renamed twice and was never
a custom-field store. `Issue.point` is validator-capped **0–12** and `EstimatePoint.key`
is a non-negative integer, so neither is a credible currency slot.

→ **Deal amount / close date / probability cannot live on an Issue.** New tables are required.

> Relevant: Plane *does* ship a real CRM-ish object (**Customers**). It is
> **Business-plan / Commercial-Edition only**. The `Customer` object itself carries
> `stage`, `contract_status`, `domain`, `employees`, `revenue` — closer to a deal
> record than first assumed — but still has **no amount, probability, close date or
> forecast** field, and **no webhook events** for it at all. See §3.5 for the full
> researched breakdown, including why the Commercial-Edition codebase split makes it
> a poor fit here regardless.

### 3.2 Migrations are a trap, not a difficulty

`migrate` runs in exactly one place — the `migrator` service — and `migrator` is **not**
in the `api_common` anchor, so it has zero overlay mounts and can never see a mounted app.
Meanwhile the api entrypoint runs `manage.py wait_for_migrations` **before `exec gunicorn`**,
and that command loops until the migration graph is empty.

→ Mounting a CRM app **with** a migrations package bricks the API: gunicorn is never
exec'd and every `/api/*`, `/auth/*`, `/static/*` path 502s. A total outage that looks
like a network problem. **Do not attempt Django migrations here.**

→ Use the proven alternative: unmanaged model + idempotent lazy DDL. Exactly three
out-of-band tables exist today and all use it — `email_ingest`, `email_thread_item`,
`email_thread_link`.

### 3.3 A funnel is a project, not a workspace concept

`StateGroup` is a hard six-value enum (`backlog|unstarted|started|completed|cancelled|triage`)
and `states.project_id` is **NOT NULL**. There are no workspace-level states. `Label` *can*
be workspace-scoped at the model level (`WorkspaceBaseModel` allows `project=NULL`) but the
only workspace-level label route is GET-only and inner-joins on project membership, so it
would silently exclude such rows — and there is no create endpoint.

→ **One project per funnel, with custom States named after stages.** Each stage must still
be pinned to one of the six groups. Deal owner/source ride on labels.

### 3.4 The UI is one app, edited on the box

Only **`apps/web`** is deployable. `space` and `live` have no deploy path in
`plane-deploy.sh`; `admin` has committed customizations that **have never been deployed**
(its container still serves the stock May-29 bundle). The Mac clone is a **fetch/backup
mirror** of the box, not a push source — the box's branch is checked out with
`receive.denyCurrentBranch` unset, so pushes to it are refused.

→ A frontend change is authored **on the box**, committed there, shipped by `deploy web`.
There is no "edit on the Mac, push to the box" workflow.

### 3.5 Plane's own paid Customers feature, researched (2026-09-22)

Verified against `developers.plane.so` — the Customer API, the live webhook event
list, and the edition/upgrade docs — rather than assumed from the marketing page.

**The `Customer` object** (`POST /api/v1/workspaces/{slug}/customers/`): `name`,
`email`, `website_url`, `domain`, `employees`, `revenue`, `stage`, `contract_status`,
plus logo/audit fields. `stage` and `contract_status` are free-text strings, not a
managed enum — firmographic data with a loose pipeline label, not a modeled funnel.

**`CustomerProperty`** is a genuine custom-field system — but scoped to Customer
records only, not Issues: `TEXT | DATETIME | DECIMAL | BOOLEAN | OPTION |
RELATION(ISSUE|USER) | URL | EMAIL | FILE`. A `DECIMAL` property could carry deal
value, `DATETIME` a close date, `OPTION` a real stage enum, `RELATION→ISSUE` a link
back to work items — i.e. everything Phase 2's `crm_opportunity` sketch needs to
hand-build. `CustomerRequest` is a separate, third object (`work_item_ids` array),
closer to a linked feature/support request than a deal.

**No CRM webhook events exist, on any plan.** The full v2 event list is `project.*`,
`cycle.*`, `module.*`, `milestone.*`, `page.*`, `workitem.*` and their sub-entities —
nothing for `customer.*`. Paying for Customers does not buy an event hook; it is
REST-poll only, same as the overlay approach in §5 Phase 2.

**Why this doesn't change the recommendation.** Self-hosted access to Customers
needs **Commercial Edition**, and Plane's own docs are explicit that editions "are
separate codebases, not feature toggles on the same binary." The documented
upgrade path (Community → Commercial) is a Postgres/MinIO/Redis backup-restore onto
a *new* Commercial deployment — it says nothing about custom code, and given the
codebase split there is no reason to expect the bind-mount overlay mechanism
(`&api_common`, `/code/plane/...`) or the extension points `email_feed`, `bot_api`
and `store` depend on would survive. Migrating risks having to re-port the actual
hard-won asset here — the 2,018-row, months-running, AI-analyzed email pipeline
(§2) — onto an unfamiliar closed-source target, to buy fields that still need the
same custom-property build-out Option B already scopes for free.

**Net:** treat the `Customer`/`CustomerProperty` schema above as a **design
reference** for Phase 2's `crm_account`/`crm_opportunity` tables — mirror
`stage`/`contract_status`/`domain`/`employees`/`revenue` field-for-field — so the
overlay data shape already matches Plane's own model if Commercial Edition ever
becomes worth revisiting. Do not migrate editions to get it.

---

## 4. The decision that gates everything

One question determines which of the options below is correct:

> **Does anyone need a trustworthy monthly forecast number, or only a visible stage board?**

- **Only a stage board** → stay in Plane (Option A → B). Do not spend the containers.
- **A forecast number someone will be held to** → that number is what buys a real CRM
  (Option C or D), because **no CE-available Plane feature and no overlay gives you
  weighted pipeline value.**

| | Approach | Cost | Main trade-off |
|---|---|---|---|
| **A** | **Pipeline as a Plane project.** States = stages, issues = deals, labels = owner/source, deal value + close date in a structured description header. A ~100-line script computes totals into a weekly digest issue. | **Zero new code** | Works today; no contact object, no in-product rollup, no forecast; convention-over-schema cost grows with volume |
| **B** | **A + overlay deal layer.** Unmanaged `crm_*` tables, overlay views/routes beside `email_feed/`, reuse `threads.py` for per-contact email history, injected UI pipeline view. | Medium; **permanent maintenance tail** | Best fit, one system, reuses the hard part already built. You are hand-building a CRM with no migrations. |
| **C** | **EspoCRM beside Plane.** Native Opportunity (Amount/Stage/Close Date), IMAP+SMTP two-way mail, **free native HMAC webhooks with retries**. ~4 containers, ~1 GiB, port 8081 free. | Low build, second system | Real CRM data model + reporting on day one; duplicate identity and **sync drift** (the risk prior art names most often) |
| **D** | **Twenty beside Plane.** Best product (native Opportunity, Kanban with per-stage Amount, REST+GraphQL+webhooks). | Second system | Best product, best integration API — against a 2 GB vendor floor, reported heap-OOM crashes, a healthcheck-less worker, and **breaking changes in each of the last two releases** |
| **E** | **Migrate self-hosted CE → Commercial Edition, use native Customers + custom properties.** No overlay code for the deal schema itself. | Business plan, $13/seat/mo **+ unscoped migration risk** | §3.5. Separate, closed-source codebase — the email/store/bot_api overlays this deployment depends on are not confirmed to survive the move. Still no native amount/probability/forecast field, still no webhooks. **Not recommended.** |

**Recommendation: start with A, design for B, and let the forecast question force C/D.**
E was researched and rejected — see §3.5.
The two forces that normally push toward a separate CRM are respectively moot (**2 active
users**) and already built (**the `email_feed` overlay**). This deployment currently fits
the profile where tracker-as-CRM works — the same profile where it later gets outgrown.

---

## 5. If we build (Option A → B): the staged plan

### Phase 1 — Model the funnel natively (no code)

1. Create a **Sales** project. Add States named for stages, each pinned to a group
   (`Lead`→backlog, `Qualified`/`Proposal`/`Negotiation`→started, `Won`→completed,
   `Lost`→cancelled).
2. Issues are opportunities. Title = client + scope.
3. Adopt a **structured description header** as the deal record, since there are no custom
   fields. Keep it machine-parseable from day one — this is the seam Phase 3 fills:

   ```
   ## DEAL
   value: 45000 | currency: SEK | close: 2026-11-30 | prob: 60%
   account: Sares-Regis | contact: jenny@carlssoncreative.com
   ```

4. Labels for `owner:` / `source:` / `service-line:`.
5. Verify the funnel is actually used before writing any code. If it is not, stop here —
   that is the cheapest possible failure.

### Phase 2 — The overlay deal layer

Follow the `email_feed` pattern exactly; do not invent a variant.

1. New package `plane-app/overlays/plane/crm/` with an empty `__init__.py`.
2. Models: plain `models.Model` (**not** `BaseModel`) with
   `class Meta: app_label = "db"; managed = False; db_table = "crm_opportunity"`.
   `app_label = "db"` attaches to an already-installed app, so **`INSTALLED_APPS` is not
   touched** (and must not be — mounting `settings/common.py` is the highest-merge-burden
   change in the system).
3. Tables via module-level `_DDL` of idempotent `CREATE TABLE IF NOT EXISTS` +
   `CREATE UNIQUE INDEX IF NOT EXISTS`, run by a guarded `ensure_crm_tables()` with a
   `_table_ready` flag. Copy `email_feed/models.py:45-79` verbatim as the template.
4. Sketch:

   ```
   crm_account      id, workspace_id, name, domain, created_at
   crm_contact      id, workspace_id, account_id, email, name, created_at
   crm_opportunity  id, workspace_id, account_id, primary_contact_id,
                    name, value, currency, probability, close_date,
                    stage, plane_project_id, plane_issue_id,
                    source_ingest_id, external_source, external_id, created_at
   crm_opp_email    opportunity_id, ingest_id, dedupe_key   -- the ledger
   ```

   `stage` is text here, **not** an FK to `states` — funnel stages are a CRM concept and
   must not depend on Plane's six-group enum. Mirror to a Plane State for the board.
5. Routes: add to the **already-overlaid** `overlays/plane/urls.py` as
   `path("api/workspaces/<str:workspace_slug>/crm/", include("plane.crm.urls"))`.
   Staying under `/api/` means **no Caddy change** — Caddy already routes `/api/*` → `api:8000`.
6. Mount + activate: add the mount line to the `api_common` anchor, then
   `cd ~/plane-selfhost/plane-app && docker compose --env-file plane.env up -d api worker beat-worker`.
   **The `--env-file` is mandatory** — without it the proxy interpolates to host `:80`
   (Apache's), and the site goes down. Expect a brief `/api/*` 502 during the recreate.
7. Set `created_by_id=` explicitly — `BaseModel.save()` reads crum's thread-local user,
   which is `None` outside a request, producing `created_by = NULL`.

### Phase 3 — Structured deal extraction

1. Add a **new** prompt + parser in `email_feed/llm.py`. Do **not** extend
   `analyze_email()`'s five-section prompt: `threads.py` and the web client both parse that
   exact shape, and it is deliberately frozen.
2. Reuse `chat()` from `email_feed/llm.py` — **not** `LLMService`. The former already
   supports `ollama|openai|anthropic|openai_compatible|openclaw|ollama_cloud|custom`;
   standardizing on `LLMService` would *lose* Anthropic/OpenClaw/Ollama-Cloud.
3. Extract: `value, currency, close_date, probability, account, contact, stage_hint` —
   returning **JSON**, following `_parse_structured()`'s no-second-call approach.
4. Extend `TEAM_CAPABILITIES` (2,358 chars live, editable via
   `PUT /api/email-feed/team-capabilities/`) with sales context rather than adding a new
   config key.
5. **Budget the quota.** The configured model is `deepseek-v4.1-flash:cloud` — a `:cloud`
   model proxied through the local daemon to ollama.com, drawing on an account quota that
   already shows **429 weekly-limit errors** in `~/email-ingest.log`. Extra CRM call volume
   should pin a local model instead.
6. Schedule anything periodic via **host cron in `rm`'s crontab**, not Celery — a
   non-installed app gets no task autodiscovery.

### Phase 4 — UI

Five touchpoints, all on the box, following the `email-inbox` precedent (commit `4e61e6e49`):

| # | File | Change |
|---|---|---|
| 1 | `apps/web/app/(all)/[workspaceSlug]/(projects)/crm/layout.tsx` | 28-line `AppHeader` + `ContentWrapper` shell |
| 2 | `.../crm/page.tsx` | the pipeline board |
| 3 | `apps/web/app/routes/core.ts` (~:108) | `layout(...)` + `route(...)` beside `email-inbox` |
| 4 | `packages/constants/src/workspace.ts` (~:274, :283) | registry entry **and** add to `WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS_LINKS` |
| 5 | `.../core/components/workspace/sidebar/sidebar-item.tsx` (~:57) + `ce/components/workspace/sidebar/helper.tsx` (~:44) | `staticItems` entry **and** icon `case` |
| 6 | `packages/i18n/src/locales/en/core.ts` (~:27) | one key, `crm: "Sales"` |

Must be workspace-scoped (`/:workspaceSlug/crm`) — the sidebar comes from the
`[workspaceSlug]` layout; a top-level `/crm` in the `(all)` block renders **without a sidebar**.

Then commit **on the box** and run `~/plane-deploy.sh web`. Never `up -d`.

### Phase 5 — Events

- Prefer **webhooks** over email for CRM→external: `webhook_logs` gives per-delivery
  visibility that `EmailNotificationLog` does not, and dispatch already fires from both
  the in-app and public-API write paths.
- **Two blockers to set first:** `WEBHOOK_ALLOWED_IPS` and `WEBHOOK_ALLOWED_HOSTS` are
  **both empty**, so the SSRF guard refuses same-box targets; and `localhost`/`127.0.0.1`
  are rejected at the model validators, so the target must be the LAN IP (`192.168.1.167`)
  or a Docker service hostname.
- Our webhooks are **v1-shaped** (boolean flags `project/issue/module/cycle/issue_comment`,
  no event filtering) — upstream is v2 with dot-notation events, filters and backoff. You
  get everything and filter client-side.
- A stage change is, at best, an issue-update event. **"Deal won" has no representation.**
  Either map stages onto Plane States and read issue events, or add a builder + mapper entry
  + serialized payload (which requires a new overlay file *and* a mount line).

### Phase 6 — Agent surface

- Reuse `bot_api`'s self-describing root as the agent discovery surface; add CRM endpoints
  beside it.
- **Mint scoped tokens** via `POST /api/bot/key/tokens/`. Do **not** use the legacy global
  key: it is plaintext, unscoped, and re-displayable via GET. Scoped tokens are supported
  but `BOT_TOKENS` currently has no row, so the vulnerable key is the only one present.
- Same caution on `api_tokens`: both live tokens are **non-expiring and workspace-unscoped**
  (effectively instance-wide). Mint CRM-specific ones.

---

## 6. Hazards that will bite (verified)

1. **Migrations = outage.** §3.2. The single most likely way to take the site down.
2. **Recreating `web` silently reverts the UI to stock.** `web` has no bind mount for the
   bundle; UI changes live in the container's writable layer via `docker cp`. A recreate
   restores the stock bundle and the CRM page **vanishes with no error**. `plane-deploy.sh check`
   cannot see it (it audits overlay `.py` files only). Always pass `--env-file plane.env`.
3. **`issues.priority` is polluted.** The column is a varchar holding
   `urgent|high|medium|low|none`, but the live table contains **8 rows of `"0"` and 10 of
   `"2"`** because `bot_api/views.py` maps to integers. Those render blank and match no
   filter. **A CRM must not read priority at face value.** (Related: `issues.priority` is a
   poor funnel carrier for exactly this reason.)
4. **No partial unique constraints exist in the live DB** — every `%when_deleted_at_null%`
   constraint declared in the models is missing (0 rows). Live proof: project `SARESR` has
   **two** live States both named `Triage`. **Enforce stage-name uniqueness in application
   code**, not by a constraint.
5. **`created_by = NULL`** on ORM-created objects outside a request (§Phase 2.7). HTTP 201
   does not mean attribution was set — verify in the DB.
6. **Silent sidebar failures.** A nav item missing from `staticItems` renders nothing, with
   no error. Registry keys are **hyphenated** (`"email-inbox"`) while `item.key` and the
   `staticItems`/icon lookups use **underscores** — a mismatch drops the item silently.
7. **Missing mount line is invisible for non-`.py` files.** `check` audits `*.py` only, and
   it validates the override *text*, not the live container's mounts — a declared-but-not-yet-active
   mount reports clean, then behaves differently after a recreate.
8. **Backend in the wrong repo.** The `email_feed` API is **not** in `plane-source`
   (`grep email_feed apps/api/plane` → 0 matches). A CRM API written there would never be
   mounted. Two repos, two deploy procedures.
9. **Stale immutable assets.** `/assets/*` is `max-age=31536000, immutable`; a returning tab
   can run an old bundle. The shell is `no-store`, so a navigation fixes it. Verify by
   grepping the container for a string unique to the change and loading with `?cb=$(date +%s)`.
10. **`deploy web` builds uncommitted changes.** The warning at `plane-deploy.sh:86-89` is a
    notice, not a gate. Commit first or the build is unreproducible.

---

## 7. What not to do

- **Don't add a Django migration.** §3.2.
- **Don't mount `settings/common.py`** to reach `INSTALLED_APPS`. It is a whole-file
  replacement of a 16.9 KB core upstream file — the highest merge burden in the system.
- **Don't put deal value in `Issue.point`** (capped 0–12) or `EstimatePoint.key`.
- **Don't use the legacy `BOT_API_KEY`.**
- **Don't extend `analyze_email()`'s five-section prompt** — it is frozen and parsed in
  two places.
- **Don't build a CRM page in `admin`** expecting it to appear; the deployed admin bundle
  is stock and the existing customizations there are unreachable.
- **Don't plan a `git push` from the Mac to the box** — it is refused.
- **Don't rely on `issue_types`** without accepting the SPA will never display them.

---

## 8. Open questions / verify before building

1. **The forecast question (§4).** Unanswered, and it decides between A/B and C/D.
2. **Is `threads.py` actually wanted as the deal intake path?** It commits one issue per
   email thread, but the ledger tables (`email_thread_link`, `email_thread_item`) have
   **0 rows** — the machinery exists and is unexercised in production. Confirm it is
   in use before building on it.
3. **Where does `store` fit?** The store is a **superset** of Plane (19 files vs 5
   `FileAsset` rows), and attachments arrive after records are created. Decide whether
   proposals/contracts are CRM objects or store paths.
4. **Per-client visibility.** Everything is workspace-scoped today; a CRM needs a
   client-level layer over the store and API. With 2 users, defer — but decide before
   adding users.
5. **Upgrade posture (separate workstream).** We are on v1.3.1 (2026-05-14); CE is at
   **v1.4.2 (2026-08-23)** — 4 releases behind. The schema delta is a *single* migration
   (0121 → 0122) `[inference]`, which is unusually small, and v1.4.0 was a large coordinated
   **security** batch. Against the overlay model, an upgrade means re-merging every
   whole-file overlay (`plane/urls.py`, `license/urls.py`, and six more). Worth its own
   plan — do not fold it into this one.

---

## 9. Provenance, and docs found to be stale

Verified 2026-09-22 against: the running DB (`information_schema`, model introspection),
the api/web/worker containers, `docker-compose.override.yaml`, `plane-deploy.sh`,
`RUNBOOK.md`, and both repos. Read-only throughout — nothing restarted, recreated or written.

Live state at time of writing: **1 workspace (`cc`), 3 projects** (LUXADD, SARESR, UTADFO),
**2 active users, 10 live issues, 0 issue types, 0 webhooks, 4 labels.**

Stale documentation found in the process:

- `AiTinkerersVenice/docs/vinlandclaw-access.md` says LAN IP **192.168.1.204**; the box
  reports **192.168.1.167**.
- `RUNBOOK.md` §3 lists `settings/storage.py` as "not mounted, see §10", but override
  line 21 mounts it and §10 item 2 records it fixed 2026-09-19.
- `overlays/REVIEW.md:44` frames deferred items as needing "a DB model + migration". That
  framing is misleading here: a DB model needs **DDL**, not a migration. The constraint is
  real only for `migrate`.
- The handoff's "untracked WIP in `~/plane-source`" note is stale — the tree is clean;
  `place-in-store-modal.tsx` and the attachment edits were committed in `ea277fabb`.

**§3.5 addendum (2026-09-22):** the Customers/CustomerProperty research is verified
against Plane's public developer docs, not the box —
`developers.plane.so/api-reference/customer/{overview,add-customer,add-customer-property,
add-customer-request,link-work-items-to-customer}`, `/dev-tools/intro-webhooks`, and
`/self-hosting/{editions-and-versions,upgrade-from-community}`.
