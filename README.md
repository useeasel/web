# Easel — `easel/web`

The public face of **Easel**: the marketing site, the two-click onboarding flow
that provisions an artist's portfolio, and the shared Cloudflare Workers that make
it work. Deploys to **easel.rosematcha.com** on Cloudflare Pages. Everything here
runs on Cloudflare's free tier.

Easel never hosts artist content. It orchestrates a one-time OAuth setup (GitHub +
Netlify), generates a repo from `easel/template` into the artist's own GitHub,
creates their Netlify site, and then steps out of the way. The artist owns their
repo and their site.

## The two-repo system

| Repo | What it is |
|---|---|
| **`easel/template`** | The Astro portfolio template + Sveltia CMS at `/admin`. A GitHub *template repo*, generated fresh into each artist's account. |
| **`easel/web`** (this repo) | Marketing site + onboarding/provisioning + the shared Workers. Deploys to `easel.rosematcha.com`. |

## What's in this repo

```
web/
  apps/web/              # Astro marketing + onboarding UI  → Cloudflare Pages
    src/
      pages/             # index, how-it-works, start, start/done
      components/        # EaselMark, Hero, FeatureGrid, ConnectStep, ProgressView, Faq, Footer, ExamplesStrip
      layouts/Base.astro
      styles/tokens.css  # Bauhaus design tokens (shared look with easel/template)
      config.ts          # PROVISION_BASE + worker route helpers
  workers/provision/     # GitHub + Netlify OAuth and the 5-step provisioning run
    src/index.ts         # router
    src/github.ts        # GitHub REST (OAuth, generate-from-template, patch config)
    src/netlify.ts       # Netlify REST (OAuth, create site, deploy, poll)
    src/state.ts         # HMAC-signed OAuth state + transient KV session
    wrangler.toml
  workers/sveltia-auth/  # shared Sveltia CMS GitHub OAuth relay for every /admin
    src/index.ts         # /auth + /callback handshake
    wrangler.toml
  README.md
```

## The onboarding flow

```
/start
  Step 1 — Connect GitHub
    GET  /auth/github         → redirect to GitHub OAuth (scope: public_repo), signed state
    GET  /auth/github/cb      → code → token; stash in KV under state (TTL 10m); back to /start?step=netlify
  Step 2 — Name site + Connect Netlify
    GET  /auth/netlify        → redirect to Netlify OAuth (carries the same state + site name)
    GET  /auth/netlify/cb     → code → token; stash under same state; back to /start?step=provision
  Step 3 — Provision
    POST /provision           → (a) GitHub: generate repo from easel/template
                                (b) Netlify: create site linked to repo (astro build / dist, Forms on)
                                (c) Netlify: trigger first deploy + poll until ready
                                (d) GitHub: patch public/admin/config.yml → point auth at sveltia-auth
                                (e) delete transient tokens from KV
  /start/done
    → links: live site URL + "Edit your site" (/admin)
```

The `/start` page is static HTML driven by a small client script. It only ever holds
the opaque, signed `state` value — the worker holds the tokens (briefly, in KV).

### How worker routes map to the UI

| UI element (`apps/web`) | Worker route (`workers/provision`) |
|---|---|
| Step 1 "Connect GitHub" button | `GET /auth/github` → `GET /auth/github/cb` |
| Step 2 "Connect Netlify" button | `GET /auth/netlify` → `GET /auth/netlify/cb` |
| Step 3 "Build my site" button | `POST /provision` (returns `{status, stages, siteUrl, adminUrl}`) |
| `start/done.astro` links | uses `siteUrl` / `adminUrl` from the provision result |

Every generated `easel/template` repo's `/admin` points its Sveltia `base_url` at
the **`workers/sveltia-auth`** relay, which handles editor login for all artists.

## Local development

### Marketing + onboarding site

```bash
cd apps/web
npm install
npm run dev        # http://localhost:4321
npm run build      # static output → apps/web/dist
```

By default the onboarding UI targets the production provisioning worker. To point
it at a local worker, set a build/dev env var:

```bash
PUBLIC_PROVISION_BASE=http://127.0.0.1:8787 npm run dev
```

### Provisioning worker

```bash
cd workers/provision
npm install
# create the KV namespace once, paste ids into wrangler.toml:
npx wrangler kv namespace create EASEL_STATE
npx wrangler kv namespace create EASEL_STATE --preview
# set secrets (see below), then:
npm run dev        # http://127.0.0.1:8787
npm run typecheck
```

### Sveltia auth relay

```bash
cd workers/sveltia-auth
npm install
npm run dev
npm run typecheck
```

## Required secrets

Set per worker with `wrangler secret put <NAME>` (never commit these). For local
`wrangler dev`, put them in a `.dev.vars` file (gitignored).

**`workers/provision`**

| Secret | Purpose |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | The provisioning GitHub OAuth app (scope `public_repo`). |
| `NETLIFY_OAUTH_CLIENT_ID` / `NETLIFY_OAUTH_CLIENT_SECRET` | The Netlify OAuth app. |
| `STATE_SIGNING_KEY` | Long random string; HMAC key for signing OAuth `state`. |

Plus `[vars]` in `wrangler.toml`: `APP_ORIGIN`, `WORKER_ORIGIN`, `SVELTIA_AUTH_URL`,
`TEMPLATE_OWNER`, `TEMPLATE_REPO`; and the `EASEL_STATE` KV binding.

**`workers/sveltia-auth`**

| Secret | Purpose |
|---|---|
| `SVELTIA_GITHUB_CLIENT_ID` / `SVELTIA_GITHUB_CLIENT_SECRET` | A *separate* GitHub OAuth app for the editor relay (scope `repo`). Its callback URL is this worker's `/callback`. |

## Deploy targets

| Piece | Target |
|---|---|
| `apps/web` | Cloudflare Pages → `easel.rosematcha.com` (build `npm run build` in `apps/web`, output `dist`). |
| `workers/provision` | Cloudflare Worker (e.g. route `provision.easel.rosematcha.com`). `cd workers/provision && npm run deploy`. |
| `workers/sveltia-auth` | Cloudflare Worker (e.g. route `auth.easel.rosematcha.com`). `cd workers/sveltia-auth && npm run deploy`. |

Wire the OAuth apps' callback URLs to the deployed worker origins:
GitHub provisioning → `…/auth/github/cb`; Netlify → `…/auth/netlify/cb`;
Sveltia editor → `…/callback`.

## Security posture

- OAuth `state` is HMAC-signed (`STATE_SIGNING_KEY`) and validated on every callback.
- Tokens are **transient**: held only for one provisioning run in KV with a 10-minute
  TTL, then deleted in step (e). No long-lived user tokens are stored.
- Minimal scopes: GitHub `public_repo` for provisioning; the editor relay uses `repo`
  (Sveltia needs commit access to the artist's own repo).
- The sveltia-auth relay guards the callback with an http-only state cookie and can
  restrict the token `postMessage` target via `ALLOWED_ORIGINS`.

## Brand

Bauhaus: blue `#1D4ED8`, red `#E63946`, yellow `#F4C20D`, ink `#161616`, paper
`#F7F4EC`, stone `#6B6B63`. Hard edges (radius 0), 2px ink borders instead of
shadows, circle/square/triangle motif, Syne headings + Space Grotesk body. Tokens
live in `apps/web/src/styles/tokens.css` and mirror `easel/template`.
