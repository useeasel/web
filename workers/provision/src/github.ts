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
    templateOwner: string; // 'useeasel'
    templateRepo: string; // 'template'
    owner: string; // artist's login
    name: string; // base repo name; a numeric suffix is added if it's taken
    description?: string;
  },
): Promise<GeneratedRepo> {
  // Try the base name, then name-2, name-3, ... so a leftover repo from an
  // earlier (failed) attempt doesn't block a retry.
  for (let attempt = 1; attempt <= 6; attempt++) {
    const name = attempt === 1 ? opts.name : `${opts.name}-${attempt}`;
    const res = await fetch(
      `${GH_API}/repos/${opts.templateOwner}/${opts.templateRepo}/generate`,
      {
        method: 'POST',
        headers: { ...authHeaders(token), Accept: 'application/vnd.github+json' },
        body: JSON.stringify({
          owner: opts.owner,
          name,
          description: opts.description ?? 'My portfolio, made with Easel.',
          private: false,
          include_all_branches: false,
        }),
      },
    );

    if (res.ok) {
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

    const body = await res.text();
    // 422 = name already exists on this account; try the next suffix.
    if (res.status === 422 && /already exists/i.test(body)) continue;
    throw new Error(`generate-from-template failed (${res.status}): ${body}`);
  }
  throw new Error('generate-from-template failed: no free repo name after 6 attempts');
}

/**
 * Step (d): patch the new repo's `public/admin/config.json` so the Easel editor
 * points at the artist's own repo and our shared auth relay (replacing the
 * shipped REPLACED_AT_PROVISION placeholder).
 */
export async function patchAdminConfig(
  token: string,
  opts: {
    owner: string;
    repo: string;
    branch: string;
    /** Full https URL of the auth worker, e.g. https://auth.easel.rosematcha.com */
    authBaseUrl: string;
  },
): Promise<void> {
  const path = 'public/admin/config.json';
  const fileUrl = `${GH_API}/repos/${opts.owner}/${opts.repo}/contents/${path}?ref=${opts.branch}`;

  // generate-from-template populates the new repo's contents asynchronously, so an
  // immediate read can 404 even though the file ships in the template. Retry with
  // backoff before giving up — a missed patch here leaves the artist's /admin stuck
  // on the REPLACED_AT_PROVISION placeholder (a dead end in the editor).
  let file: { content: string; sha: string } | null = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const getRes = await fetch(fileUrl, { headers: authHeaders(token) });
    if (getRes.ok) {
      file = (await getRes.json()) as { content: string; sha: string };
      break;
    }
    if (getRes.status === 404 && attempt < 6) {
      await sleep(2000);
      continue;
    }
    throw new Error(`read config.json failed (${getRes.status}) after ${attempt} attempt(s)`);
  }
  if (!file) throw new Error('read config.json failed: file never appeared');

  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(decodeBase64(file.content));
  } catch {
    /* corrupt/empty — overwrite with a fresh config */
  }
  cfg.repo = `${opts.owner}/${opts.repo}`;
  cfg.branch = opts.branch;
  cfg.authBaseUrl = opts.authBaseUrl;
  const updated = JSON.stringify(cfg, null, 2) + '\n';

  const putRes = await fetch(`${GH_API}/repos/${opts.owner}/${opts.repo}/contents/${path}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify({
      message: 'chore(easel): point the editor at this repo and the auth relay',
      content: encodeBase64(updated),
      sha: file.sha,
      branch: opts.branch,
    }),
  });
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`write config.json failed (${putRes.status}): ${body}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
