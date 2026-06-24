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
  getGithubLogin,
  generateRepoFromTemplate,
  patchAdminConfig,
} from './github';
import {
  netlifyAuthorizeUrl,
  exchangeNetlifyCode,
  createSite,
  triggerBuild,
  getLatestDeployState,
} from './netlify';

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
        const login = await getGithubLogin(token);
        await saveSession(env.EASEL_STATE, state, { githubToken: token, githubLogin: login });
        return redirectToStart(env, 'netlify', state, { login });
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

      // ---- Step 3: Provision ----
      // POST starts the run in the background and returns a jobId immediately;
      // the client polls GET /provision?job=<id> for live per-stage progress.
      if (pathname === '/provision' && request.method === 'POST') {
        return await startProvision(request, env, ctx);
      }
      if (pathname === '/provision' && request.method === 'GET') {
        const jobId = url.searchParams.get('job') ?? '';
        const job = await env.EASEL_STATE.get(`job:${jobId}`, 'json');
        if (!job) return json({ status: 'unknown' }, env, 404);
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
  siteUrl?: string;
  adminUrl?: string;
  repoUrl?: string;
}

const JOB_TTL = 900; // 15 minutes

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
  const { state } = (await request.json().catch(() => ({}))) as { state?: string };
  if (!state || !(await verifyState(state, env.STATE_SIGNING_KEY))) {
    return json({ status: 'error', message: 'invalid_state' }, env, 400);
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
      { githubToken: sess.githubToken, netlifyToken: sess.netlifyToken, githubLogin: sess.githubLogin },
      job,
    ),
  );

  return json({ jobId: state, status: 'running', stages: job.stages }, env);
}

/** The five provisioning steps, writing progress to KV after each transition. */
async function runProvisionJob(
  env: Env,
  state: string,
  sess: { githubToken: string; netlifyToken: string; githubLogin: string },
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
  };

  const templateOwner = env.TEMPLATE_OWNER ?? 'easel';
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
    await advance('repo', 'done');
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'repo_failed', 'repo');
  }

  // (b) Netlify: create site linked to the repo (Netlify auto-assigns the name).
  await advance('site', 'active');
  let site;
  try {
    site = await createSite(sess.netlifyToken, {
      repoPath: `${repo.owner}/${repo.name}`,
      branch: repo.defaultBranch,
    });
    await advance('site', 'done');
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'site_failed', 'site');
  }

  // (c) Netlify: trigger first deploy + poll until ready (cap the wait).
  await advance('deploy', 'active');
  try {
    await triggerBuild(sess.netlifyToken, site.id);
    await pollDeploy(sess.netlifyToken, site.id, 60_000);
    // Soft-pass even if still building — the artist can proceed; it finishes shortly.
    await advance('deploy', 'done');
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'deploy_failed', 'deploy');
  }

  // (d) Point the new repo's admin config at this repo + the sveltia-auth relay.
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

  // (e) Delete transient tokens.
  await advance('cleanup', 'active');
  await clearSession(env.EASEL_STATE, state);
  job.stages.cleanup = 'done';
  job.status = 'done';
  job.siteUrl = site.url;
  job.adminUrl = `${site.url.replace(/\/$/, '')}/admin/`;
  job.repoUrl = repo.htmlUrl;
  await setJob(env, state, job);
}

/** Poll the latest deploy until ready or timeout. Returns true if ready. */
async function pollDeploy(token: string, siteId: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const state = await getLatestDeployState(token, siteId);
    if (state === 'ready') return true;
    if (state === 'error') throw new Error('Netlify deploy failed');
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}
