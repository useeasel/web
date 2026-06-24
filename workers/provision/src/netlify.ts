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
  },
): Promise<NetlifySite> {
  const res = await fetch(`${NETLIFY_API}/sites`, {
    method: 'POST',
    headers: authHeaders(token),
    // No `name` — let Netlify assign a unique random subdomain so two artists
    // never clash. They add a custom domain afterward for a real address.
    body: JSON.stringify({
      repo: {
        provider: 'github',
        repo: opts.repoPath,
        repo_branch: opts.branch,
        branch: opts.branch,
        cmd: 'astro build',
        dir: 'dist',
      },
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

export type DeployState = 'building' | 'ready' | 'error' | 'enqueued' | 'unknown';

/** Step (c, part 2): poll the latest deploy's state. */
export async function getLatestDeployState(
  token: string,
  siteId: string,
): Promise<DeployState> {
  const res = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys?per_page=1`, {
    headers: authHeaders(token),
  });
  if (!res.ok) return 'unknown';
  const data = (await res.json()) as Array<{ state: string }>;
  const state = data[0]?.state;
  switch (state) {
    case 'ready':
      return 'ready';
    case 'error':
      return 'error';
    case 'building':
    case 'processing':
    case 'uploading':
      return 'building';
    case 'enqueued':
    case 'new':
      return 'enqueued';
    default:
      return 'unknown';
  }
}
