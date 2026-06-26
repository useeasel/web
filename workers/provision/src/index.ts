/**
 * Easel provisioning Worker.
 *
 * Orchestrates the two-click onboarding: GitHub + Netlify OAuth, then generates
 * the artist's repo from easel/template and stands up their Netlify site. Easel
 * never stores long-lived tokens — they live in KV for one run (10-min TTL) and
 * are deleted on completion.
 *
 * Routes:
 *   GET  /auth/github       → redirect to GitHub OAuth (scope public_repo)
 *   GET  /auth/github/cb    → code→token; stash under signed state; back to /start
 *   GET  /auth/netlify      → redirect to Netlify OAuth
 *   GET  /auth/netlify/cb   → code→token; stash under same state; back to /start
 *   POST /provision         → run the 5 provisioning steps, return result
 *
 * Required secrets (wrangler secret put ...):
 *   GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET
 *   NETLIFY_OAUTH_CLIENT_ID, NETLIFY_OAUTH_CLIENT_SECRET
 *   STATE_SIGNING_KEY        (HMAC key for OAuth state)
 * Vars (wrangler.toml [vars]):
 *   APP_ORIGIN               (the marketing site, e.g. https://easel.rosematcha.com)
 *   WORKER_ORIGIN            (this worker's public origin, for OAuth redirect_uri)
 *   SVELTIA_AUTH_URL         (the sveltia-auth relay origin)
 *   TEMPLATE_OWNER           (default 'easel'),  TEMPLATE_REPO (default 'template')
 * Bindings:
 *   EASEL_STATE              (KV namespace for transient session/tokens)
 */

import { createState, verifyState, loadSession, saveSession, clearSession } from './state';
import {
  githubAuthorizeUrl,
  exchangeGithubCode,
  getGithubUser,
  generateRepoFromTemplate,
  patchAdminConfig,
  getTemplateVersion,
} from './github';
import { sendCompletionEmail } from './email';
import { netlifyAuthorizeUrl, exchangeNetlifyCode, netlifyProvider } from './netlify';
import { githubPagesProvider } from './hosts/github-pages';
import {
  isHostId,
  type DeployState,
  type HostId,
  type HostProvider,
  type ProvisionTokens,
  type SiteHandle,
} from './hosts/types';
import { isRateLimited, clientIp, trackEvent } from './limits';

/** The hosts an artist can publish to, keyed by id. */
const HOSTS: Record<HostId, HostProvider> = {
  netlify: netlifyProvider,
  'github-pages': githubPagesProvider,
};

/** Resolve a (possibly untrusted) provider string to a host, defaulting to Netlify. */
function resolveHost(provider?: string): HostProvider {
  return isHostId(provider) ? HOSTS[provider] : netlifyProvider;
}

export interface Env {
  EASEL_STATE: KVNamespace;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  NETLIFY_OAUTH_CLIENT_ID: string;
  NETLIFY_OAUTH_CLIENT_SECRET: string;
  STATE_SIGNING_KEY: string;
  APP_ORIGIN: string;
  WORKER_ORIGIN: string;
  SVELTIA_AUTH_URL: string;
  TEMPLATE_OWNER?: string;
  TEMPLATE_REPO?: string;
  /** Optional: enables the completion email when both are set (see email.ts). */
  RESEND_API_KEY?: string;
  EASEL_FROM_EMAIL?: string;
}

type StageState = 'pending' | 'active' | 'done' | 'error';

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.APP_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(body: unknown, env: Env, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

/** Send the artist back to /start with the next step + state (+ optional extras). */
function redirectToStart(
  env: Env,
  step: string,
  state: string,
  extra?: Record<string, string>,
): Response {
  const u = new URL('/start/', env.APP_ORIGIN);
  u.searchParams.set('step', step);
  u.searchParams.set('state', state);
  for (const [k, v] of Object.entries(extra ?? {})) u.searchParams.set(k, v);
  return Response.redirect(u.toString(), 302);
}

function redirectToStartError(env: Env, reason: string): Response {
  const u = new URL('/start/', env.APP_ORIGIN);
  u.searchParams.set('error', reason);
  return Response.redirect(u.toString(), 302);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // Throttle the flow-initiating + work-doing endpoints per IP so a script can't
    // spam repo generation against the org. The OAuth *callbacks* are not limited —
    // they carry a signed state and blocking them would strand a legit run midway.
    const isSensitive =
      (pathname === '/auth/github' && request.method === 'GET') ||
      (pathname === '/auth/netlify' && request.method === 'GET') ||
      (pathname === '/provision' && request.method === 'POST');
    if (isSensitive) {
      const limited = await isRateLimited(
        env.EASEL_STATE,
        `${clientIp(request)}:${pathname}`,
        // ~10 starts/min per IP — generous for a human, useless for a flood.
        10,
        60,
      );
      if (limited) {
        await trackEvent(env.EASEL_STATE, 'rate_limited', { path: pathname });
        return json({ status: 'error', message: 'rate_limited' }, env, 429);
      }
    }

    try {
      // ---- Step 1: GitHub OAuth ----
      if (pathname === '/auth/github' && request.method === 'GET') {
        const state = await createState(env.STATE_SIGNING_KEY);
        await saveSession(env.EASEL_STATE, state, {}); // reserve the session slot
        return Response.redirect(
          githubAuthorizeUrl({
            clientId: env.GITHUB_OAUTH_CLIENT_ID,
            redirectUri: `${env.WORKER_ORIGIN}/auth/github/cb`,
            state,
          }),
          302,
        );
      }

      if (pathname === '/auth/github/cb' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state') ?? '';
        if (!code || !(await verifyState(state, env.STATE_SIGNING_KEY))) {
          return redirectToStartError(env, 'github_state');
        }
        const token = await exchangeGithubCode(
          { clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET },
          code,
          `${env.WORKER_ORIGIN}/auth/github/cb`,
        );
        const user = await getGithubUser(token);
        await saveSession(env.EASEL_STATE, state, {
          githubToken: token,
          githubLogin: user.login,
          ...(user.email ? { email: user.email } : {}),
        });
        return redirectToStart(env, 'netlify', state, { login: user.login });
      }

      // ---- Step 2: Netlify OAuth ----
      if (pathname === '/auth/netlify' && request.method === 'GET') {
        const state = url.searchParams.get('state') ?? '';
        const siteName = url.searchParams.get('site') ?? '';
        if (!(await verifyState(state, env.STATE_SIGNING_KEY))) {
          return redirectToStartError(env, 'netlify_state');
        }
        // The GitHub step must have run first.
        const sess = await loadSession(env.EASEL_STATE, state);
        if (!sess?.githubToken) return redirectToStartError(env, 'github_required');
        if (siteName) await saveSession(env.EASEL_STATE, state, { siteName });
        return Response.redirect(
          netlifyAuthorizeUrl({
            clientId: env.NETLIFY_OAUTH_CLIENT_ID,
            redirectUri: `${env.WORKER_ORIGIN}/auth/netlify/cb`,
            state,
          }),
          302,
        );
      }

      if (pathname === '/auth/netlify/cb' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state') ?? '';
        if (!code || !(await verifyState(state, env.STATE_SIGNING_KEY))) {
          return redirectToStartError(env, 'netlify_state');
        }
        const token = await exchangeNetlifyCode(
          { clientId: env.NETLIFY_OAUTH_CLIENT_ID, clientSecret: env.NETLIFY_OAUTH_CLIENT_SECRET },
          code,
          `${env.WORKER_ORIGIN}/auth/netlify/cb`,
        );
        await saveSession(env.EASEL_STATE, state, { netlifyToken: token });
        return redirectToStart(env, 'provision', state);
      }

      // ---- Session status ----
      // The /start UI calls this on load to reconcile its sessionStorage flags
      // against the real, server-side truth: which tokens still live in KV for
      // this run. KV entries carry a 10-minute TTL, so a flag the browser kept
      // from a prior visit (reload, back-button, or session-restore) is only
      // trusted if the worker confirms the token is actually still here.
      if (pathname === '/session' && request.method === 'GET') {
        const state = url.searchParams.get('state') ?? '';
        if (!state || !(await verifyState(state, env.STATE_SIGNING_KEY))) {
          return json({ github: false, netlify: false, githubLogin: null }, env);
        }
        const sess = await loadSession(env.EASEL_STATE, state);
        return json(
          {
            github: !!sess?.githubToken,
            netlify: !!sess?.netlifyToken,
            githubLogin: sess?.githubLogin ?? null,
          },
          env,
        );
      }

      // ---- Step 3: Provision ----
      // POST starts the run in the background and returns a jobId immediately;
      // the client polls GET /provision?job=<id> for live per-stage progress.
      if (pathname === '/provision' && request.method === 'POST') {
        return await startProvision(request, env, ctx);
      }
      if (pathname === '/provision' && request.method === 'GET') {
        const jobId = url.searchParams.get('job') ?? '';
        let job = (await env.EASEL_STATE.get(`job:${jobId}`, 'json')) as JobRecord | null;
        if (!job) return json({ status: 'unknown' }, env, 404);
        // If the background job handed off the deploy wait, advance it from this
        // client poll: check the live Netlify deploy and finalize once it's ready
        // (or surface a failed build). This is what keeps us from declaring the
        // site live before Netlify has actually finished.
        if (job.status === 'running' && job.awaitingDeploy) {
          job = await reconcileDeploy(env, jobId, job);
        }
        return json(job, env);
      }

      return json({ error: 'not_found' }, env, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unexpected_error';
      return json({ status: 'error', message }, env, 500);
    }
  },
};

interface JobRecord {
  status: 'running' | 'done' | 'error';
  stages: Record<string, StageState>;
  message?: string;
  /** Non-fatal note surfaced to the artist (e.g. CD connection unconfirmed). */
  warning?: string;
  siteUrl?: string;
  adminUrl?: string;
  repoUrl?: string;
  /** Which host this site was published to; defaults to netlify for older jobs. */
  provider?: HostId;
  /** Netlify project slug (e.g. 'radiant-nasturtium-ed9625'), for dashboard links. */
  netlifyName?: string;
  /** Host dashboard slug (Netlify project slug / GitHub repo name) for deep-links. */
  dashboardSlug?: string;
  /** Netlify site id, recorded so the deploy can be reconciled after handoff. */
  siteId?: string;
  /** Repo coordinates, recorded so a Pages deploy can be reconciled after handoff. */
  repoOwner?: string;
  repoName?: string;
  /**
   * Set when the background job's bounded deploy poll timed out with the build
   * still running, handing the wait to the client. While true, GET /provision
   * checks the live deploy state on each poll and finalizes once it's ready.
   */
  awaitingDeploy?: boolean;
}

const JOB_TTL = 900; // 15 minutes

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll the site's latest deploy until it's ready/errored or a bounded window
 * (~60s) elapses. A fast-failing build (bad install/config) usually errors well
 * inside this window; a slow-but-fine build simply returns 'building' and the run
 * completes optimistically.
 */
async function pollDeploy(
  host: HostProvider,
  tokens: ProvisionTokens,
  site: SiteHandle,
): Promise<DeployState> {
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const s = await host.getDeployState({ tokens, site });
    if (s === 'ready' || s === 'error') return s;
  }
  return 'building';
}

/** Host-specific "first build failed" copy, pointing at the right place to look. */
function buildFailedMessage(host: HostId): string {
  return host === 'github-pages'
    ? 'The first build failed on GitHub Pages. Open the Actions tab in your repo to see the build log.'
    : 'The first build failed on Netlify. Open your Netlify dashboard to see the build log.';
}

/** Rebuild a host site handle from a persisted job, for the client-driven deploy wait. */
function siteFromJob(job: JobRecord): SiteHandle {
  return {
    siteUrl: job.siteUrl ?? '',
    adminUrl: job.adminUrl ?? '',
    siteId: job.siteId,
    dashboardSlug: job.dashboardSlug,
    repoOwner: job.repoOwner,
    repoName: job.repoName,
  };
}

async function setJob(env: Env, jobId: string, job: JobRecord): Promise<void> {
  await env.EASEL_STATE.put(`job:${jobId}`, JSON.stringify(job), { expirationTtl: JOB_TTL });
}

/**
 * Start a provisioning run in the background and return a jobId immediately. The
 * actual work runs in ctx.waitUntil() and reports per-stage progress to KV, which
 * the /start UI polls via GET /provision?job=<id> to keep the artist in the loop.
 */
async function startProvision(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const { state, email, provider } = (await request.json().catch(() => ({}))) as {
    state?: string;
    email?: string;
    provider?: string;
  };
  if (!state || !(await verifyState(state, env.STATE_SIGNING_KEY))) {
    return json({ status: 'error', message: 'invalid_state' }, env, 400);
  }
  const host = resolveHost(provider);
  // An explicit email from the UI takes precedence over the (often-absent) public
  // GitHub profile email captured at sign-in. Record the chosen host too so a later
  // client-driven deploy reconcile knows which host to poll.
  const patch: { email?: string; provider: string } = { provider: host.id };
  if (email && /.+@.+\..+/.test(email)) patch.email = email;
  await saveSession(env.EASEL_STATE, state, patch);

  // Idempotency: if a run for this state is already underway (or has finished),
  // return it instead of starting a duplicate. Without this, a double-click or a
  // mid-run "Try again" generates a second repo (portfolio-2) + Netlify site. This
  // is checked before the session lookup because a completed run has already
  // deleted its transient tokens. Only a hard-errored run is allowed to restart.
  const existing = (await env.EASEL_STATE.get(`job:${state}`, 'json')) as JobRecord | null;
  if (existing && existing.status !== 'error') {
    return json(
      { jobId: state, status: existing.status, stages: existing.stages },
      env,
    );
  }

  const sess = await loadSession(env.EASEL_STATE, state);
  // GitHub is always required; Netlify only when the chosen host needs it. GitHub
  // Pages publishes with the GitHub token already in hand — no second connection.
  if (!sess?.githubToken || !sess.githubLogin || (host.needsNetlify && !sess.netlifyToken)) {
    return json({ status: 'error', message: 'missing_connections' }, env, 400);
  }

  const job: JobRecord = {
    status: 'running',
    provider: host.id,
    stages: { repo: 'pending', site: 'pending', deploy: 'pending', admin: 'pending', cleanup: 'pending' },
  };
  await setJob(env, state, job);
  ctx.waitUntil(
    runProvisionJob(
      env,
      state,
      {
        githubToken: sess.githubToken,
        netlifyToken: sess.netlifyToken,
        githubLogin: sess.githubLogin,
        email: sess.email,
      },
      host,
      job,
    ),
  );

  return json({ jobId: state, status: 'running', stages: job.stages }, env);
}

/** The five provisioning steps, writing progress to KV after each transition. */
async function runProvisionJob(
  env: Env,
  state: string,
  sess: { githubToken: string; netlifyToken?: string; githubLogin: string; email?: string },
  host: HostProvider,
  job: JobRecord,
): Promise<void> {
  const tokens: ProvisionTokens = { githubToken: sess.githubToken, netlifyToken: sess.netlifyToken };
  const advance = async (stage: keyof JobRecord['stages'], to: StageState) => {
    job.stages[stage] = to;
    await setJob(env, state, job);
  };
  const fail = async (message: string, stage: keyof JobRecord['stages']) => {
    console.error(`[provision] stage=${String(stage)} failed: ${message}`);
    job.stages[stage] = 'error';
    job.status = 'error';
    job.message = message;
    await setJob(env, state, job);
    await trackEvent(env.EASEL_STATE, 'provision_failed', { stage: String(stage) });
  };

  await trackEvent(env.EASEL_STATE, 'provision_started');

  const templateOwner = env.TEMPLATE_OWNER ?? 'useeasel';
  const templateRepo = env.TEMPLATE_REPO ?? 'template';

  // (a) GitHub: generate repo from template ('portfolio', with suffix if taken).
  await advance('repo', 'active');
  let repo;
  try {
    repo = await generateRepoFromTemplate(sess.githubToken, {
      templateOwner,
      templateRepo,
      owner: sess.githubLogin,
      name: 'portfolio',
    });
    // Record the repo on the job immediately so that if a *later* stage fails, the
    // error response still hands the artist a link to what was created (instead of a
    // dead end). Recovery beats silent partial state.
    job.repoUrl = repo.htmlUrl;
    await advance('repo', 'done');
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'repo_failed', 'repo');
  }

  // (b) Point the new repo's admin config at this repo + the sveltia-auth relay,
  // BEFORE creating the Netlify site. This is the only commit we make during
  // provisioning, and doing it first means the repo's HEAD is already correct when
  // Netlify first builds it — so there's exactly one build of one commit. (Patching
  // *after* site creation pushed a second commit that the webhook rebuilt: two
  // serialized builds on the free tier, the first of them building the placeholder
  // config and the artist waiting through both.)
  await advance('admin', 'active');
  try {
    // Stamp the template version this site is born at, so the editor's "Update my
    // site" check has a baseline to compare against. Best-effort — a null just
    // means no baseline (the editor still offers the update).
    const easelVersion = await getTemplateVersion(sess.githubToken, {
      owner: templateOwner,
      repo: templateRepo,
    });
    // On hosts without a native forms backend (GitHub Pages), point the template's
    // contact/newsletter forms at a no-account FormSubmit endpoint keyed to the
    // artist's email — free, and the email is one they already gave us. Netlify keeps
    // its native Forms (empty endpoint). Falls back to empty if we have no email.
    const formEndpoint =
      host.formBackend === 'formsubmit' && sess.email
        ? `https://formsubmit.co/${encodeURIComponent(sess.email)}`
        : '';
    await patchAdminConfig(sess.githubToken, {
      owner: repo.owner,
      repo: repo.name,
      branch: repo.defaultBranch,
      authBaseUrl: env.SVELTIA_AUTH_URL,
      easelVersion,
      host: host.id,
      formEndpoint,
    });
    await advance('admin', 'done');
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'admin_failed', 'admin');
  }

  // (c) Stand up the site on the chosen host. For Netlify this wires continuous
  // deployment with a deploy key + push webhook; for GitHub Pages it enables Pages
  // and commits the deploy workflow. Either way we get back a handle with the public
  // URL and whatever the deploy poll needs to reconcile later.
  await advance('site', 'active');
  let site: SiteHandle;
  try {
    site = await host.createSite({ tokens, repo, email: sess.email });
    // Surface the site/admin links (and a soft CD warning, if any) even if a later
    // stage fails, so the artist isn't left wondering what happened.
    job.siteUrl = site.siteUrl;
    job.adminUrl = site.adminUrl;
    job.dashboardSlug = site.dashboardSlug;
    if (host.id === 'netlify') job.netlifyName = site.dashboardSlug;
    job.siteId = site.siteId;
    job.repoOwner = site.repoOwner;
    job.repoName = site.repoName;
    if (site.warning) job.warning = site.warning;
    await advance('site', 'done');
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'site_failed', 'site');
  }

  // (d) Kick the first build. Netlify needs an explicit trigger; GitHub Pages already
  // started building when the workflow commit pushed, so its provider has no
  // triggerBuild and this is a no-op.
  await advance('deploy', 'active');
  try {
    if (host.triggerBuild) await host.triggerBuild({ tokens, site });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'deploy_failed', 'deploy');
  }

  // (d, verify) Wait for the first deploy so we never declare the site live before
  // the host has actually finished. We poll for a bounded window here so the common
  // (fast) build is confirmed server-side — the completion email then fires even if
  // the artist closed the tab. If the build outlasts the window, we hand the wait
  // off to the client (awaitingDeploy) rather than risk this best-effort waitUntil
  // job being evicted mid-wait; the reconciling GET handler finishes it from the
  // client's polls. The site coordinates were recorded in the site stage above so
  // either path can poll the deploy.
  let deployState: DeployState = 'building';
  try {
    deployState = await pollDeploy(host, tokens, site);
  } catch {
    /* polling hiccup — fall through to the client handoff below */
  }
  if (deployState === 'error') {
    return fail(buildFailedMessage(host.id), 'deploy');
  }
  if (deployState !== 'ready') {
    // Still building after the safe window — let the client finish the wait. The
    // deploy stage stays 'active' (pulsing) until GET /provision confirms 'ready'.
    job.awaitingDeploy = true;
    await setJob(env, state, job);
    return;
  }

  await completeJob(env, state, job);
}

/**
 * Finalize a run whose first deploy is live: mark deploy + cleanup done, drop the
 * transient tokens, and fire the best-effort completion email. Callable from either
 * the background job or the reconciling GET handler; no-ops if already terminal.
 *
 * The email is a no-op unless RESEND_API_KEY + EASEL_FROM_EMAIL are configured and
 * we have an address. It runs after the job is marked done so it can never affect
 * success.
 */
async function completeJob(env: Env, state: string, job: JobRecord): Promise<void> {
  if (job.status !== 'running') return; // already finalized by the other path
  job.stages.deploy = 'done';
  job.awaitingDeploy = false;
  job.stages.cleanup = 'active';
  await setJob(env, state, job);

  // (e) Read the email before clearing the session, then delete the transient tokens.
  const sess = await loadSession(env.EASEL_STATE, state);
  await clearSession(env.EASEL_STATE, state);
  job.stages.cleanup = 'done';
  job.status = 'done';
  await setJob(env, state, job);
  await trackEvent(env.EASEL_STATE, 'provision_done');

  if (sess?.email && job.siteUrl && job.adminUrl) {
    const sent = await sendCompletionEmail(env, {
      to: sess.email,
      siteUrl: job.siteUrl,
      adminUrl: job.adminUrl,
      repoUrl: job.repoUrl,
    });
    if (sent) await trackEvent(env.EASEL_STATE, 'completion_email_sent');
  }
}

/**
 * Client-driven deploy wait. Once the background job hands off (awaitingDeploy),
 * each client poll of GET /provision runs this: check the live deploy on the job's
 * host and finalize the moment it's ready (or surface a failed build). This carries
 * the wait past the worker's best-effort waitUntil window without claiming "ready"
 * early.
 */
async function reconcileDeploy(env: Env, state: string, job: JobRecord): Promise<JobRecord> {
  const host = resolveHost(job.provider);
  const sess = await loadSession(env.EASEL_STATE, state);
  // Each host polls with a different token: Netlify its OAuth token, Pages the GitHub
  // token. If the relevant one TTL'd out before the build finished (rare — we refresh
  // it on every poll below), don't strand the artist: treat the site as published.
  const tokenPresent = host.needsNetlify ? !!sess?.netlifyToken : !!sess?.githubToken;
  if (!sess?.githubToken || !tokenPresent) {
    await completeJob(env, state, job);
    return job;
  }
  const tokens: ProvisionTokens = { githubToken: sess.githubToken, netlifyToken: sess.netlifyToken };

  let deployState: DeployState;
  try {
    deployState = await host.getDeployState({ tokens, site: siteFromJob(job) });
  } catch {
    return job; // transient host hiccup — the next client poll retries
  }

  if (deployState === 'error') {
    job.stages.deploy = 'error';
    job.status = 'error';
    job.awaitingDeploy = false;
    job.message = buildFailedMessage(host.id);
    await setJob(env, state, job);
    await trackEvent(env.EASEL_STATE, 'provision_failed', { stage: 'deploy' });
    return job;
  }
  if (deployState === 'ready') {
    await completeJob(env, state, job);
    return job;
  }

  // Still building — refresh the job + session TTLs so neither lapses mid-wait,
  // then let the client poll again.
  await setJob(env, state, job);
  await saveSession(env.EASEL_STATE, state, {});
  return job;
}
