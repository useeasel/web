/**
 * Easel shared GitHub OAuth relay for the editor.
 *
 * One deployment serves the editor login for EVERY artist site. Each generated
 * template repo's `public/admin/config.json` sets `authBaseUrl` to this worker's
 * origin, so when an artist opens /admin and clicks "Sign in with GitHub" the
 * handshake routes through here. This replaces the sunset Netlify Identity.
 *
 *   GET /auth      → redirect to GitHub authorize, with signed state
 *   GET /callback  → exchange code → token, then 302 the popup back to the artist
 *                    site carrying the token in a URL fragment (#easel_token=...).
 *
 * Why a redirect and not window.opener.postMessage: the popup lives on a
 * different origin from the editor that opened it, and cross-origin
 * `window.opener` is unreliable — Firefox (state partitioning) and Safari/WebKit
 * (anti-tracking) sever or wall off the opener for cross-origin OAuth popups with
 * no COOP header involved, which strands the token in the popup forever ("popup
 * stuck on 'Completing sign-in…'"). Redirecting back to the artist's OWN origin
 * lets the editor pick the token up over a same-origin channel (localStorage +
 * BroadcastChannel), which every engine treats as first-party. The token only
 * ever rides a fragment to a verified Easel origin, so its trust boundary is
 * unchanged — see resolveTargetOrigin (fail-closed) below.
 *
 * Required secrets (wrangler secret put ...):
 *   SVELTIA_GITHUB_CLIENT_ID
 *   SVELTIA_GITHUB_CLIENT_SECRET
 * Optional var:
 *   ALLOWED_ORIGINS  comma-separated list (e.g. "*.netlify.app,easel.rosematcha.com")
 *                    fast-path allowlist of origins that may receive the token.
 */

export interface Env {
  SVELTIA_GITHUB_CLIENT_ID: string;
  SVELTIA_GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGINS?: string;
}

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const PROVIDER = 'github';

// Cleared on every terminal response so a stale nonce can't linger.
const CLEAR_STATE_COOKIE =
  'sveltia_state=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/auth') return handleAuth(url, env);
    if (url.pathname === '/callback') return handleCallback(request, url, env);

    // A bare GET to / is handy as a health check.
    if (url.pathname === '/') {
      return new Response('Easel auth relay. Use /auth to begin.', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    return new Response('Not found', { status: 404 });
  },
};

/** Step 1: kick off the GitHub OAuth dance. */
function handleAuth(url: URL, env: Env): Response {
  // The editor passes ?provider=github (and may pass &site_id=, &scope=, &redirect_uri=).
  const provider = url.searchParams.get('provider') ?? PROVIDER;
  if (provider !== PROVIDER) {
    return new Response(`Unsupported provider: ${provider}`, { status: 400 });
  }

  // CSRF state, echoed back on the callback. We stash the requesting site_id (for the
  // trust check) and redirect_uri (where to send the popup back) inside it, since GitHub
  // only round-trips `state`.
  const siteId = url.searchParams.get('site_id') ?? '';
  const redirectUri = url.searchParams.get('redirect_uri') ?? '';
  const nonce = crypto.randomUUID();
  const state = btoa(JSON.stringify({ nonce, siteId, redirectUri }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.searchParams.set('client_id', env.SVELTIA_GITHUB_CLIENT_ID);
  // `repo` is required so the editor can commit to the artist's repo.
  authorize.searchParams.set('scope', url.searchParams.get('scope') ?? 'repo,user');
  authorize.searchParams.set('state', state);

  // Stash the state in a short-lived, http-only cookie so /callback can verify it.
  // SameSite=None (with Secure) because this cookie is set and read across a cross-site
  // popup round-trip (artist origin → relay → GitHub → relay); Lax is brittle there.
  const headers = new Headers({ Location: authorize.toString() });
  headers.append(
    'Set-Cookie',
    `sveltia_state=${state}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=600`,
  );
  return new Response(null, { status: 302, headers });
}

/** Step 2: exchange the code and hand the token back to the artist site. */
async function handleCallback(request: Request, url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';

  // Verify state against the http-only cookie we set in /auth (CSRF guard).
  const cookieState = readCookie(request, 'sveltia_state');
  if (!code || !state || state !== cookieState) {
    return renderError('Invalid OAuth state.');
  }

  let siteId = '';
  let redirectUri = '';
  try {
    const decoded = JSON.parse(
      atob(state.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { siteId?: string; redirectUri?: string };
    siteId = decoded.siteId ?? '';
    redirectUri = decoded.redirectUri ?? '';
  } catch {
    /* malformed state — handled by the fail-closed check below */
  }

  // Fail closed: only ever hand a repo-scoped token to an origin we can verify is a real
  // Easel site. A missing/untrusted origin gets a dead-end page (renderError) and NO token.
  // Custom domains (which artists set up in Netlify — Easel never manages DNS) and GitHub
  // Pages sites are recognised without an allowlist edit: the resolver fetches the origin's
  // /admin/config.json and trusts it only if its authBaseUrl points back at this relay.
  // Resolved BEFORE the code exchange so an untrusted opener never even triggers a mint.
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

  // Backward compatibility: editors that don't send `redirect_uri` are on the old build that
  // expects the window.opener postMessage handshake — keep serving them that page so a worker
  // deploy doesn't break already-provisioned sites that haven't pulled the template update
  // yet. New editors send redirect_uri and get the robust same-origin redirect.
  if (!redirectUri) {
    if (!data.access_token) {
      return renderResult('error', { message: data.error_description ?? 'No token.' }, targetOrigin);
    }
    return renderResult('success', { token: data.access_token, provider: PROVIDER }, targetOrigin);
  }

  // Where to send the popup back to — always on the verified origin (never off it).
  const returnUrl = safeReturnUrl(redirectUri, targetOrigin);
  if (!data.access_token) {
    return redirectBack(returnUrl, 'easel_auth_error', data.error_description ?? 'No token.');
  }
  return redirectBack(returnUrl, 'easel_token', data.access_token);
}

/**
 * Build the trusted return URL for the popup. Uses the editor-supplied redirect_uri only
 * when it sits on the verified origin (so we never redirect a token off it); otherwise
 * falls back to the conventional `<origin>/admin/`. Any incoming query/fragment is dropped.
 */
function safeReturnUrl(redirectUri: string, targetOrigin: string): string {
  if (redirectUri) {
    try {
      const u = new URL(redirectUri);
      if (u.origin === targetOrigin) {
        u.search = '';
        u.hash = '';
        return u.toString();
      }
    } catch {
      /* fall through to the default below */
    }
  }
  return `${targetOrigin}/admin/`;
}

/**
 * 302 the popup back to the artist site with the result in a URL fragment. A fragment is
 * never sent to the destination server (so the token stays out of access logs and Referer);
 * the editor's inline handler reads it and strips it immediately.
 */
function redirectBack(returnUrl: string, key: string, value: string): Response {
  const location = `${returnUrl}#${key}=${encodeURIComponent(value)}`;
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Set-Cookie': CLEAR_STATE_COOKIE },
  });
}

/**
 * LEGACY popup→opener postMessage page, kept only for editors that predate the redirect flow
 * (they don't send `redirect_uri`). The two-message Decap/Sveltia handshake: announce
 * `authorizing:github`, then reply with `authorization:github:<success|error>:<json>` when
 * the opener pings back. Re-announces and replies idempotently to survive a lost message.
 * New editors never reach this — they get redirectBack() instead (robust across browsers
 * that wall off cross-origin window.opener).
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
    window.opener && window.opener.postMessage(MESSAGE, TARGET);
  }
  window.addEventListener('message', receiveMessage, false);
  function announce() {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage('authorizing:${PROVIDER}', TARGET);
    }
  }
  announce();
  var tries = 0;
  var timer = setInterval(function () {
    if (!window.opener || window.opener.closed || ++tries > 240) {
      clearInterval(timer);
      return;
    }
    announce();
  }, 500);
})();
</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': CLEAR_STATE_COOKIE,
    },
  });
}

/**
 * A standalone dead-end page for failures that happen before we have a trusted target
 * origin (bad CSRF state, untrusted/missing site origin). It deliberately delivers nothing
 * back to any window — there is no safe origin to talk to — so a token can never leak to an
 * unverified opener.
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
      'Set-Cookie': CLEAR_STATE_COOKIE,
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
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
 * Resolve the return target to a concrete, trusted origin — or null if we can't, so the
 * caller fails closed. Trust is established in order:
 *   1. ALLOWED_ORIGINS match (fast path; default covers `*.netlify.app`), or
 *   2. the origin hosts an Easel site whose /admin/config.json delegates auth back to this
 *      very relay (`authBaseUrl` === our origin). This lets artist custom domains and
 *      GitHub Pages sites sign in without us maintaining an allowlist of them.
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

  // Not on the allowlist — accept it only if it proves itself an Easel site that delegates
  // auth to us. Defeats a drive-by opener that just sets its own site_id.
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
