/**
 * GitHub REST helpers for the provisioning flow.
 *
 * Docs:
 *   OAuth web flow:        https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 *   Generate from template:https://docs.github.com/rest/repos/repos#create-a-repository-using-a-template
 *   Get/update file:       https://docs.github.com/rest/repos/contents
 *
 * We request the minimal `public_repo` scope — enough to create one public repo
 * and commit a config edit, nothing more.
 */

const GH_API = 'https://api.github.com';
const UA = 'easel-provision-worker';

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export interface GithubOAuthApp {
  clientId: string;
  clientSecret: string;
}

/** Build the GitHub authorize URL (Step 1 of the flow). */
export function githubAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(GITHUB_AUTHORIZE_URL);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('scope', 'public_repo');
  u.searchParams.set('state', opts.state);
  u.searchParams.set('allow_signup', 'true');
  return u.toString();
}

/** Exchange an OAuth `code` for an access token. */
export async function exchangeGithubCode(
  app: GithubOAuthApp,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(`GitHub token exchange failed: ${data.error_description ?? 'no token'}`);
  }
  return data.access_token;
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
  };
}

/** The authenticated user's login — needed to address their new repo. */
export async function getGithubLogin(token: string): Promise<string> {
  const res = await fetch(`${GH_API}/user`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`GitHub /user failed (${res.status})`);
  const data = (await res.json()) as { login: string };
  return data.login;
}

export interface GeneratedRepo {
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
}

/**
 * Step (a): generate the artist's repo from easel/template.
 * POST /repos/{template_owner}/{template_repo}/generate
 */
export async function generateRepoFromTemplate(
  token: string,
  opts: {
    templateOwner: string; // 'easel'
    templateRepo: string; // 'template'
    owner: string; // artist's login
    name: string; // new repo name (site slug)
    description?: string;
  },
): Promise<GeneratedRepo> {
  const res = await fetch(
    `${GH_API}/repos/${opts.templateOwner}/${opts.templateRepo}/generate`,
    {
      method: 'POST',
      headers: { ...authHeaders(token), Accept: 'application/vnd.github+json' },
      body: JSON.stringify({
        owner: opts.owner,
        name: opts.name,
        description: opts.description ?? 'My portfolio, made with Easel.',
        private: false,
        include_all_branches: false,
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`generate-from-template failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    name: string;
    html_url: string;
    default_branch: string;
    owner: { login: string };
  };
  return {
    owner: data.owner.login,
    name: data.name,
    htmlUrl: data.html_url,
    defaultBranch: data.default_branch ?? 'main',
  };
}

/**
 * Step (d): patch the new repo's `public/admin/config.yml` so Sveltia points its
 * OAuth `base_url` at our shared sveltia-auth relay.
 *
 * Implementation: read the existing file (for its blob sha), rewrite the
 * `backend.base_url` line, and PUT it back as a commit. We keep the rewrite
 * conservative — only the base_url is touched.
 */
export async function patchAdminConfig(
  token: string,
  opts: {
    owner: string;
    repo: string;
    branch: string;
    /** Full https URL of the sveltia-auth worker, e.g. https://auth.easel.rosematcha.com */
    authBaseUrl: string;
  },
): Promise<void> {
  const path = 'public/admin/config.yml';
  const fileUrl = `${GH_API}/repos/${opts.owner}/${opts.repo}/contents/${path}?ref=${opts.branch}`;

  const getRes = await fetch(fileUrl, { headers: authHeaders(token) });
  if (!getRes.ok) {
    // If the template lacks the file yet, skip rather than fail the whole run.
    if (getRes.status === 404) return;
    throw new Error(`read config.yml failed (${getRes.status})`);
  }
  const file = (await getRes.json()) as { content: string; sha: string; encoding: string };
  const current = decodeBase64(file.content);
  const updated = setBaseUrl(current, opts.authBaseUrl);
  if (updated === current) return; // already correct — no commit needed

  const putRes = await fetch(`${GH_API}/repos/${opts.owner}/${opts.repo}/contents/${path}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({
      message: 'chore(easel): point Sveltia auth at the shared relay',
      content: encodeBase64(updated),
      sha: file.sha,
      branch: opts.branch,
    }),
  });
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`write config.yml failed (${putRes.status}): ${body}`);
  }
}

/** Rewrite (or insert) `base_url:` under the `backend:` block. */
function setBaseUrl(yaml: string, baseUrl: string): string {
  if (/^\s*base_url:\s*.*$/m.test(yaml)) {
    return yaml.replace(/^(\s*)base_url:\s*.*$/m, `$1base_url: ${baseUrl}`);
  }
  // Insert right after the `backend:` line, preserving its indentation + 2.
  return yaml.replace(/^(\s*)backend:\s*$/m, `$1backend:\n$1  base_url: ${baseUrl}`);
}

function decodeBase64(b64: string): string {
  const clean = b64.replace(/\n/g, '');
  const bin = atob(clean);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
