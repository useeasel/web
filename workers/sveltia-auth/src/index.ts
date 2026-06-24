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
    return renderError('Invalid OAuth state.');
  }

  let siteId = '';
  try {
    const decoded = JSON.parse(
      atob(state.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { siteId?: string };
    siteId = decoded.siteId ?? '';
  } catch {
    /* malformed state — handled by the fail-closed check below */
  }

  // Fail closed: only ever hand a repo-scoped token to an origin we can verify is a
  // real Easel site. A missing/untrusted origin used to fall back to a '*'
  // postMessage target, which would leak the token to whatever window opened the
  // popup. We now refuse rather than wildcard. Custom domains (which artists set up
  // in Netlify — Easel never manages DNS) are recognised without any allowlist edit:
  // the resolver fetches the origin's /admin/config.json and trusts it only if its
  // authBaseUrl points back at this relay. Resolved BEFORE the code exchange so an
  // untrusted opener never even triggers a token mint.
  const targetOrigin = await resolveTargetOrigin(siteId, env, url.origin);
  if (!targetOrigin) {
    return renderError(
      siteId
        ? `This site (${siteId}) is not an allowed Easel editor origin.`
        : 'Missing site origin; cannot complete sign-in securely.',
    );
  }

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
 * A standalone error page for failures that happen before we have a trusted target
 * origin (bad CSRF state, untrusted/missing site origin). It deliberately does NOT
 * postMessage anything — there is no safe window to talk to — so a token can never
 * leak to an unverified opener.
 */
function renderError(message: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>Sign-in couldn't complete</h1>
<p>${escapeHtml(message)}</p>
<p>You can close this window and try again.</p>
</body></html>`;
  return new Response(html, {
    status: 400,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'sveltia_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
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
    // The opener pings us first; reply with the result, then clean up. TARGET is
    // always a concrete, allowlisted origin (never '*') so the token can't be
    // delivered to an unexpected window.
    window.opener && window.opener.postMessage(MESSAGE, TARGET);
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

/**
 * Resolve the postMessage target to a concrete, trusted origin — or null if we
 * can't, so the caller fails closed. Trust is established in order:
 *   1. ALLOWED_ORIGINS match (fast path; default covers `*.netlify.app`), or
 *   2. the origin hosts an Easel site whose /admin/config.json delegates auth back
 *      to this very relay (`authBaseUrl` === our origin). This lets artist custom
 *      domains — which are configured in Netlify, never managed by Easel — sign in
 *      without us maintaining an allowlist of them.
 * Returns null (never '*') when the origin is missing, unparseable, or unverified.
 */
async function resolveTargetOrigin(
  siteId: string,
  env: Env,
  relayOrigin: string,
): Promise<string | null> {
  if (!siteId) return null;
  let origin: string;
  try {
    origin = new URL(siteId.startsWith('http') ? siteId : `https://${siteId}`).origin;
  } catch {
    return null;
  }

  const allow = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return origin; // no allowlist configured → trust resolved origin
  const host = new URL(origin).hostname;
  const allowed = allow.some((pat) =>
    pat.startsWith('*.') ? host.endsWith(pat.slice(1)) : host === pat,
  );
  if (allowed) return origin;

  // Not on the allowlist — accept it only if it proves itself an Easel site that
  // delegates auth to us. Defeats a drive-by opener that just sets its own site_id.
  return (await originDelegatesToRelay(origin, relayOrigin)) ? origin : null;
}

/** True if `${origin}/admin/config.json` exists and its authBaseUrl is this relay. */
async function originDelegatesToRelay(origin: string, relayOrigin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/admin/config.json`, {
      headers: { Accept: 'application/json' },
      // A site that's down or slow shouldn't hang the popup indefinitely.
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) return false;
    const cfg = (await res.json()) as { authBaseUrl?: string };
    if (!cfg.authBaseUrl) return false;
    return new URL(cfg.authBaseUrl).origin === relayOrigin;
  } catch {
    return false;
  }
}
