/**
 * Netlify REST helpers for the provisioning flow.
 *
 * Docs:
 *   OAuth:        https://docs.netlify.com/api/get-started/#authentication
 *   Open API:     https://open-api.netlify.com/
 *   Create site:  POST /api/v1/sites  (with repo block to link the GitHub repo)
 *   Build hooks / deploys: POST /api/v1/sites/{site_id}/builds
 *
 * Note on the repo link: linking a GitHub repo through the API requires the repo
 * provider to be connected to the Netlify account. Where the exact `repo` block
 * shape depends on the account's GitHub installation, the payload below uses the
 * documented fields; adjust `repo.id`/`installation_id` once a real account is wired.
 */

import type { DeployState, HostProvider, ProvisionTokens, SiteHandle } from './hosts/types';
import { addDeployKey, createNetlifyPushWebhook, type GeneratedRepo } from './github';

export type { DeployState };

const NETLIFY_API = 'https://api.netlify.com/api/v1';

export const NETLIFY_AUTHORIZE_URL = 'https://app.netlify.com/authorize';
const NETLIFY_TOKEN_URL = 'https://api.netlify.com/oauth/token';

export interface NetlifyOAuthApp {
  clientId: string;
  clientSecret: string;
}

/** Build the Netlify authorize URL (Step 2 of the flow). */
export function netlifyAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(NETLIFY_AUTHORIZE_URL);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('state', opts.state);
  return u.toString();
}

/** Exchange an OAuth `code` for an access token. */
export async function exchangeNetlifyCode(
  app: NetlifyOAuthApp,
  code: string,
  redirectUri: string,
): Promise<string> {
  // Netlify expects form-encoded params on the token endpoint.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    redirect_uri: redirectUri,
  });
  const res = await fetch(NETLIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(`Netlify token exchange failed: ${data.error_description ?? 'no token'}`);
  }
  return data.access_token;
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export interface NetlifySite {
  id: string;
  name: string;
  url: string; // primary https URL
  adminUrl: string;
}

export interface NetlifyDeployKey {
  id: string;
  /** SSH public key to register on the repo as a read-only deploy key. */
  publicKey: string;
}

/**
 * Create a Netlify deploy key. Netlify keeps the private half; the caller adds the
 * public half to the artist's repo (see addDeployKey in github.ts) so Netlify can
 * clone it for continuous deployment.
 */
export async function createDeployKey(token: string): Promise<NetlifyDeployKey> {
  const res = await fetch(`${NETLIFY_API}/deploy_keys`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Netlify create deploy key failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { id: string; public_key: string };
  return { id: data.id, publicKey: data.public_key };
}

/**
 * Step (b): create a Netlify site linked to the artist's GitHub repo, with the
 * Astro build command + `dist` publish dir. Forms are enabled by Netlify's build
 * post-processing automatically when it detects the template's `data-netlify`
 * form, so no separate API call is strictly required; we set `processing_settings`
 * to be explicit.
 */
export async function createSite(
  token: string,
  opts: {
    repoPath: string; // 'owner/repo'
    branch: string; // e.g. 'main'
    /** Numeric GitHub repo id — Netlify keys the repo link off this, not the path. */
    repoId: number;
    /**
     * Netlify deploy key id (see createDeployKey). Its public half is added to the
     * repo so Netlify can clone it over SSH — this is what links the repo for
     * continuous deployment without needing Netlify's GitHub App.
     */
    deployKeyId: string;
  },
): Promise<NetlifySite> {
  // Link the repo via a deploy key (SSH). We use this instead of the GitHub App
  // installation flow because that requires a GitHub App token, while our GitHub
  // integration is a classic OAuth App — its tokens can't enumerate App
  // installations, so `installation_id` was always null and Netlify fell back to a
  // keyless deploy-key clone that always failed "host key verification failed".
  // Providing the key id makes that path actually work.
  const repo: Record<string, unknown> = {
    provider: 'github',
    id: opts.repoId,
    repo: opts.repoPath,
    repo_branch: opts.branch,
    branch: opts.branch,
    private: false,
    deploy_key_id: opts.deployKeyId,
    // Install dependencies *in the build command*. Sites created through the API
    // with an explicit `cmd` don't reliably get Netlify's automatic dependency
    // install step, so a bare `astro build` fails with `astro: command not found`
    // (exit 127) — the binary never gets installed. `npm install` first, then run
    // the package script (which puts node_modules/.bin on PATH) makes it robust.
    cmd: 'npm install && npm run build',
    dir: 'dist',
  };

  const res = await fetch(`${NETLIFY_API}/sites`, {
    method: 'POST',
    headers: authHeaders(token),
    // No `name` — let Netlify assign a unique random subdomain so two artists
    // never clash. They add a custom domain afterward for a real address.
    body: JSON.stringify({
      repo,
      // Enable form detection (Netlify Forms) during post-processing.
      processing_settings: {
        html: { pretty_urls: true },
        skip: false,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Netlify create site failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    id: string;
    name: string;
    ssl_url?: string;
    url?: string;
    admin_url?: string;
  };
  return {
    id: data.id,
    name: data.name,
    url: data.ssl_url ?? data.url ?? `https://${data.name}.netlify.app`,
    adminUrl: data.admin_url ?? `https://app.netlify.com/sites/${data.name}`,
  };
}

/** Step (c, part 1): trigger the first build/deploy. */
export async function triggerBuild(token: string, siteId: string): Promise<void> {
  const res = await fetch(`${NETLIFY_API}/sites/${siteId}/builds`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ clear_cache: true }),
  });
  // 200/201 = build queued. A site created with a linked repo often kicks off a
  // build automatically; this is a belt-and-suspenders trigger.
  if (!res.ok && res.status !== 422) {
    const body = await res.text();
    throw new Error(`Netlify trigger build failed (${res.status}): ${body}`);
  }
}

// Netlify deploy states that mean "still working" (not yet success or failure).
const IN_PROGRESS_STATES = new Set([
  'new',
  'pending_review',
  'accepted',
  'enqueued',
  'building',
  'preparing',
  'prepared',
  'processing',
  'uploading',
  'uploaded',
]);

/**
 * Step (c, part 2): summarize the site's recent deploys into one status.
 *
 * We look at a *window* rather than just the single latest deploy because a fresh
 * site fires several deploys in quick succession — the initial build, our explicit
 * trigger, and the webhook build from the admin-config commit — and Netlify marks
 * the redundant ones `skipped`. Reading only `per_page=1` and hitting a `skipped`
 * (or otherwise non-terminal) deploy maps to `unknown`, which is never terminal, so
 * the wizard hangs on "Building…" forever even though a `ready` deploy sits right
 * below it. So: any recent deploy `ready` ⇒ the site is live; else anything still
 * in progress ⇒ building; else a hard `error` with nothing live ⇒ error.
 */
export async function getLatestDeployState(
  token: string,
  siteId: string,
): Promise<DeployState> {
  const res = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys?per_page=10`, {
    headers: authHeaders(token),
  });
  if (!res.ok) return 'unknown';
  const deploys = (await res.json()) as Array<{ state: string }>;
  if (!deploys.length) return 'unknown';
  const states = deploys.map((d) => d.state);
  if (states.includes('ready')) return 'ready';
  if (states.some((s) => IN_PROGRESS_STATES.has(s))) return 'building';
  if (states.includes('error')) return 'error';
  return 'unknown'; // e.g. only `skipped` so far — keep polling
}

/**
 * Netlify host provider. Creating the site is the current 3-step CD wiring: mint a
 * deploy key, add its public half to the repo, then create the site against it (plus
 * a best-effort push webhook so editor commits auto-rebuild).
 */
export const netlifyProvider: HostProvider = {
  id: 'netlify',
  needsNetlify: true,
  formBackend: 'netlify',

  async createSite({ tokens, repo }: { tokens: ProvisionTokens; repo: GeneratedRepo }): Promise<SiteHandle> {
    if (!tokens.netlifyToken) throw new Error('netlify token missing');
    const deployKey = await createDeployKey(tokens.netlifyToken);
    await addDeployKey(tokens.githubToken, {
      owner: repo.owner,
      repo: repo.name,
      title: 'Easel · Netlify deploy',
      publicKey: deployKey.publicKey,
    });
    const site = await createSite(tokens.netlifyToken, {
      repoPath: `${repo.owner}/${repo.name}`,
      branch: repo.defaultBranch,
      repoId: repo.id,
      deployKeyId: deployKey.id,
    });
    // Wire the push webhook so future editor commits auto-rebuild — the "hit save →
    // it republishes" promise. Best-effort: a failure here only affects
    // auto-publish-on-edit, not the first deploy, so it becomes a soft warning.
    let warning: string | undefined;
    try {
      await createNetlifyPushWebhook(tokens.githubToken, { owner: repo.owner, repo: repo.name });
    } catch (e) {
      console.warn('[provision] push webhook setup failed:', e);
      warning =
        'Your site is live, but we couldn’t finish setting up auto-publishing. ' +
        'If edits stop going live, reconnect the repo from your Netlify site settings.';
    }
    return {
      siteUrl: `${site.url.replace(/\/$/, '')}/`,
      adminUrl: `${site.url.replace(/\/$/, '')}/admin/`,
      siteId: site.id,
      dashboardSlug: site.name,
      warning,
    };
  },

  async triggerBuild({ tokens, site }: { tokens: ProvisionTokens; site: SiteHandle }): Promise<void> {
    if (!tokens.netlifyToken || !site.siteId) return;
    await triggerBuild(tokens.netlifyToken, site.siteId);
  },

  async getDeployState({ tokens, site }: { tokens: ProvisionTokens; site: SiteHandle }): Promise<DeployState> {
    if (!tokens.netlifyToken || !site.siteId) return 'unknown';
    return getLatestDeployState(tokens.netlifyToken, site.siteId);
  },
};
