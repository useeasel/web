/**
 * Easel shared Sveltia CMS GitHub OAuth relay.
 *
 * One deployment serves the editor login for EVERY artist site. Each generated
 * template repo's `public/admin/config.yml` sets `backend.base_url` to this
 * worker's origin, so when an artist opens /admin and clicks "Login with GitHub"
 * the handshake routes through here. This replaces the sunset Netlify Identity.
 *
 * Follows the well-known `sveltia-cms-auth` / `decap-cms`-compatible pattern:
 *   GET /auth      → redirect to GitHub authorize (scope `repo`), with state
 *   GET /callback  → exchange code → token, postMessage it back to the opener
 *
 * Required secrets (wrangler secret put ...):
 *   SVELTIA_GITHUB_CLIENT_ID
 *   SVELTIA_GITHUB_CLIENT_SECRET
 * Optional var:
 *   ALLOWED_ORIGINS  comma-separated list (e.g. "*.netlify.app,easel.rosematcha.com")
 *                    used to restrict which sites may receive the token postMessage.
 */

export interface Env {
  SVELTIA_GITHUB_CLIENT_ID: string;
  SVELTIA_GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGINS?: string;
}

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const PROVIDER = 'github';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/auth') return handleAuth(url, env);
    if (url.pathname === '/callback') return handleCallback(request, url, env);

    // A bare GET to / is handy as a health check.
    if (url.pathname === '/') {
      return new Response('Easel Sveltia auth relay. Use /auth to begin.', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
};

/** Step 1: kick off the GitHub OAuth dance. */
function handleAuth(url: URL, env: Env): Response {
  // Sveltia/Decap pass ?provider=github (and may pass &site_id=, &scope=).
  const provider = url.searchParams.get('provider') ?? PROVIDER;
  if (provider !== PROVIDER) {
    return new Response(`Unsupported provider: ${provider}`, { status: 400 });
  }

  // CSRF state, echoed back on the callback. We stash the requesting site_id in
  // it so the callback can target the postMessage at the right origin.
  const siteId = url.searchParams.get('site_id') ?? '';
  const nonce = crypto.randomUUID();
  const state = btoa(JSON.stringify({ nonce, siteId }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.searchParams.set('client_id', env.SVELTIA_GITHUB_CLIENT_ID);
  // `repo` is required so the editor can commit to the artist's repo.
  authorize.searchParams.set('scope', url.searchParams.get('scope') ?? 'repo,user');
  authorize.searchParams.set('state', state);

  // Set the state in a short-lived, http-only cookie so /callback can verify it.
  const headers = new Headers({ Location: authorize.toString() });
  headers.append(
    'Set-Cookie',
    `sveltia_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
  );
  return new Response(null, { status: 302, headers });
}

/** Step 2: exchange the code and hand the token to the opener window. */
async function handleCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';

  // Verify state against the http-only cookie we set in /auth (CSRF guard).
  const cookieState = readCookie(request, 'sveltia_state');
  if (!code || !state || state !== cookieState) {
    return renderResult('error', { message: 'Invalid OAuth state.' }, '*');
  }

  let siteId = '';
  try {
    const decoded = JSON.parse(
      atob(state.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { siteId?: string };
    siteId = decoded.siteId ?? '';
  } catch {
    /* tolerate missing siteId — fall back to wildcard target */
  }

  const targetOrigin = resolveTargetOrigin(siteId, env);

  const res = await fetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.SVELTIA_GITHUB_CLIENT_ID,
      client_secret: env.SVELTIA_GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string };

  if (!data.access_token) {
    return renderResult('error', { message: data.error_description ?? 'No token.' }, targetOrigin);
  }
  return renderResult('success', { token: data.access_token, provider: PROVIDER }, targetOrigin);
}

/**
 * The Sveltia/Decap handshake: the popup posts a two-message sequence to its
 * opener. First an "authorizing" handshake, then the result payload as
 *   authorization:github:<success|error>:<json>
 */
function renderResult(
  kind: 'success' | 'error',
  payload: Record<string, unknown>,
  targetOrigin: string,
): Response {
  const message = `authorization:${PROVIDER}:${kind}:${JSON.stringify(payload)}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Authorizing…</title></head>
<body>
<p>Completing sign-in… you can close this window.</p>
<script>
(function () {
  var TARGET = ${JSON.stringify(targetOrigin)};
  var MESSAGE = ${JSON.stringify(message)};
  function receiveMessage(e) {
    // The opener pings us first; reply with the result, then clean up.
    window.opener && window.opener.postMessage(MESSAGE, TARGET === '*' ? e.origin : TARGET);
    window.removeEventListener('message', receiveMessage, false);
  }
  window.addEventListener('message', receiveMessage, false);
  // Announce we're ready so the opener (Sveltia) knows to ping back.
  window.opener && window.opener.postMessage('authorizing:${PROVIDER}', TARGET);
})();
</script>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Clear the state cookie now that the handshake is done.
      'Set-Cookie': 'sveltia_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    },
  });
}

/** Read a single cookie value from the request's Cookie header. */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** Restrict the postMessage target to an allowed origin when configured. */
function resolveTargetOrigin(siteId: string, env: Env): string {
  if (!siteId) return '*';
  let origin: string;
  try {
    origin = new URL(siteId.startsWith('http') ? siteId : `https://${siteId}`).origin;
  } catch {
    return '*';
  }
  const allow = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return origin; // no allowlist configured → trust resolved origin
  const host = new URL(origin).hostname;
  const ok = allow.some((pat) =>
    pat.startsWith('*.') ? host.endsWith(pat.slice(1)) : host === pat,
  );
  return ok ? origin : '*';
}
