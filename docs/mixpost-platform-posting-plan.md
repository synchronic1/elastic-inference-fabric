# Mixpost — platform-posting plan (Instagram · Meta/Facebook · Threads · LinkedIn)

**Date:** 2026-09-20 · **Host:** vinlandclaw (192.168.1.167) · **Install:** `/home/rm/MixpostApp`
**Question answered:** what does it take to post to Instagram, Facebook, Threads and LinkedIn from the
Mixpost Lite install, and in what order.

Everything below is verified against the box's vendored tree (`inovector/mixpost` **2.6.0**) and the
live SQLite DB — read-only. No writes.

---

## 1. Ground truth — what the vendored package actually ships

`vendor/inovector/mixpost/src/SocialProviderManager.php:21-24` registers **exactly three** providers:

| key | class | covers |
|---|---|---|
| `twitter` | `TwitterProvider` | X |
| `facebook_page` | `FacebookPageProvider` | **Facebook Pages only** |
| `mastodon` | `MastodonProvider` | Mastodon |

There is **no** `InstagramProvider`, **no** `ThreadsProvider`, **no** `LinkedInProvider` anywhere in the
vendor tree (grep-verified). The `MetaProvider` base class *declares* Instagram scopes
(`instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments`)
but they are inherited leftovers shared with the paid Pro line — `facebook_page` uses
`ManagesFacebookPageResources`, which lists Pages and publishes to `/feed`/`/photos`/`/videos` only. No
Instagram account discovery, no `media_publish` path. Threads is entirely absent.

**Live DB state** (`mixpost_services`, `mixpost_accounts`, `mixpost_direct_accounts`):

- `mixpost_services` → only `twitter` (no `facebook` row ⇒ **no Meta app configured**).
- `mixpost_accounts` → only `twitter` (X `@PeterJ_Medina`).
- `mixpost_direct_accounts` → **0 rows** (schema allows `bluesky | linkedin`).

So for the four requested platforms, none is live today.

---

## 2. Per-platform assessment

### Facebook (Meta) — config-only, no code
- **Provider fully built**: OAuth connect, page listing, photo + video publish to a Page feed.
- **Missing:** a Meta developer App (App ID + App Secret + API version) entered under
  Mixpost → Services → Facebook (`ServiceManager::get('facebook')` stores `client_id`,
  `client_secret`, `api_version` — the `FacebookService::form()` keys), then connect a Page.
- **Effort:** operator/account work only. Longest pole is creating the Meta app + the client's FB login.

### LinkedIn — already half-built, on a deprecated endpoint
- Custom side-channel, not a first-class provider:
  `app/Services/DirectPublishService.php:77` `postToLinkedIn()` posts **text-only** to
  `https://api.linkedin.com/v2/ugcPosts` (legacy Shares API). Reached only via the MCP
  `direct_publish` tool (`enum bluesky|linkedin`) and `app/Http/Controllers/DirectPublishController.php`
  (route validates `platform in:bluesky,linkedin`). It bypasses the scheduling/approval pipeline.
- **Missing / broken:** `v2/ugcPosts` is deprecated; the replacement is LinkedIn's versioned
  **`/rest/posts`** API (VERIFY exact cutoff — treat as already-or-soon sunset). No media support
  (images need `rest/images` initialize+upload first). No OAuth flow into the pipeline.
- **Effort:** low-medium code (swap the endpoint + add image upload); external deps = a LinkedIn app
  with `w_member_social` scope.

### Instagram (Business/Creator) — new provider + Meta review
- **Not in Lite.** Must build `InstagramProvider` extending the vendor `MetaProvider` (reuse OAuth +
  scopes), implement: account discovery (`/me/accounts` → `instagram_business_account`),
  `/{ig-user-id}/media` + `/{ig-user-id}/media_publish` (Content Publishing API: images, videos, reels),
  and register it in the provider map.
- **Gated:** a **Live** Meta app with `instagram_content_publish` (+ `instagram_basic`,
  `instagram_manage_insights`) Advanced Access; the account must be an Instagram **Business or
  Creator** account linked to a Facebook Page (personal accounts cannot post via API).
- **Effort:** new code + Meta App Review. The review is the long pole and partly outside our control.

### Threads — new provider + Meta review
- **Not in Lite at all.** New `ThreadsProvider` against `graph.threads.net`: OAuth (`threads_basic`,
  `threads_content_publish`), media container (image/video/carousel) then
  `POST /{threads-user-id}/threads_publish`.
- **Gated:** Meta app with Threads permissions, linked IG account.
- **Effort:** new code + review. Highest of the four.

---

## 3. The plan (ranked, for a token-efficient agent)

**Phase A — Facebook live (hours, zero code).**
Create the Meta app → enter App ID/Secret/API version in Mixpost Services → connect the Page → publish
one photo and one video end-to-end **through the existing approval gate**. This is the only quick win and
proves the pipeline for a Meta platform.

**Phase B — LinkedIn: migrate, then decide.**
Swap `postToLinkedIn()` from `v2/ugcPosts` to `/rest/posts`, add image support
(`rest/images` initialize + upload), keep it as the direct-publish side-channel. Later decide whether to
promote to a first-class provider (OAuth + scheduling) or leave as MCP-only.

**Phase C — Instagram, then Threads (two new providers, one Meta app).**
Build `InstagramProvider` first (same Graph lineage, higher demand), then `ThreadsProvider`. Both are
new `app/`-namespace classes extending the vendor `MetaProvider`, registered by overriding
`Inovector\Mixpost\SocialProviderManager::providers()` and **binding it in `AppServiceProvider`** — the
same vendor-override pattern already used for the XSS fix (`55c447a`). **Never edit `vendor/`** (it is
gitignored; a `composer update` erases it). Start the Meta App Review immediately — it gates both.

**Phase D — buy-vs-keep decision.**
Pro ships Instagram (and more) natively; buying it makes the custom AI/approval/MCP layers
duplicate-and-conflicting (per `docs/mixpost-review-plan.md` §4). Decide before sinking more into C.

---

## 4. Exact files a cheap agent will touch

- **Facebook:** no code. Operator: Mixpost → Services → Facebook (App ID / Secret / API version v25.0),
  then Accounts → Connect Facebook.
- **LinkedIn (Phase B):**
  `app/Services/DirectPublishService.php` — rewrite `postToLinkedIn()` (and the `match` in
  `publishToAccounts()` is already correct) to `rest/posts`; add `rest/images` upload for images.
- **Instagram/Threads (Phase C):**
  `app/Mixpost/SocialProviders/Instagram/InstagramProvider.php` (new, extends vendor `MetaProvider`),
  `app/Mixpost/SocialProviders/Threads/ThreadsProvider.php` (new),
  `app/Mixpost/SocialProviderManager.php` (new, overrides `providers()`),
  `app/Providers/AppServiceProvider.php` (add the binding — mirror the XSS-fix binding).
- **Reuse, don't reinvent:** `app/Services/ConceptVariantService.php` already carries per-platform
  character limits (`facebook` 500, `instagram` 2200, `threads` 500) and tone presets;
  `app/Services/MixpostBridgeService.php` already maps `facebook`/`meta`/`instagram`/`threads` slugs.

---

## 5. External blockers to flag to the client before promising delivery

1. **Meta App Review** is required and not guaranteed for Instagram + Threads content publishing
   (`instagram_content_publish` / `threads_content_publish`); needs Business Verification.
2. **Instagram** must be a Business/Creator account linked to a Facebook Page — personal accounts can't
   be posted to via the API at all.
3. **LinkedIn** API products have been tightened; the app needs `w_member_social`, and the deprecated
   `ugcPosts` endpoint must be migrated.

## 6. Not verified

- Exact LinkedIn `ugcPosts` sunset date (assume deprecated; confirm against LinkedIn docs at execution).
- Meta App Review outcome and lead time (platform fact, not an engineering one).
