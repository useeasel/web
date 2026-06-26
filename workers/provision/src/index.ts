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
  getNetlifyInstallationId,
  patchAdminConfig,
} from './github';
import { sendCompletionEmail } from './email';
import {
  netlifyAuthorizeUrl,
  exchangeNetlifyCode,
  createSite,
  triggerBuild,
  getLatestDeployState,
  type DeployState,
} from './netlify';
import { isRateLimited, clientIp, trackEvent } from './limits';

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
        if (job.status === 'running' && job.awaitingDeploy && job.siteId) {
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
  /** Netlify project slug (e.g. 'radiant-nasturtium-ed9625'), for dashboard links. */
  netlifyName?: string;
  /** Netlify site id, recorded so the deploy can be reconciled after handoff. */
  siteId?: string;
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
async function pollDeploy(token: string, siteId: string): Promise<DeployState> {
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const s = await getLatestDeployState(token, siteId);
    if (s === 'ready' || s === 'error') return s;
  }
  return 'building';
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
  const { state, email } = (await request.json().catch(() => ({}))) as {
    state?: string;
    email?: string;
  };
  if (!state || !(await verifyState(state, env.STATE_SIGNING_KEY))) {
    return json({ status: 'error', message: 'invalid_state' }, env, 400);
  }
  // An explicit email from the UI takes precedence over the (often-absent) public
  // GitHub profile email captured at sign-in.
  if (email && /.+@.+\..+/.test(email)) {
    await saveSession(env.EASEL_STATE, state, { email });
  }

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
  if (!sess?.githubToken || !sess.netlifyToken || !sess.githubLogin) {
    return json({ status: 'error', message: 'missing_connections' }, env, 400);
  }

  const job: JobRecord = {
    status: 'running',
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
      job,
    ),
  );

  return json({ jobId: state, status: 'running', stages: job.stages }, env);
}

/** The five provisioning steps, writing progress to KV after each transition. */
async function runProvisionJob(
  env: Env,
  state: string,
  sess: { githubToken: string; netlifyToken: string; githubLogin: string; email?: string },
  job: JobRecord,
): Promise<void> {
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

  // (b) Netlify: create site linked to the repo (Netlify auto-assigns the name).
  // We pass the numeric repo id + the Netlify GitHub App installation id so Netlify
  // installs the deploy key + push webhook — i.e. so later editor commits actually
  // trigger rebuilds (continuous deployment), not just the first deploy.
  await advance('site', 'active');
  let site;
  try {
    const installationId = await getNetlifyInstallationId(sess.githubToken);
    if (installationId == null) {
      // Not fatal: the first build can still run. But auto-rebuild on edit likely
      // won't work until the artist connects GitHub in Netlify. Surface it as a
      // soft note rather than blocking the run.
      console.warn('[provision] no Netlify GitHub App installation found for user');
      job.warning =
        'We couldn’t confirm the Netlify⇄GitHub connection, so edits may not auto-publish. ' +
        'If your site stops updating, open it in Netlify and connect the GitHub repo once.';
    }
    site = await createSite(sess.netlifyToken, {
      repoPath: `${repo.owner}/${repo.name}`,
      branch: repo.defaultBranch,
      repoId: repo.id,
      installationId,
    });
    // Same as the repo above: surface the site/admin links even if a later stage
    // (admin patch, deploy) fails, so the artist isn't left wondering what happened.
    job.siteUrl = site.url;
    job.adminUrl = `${site.url.replace(/\/$/, '')}/admin/`;
    job.netlifyName = site.name;
    await advance('site', 'done');
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'site_failed', 'site');
  }

  // (c) Netlify: trigger the first build. We keep the deploy stage 'active' and
  // verify it AFTER the admin patch (step d) rather than blocking here. Waiting
  // before (d) once made the waitUntil job long enough to get evicted with /admin
  // still unconfigured — so the critical config write must come first.
  await advance('deploy', 'active');
  try {
    await triggerBuild(sess.netlifyToken, site.id);
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'deploy_failed', 'deploy');
  }

  // (d) Point the new repo's admin config at this repo + the sveltia-auth relay.
  // Intentionally before the deploy poll so this lands even if the background job
  // is later evicted while waiting on the build.
  await advance('admin', 'active');
  try {
    await patchAdminConfig(sess.githubToken, {
      owner: repo.owner,
      repo: repo.name,
      branch: repo.defaultBranch,
      authBaseUrl: env.SVELTIA_AUTH_URL,
    });
    await advance('admin', 'done');
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'admin_failed', 'admin');
  }

  // (c, verify) Wait for the first deploy so we never declare the site live before
  // Netlify has actually finished. We poll for a bounded window here so the common
  // (fast) build is confirmed server-side — the completion email then fires even if
  // the artist closed the tab. If the build outlasts the window, we hand the wait
  // off to the client (awaitingDeploy) rather than risk this best-effort waitUntil
  // job being evicted mid-wait; the reconciling GET handler finishes it from the
  // client's polls. The siteId is recorded first so either path can poll the deploy.
  job.siteId = site.id;
  await setJob(env, state, job);

  let deployState: DeployState = 'building';
  try {
    deployState = await pollDeploy(sess.netlifyToken, site.id);
  } catch {
    /* polling hiccup — fall through to the client handoff below */
  }
  if (deployState === 'error') {
    return fail(
      'The first build failed on Netlify. Open your Netlify dashboard to see the build log.',
      'deploy',
    );
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
 * each client poll of GET /provision runs this: check the live Netlify deploy and
 * finalize the moment it's ready (or surface a failed build). This carries the wait
 * past the worker's best-effort waitUntil window without ever claiming "ready" early.
 */
async function reconcileDeploy(env: Env, state: string, job: JobRecord): Promise<JobRecord> {
  const sess = await loadSession(env.EASEL_STATE, state);
  if (!sess?.netlifyToken || !job.siteId) {
    // The token TTL'd out before the build finished (rare — we refresh it on every
    // poll below). Don't strand the artist: treat the site as published.
    await completeJob(env, state, job);
    return job;
  }

  let deployState: DeployState;
  try {
    deployState = await getLatestDeployState(sess.netlifyToken, job.siteId);
  } catch {
    return job; // transient Netlify hiccup — the next client poll retries
  }

  if (deployState === 'error') {
    job.stages.deploy = 'error';
    job.status = 'error';
    job.awaitingDeploy = false;
    job.message =
      'The first build failed on Netlify. Open your Netlify dashboard to see the build log.';
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
