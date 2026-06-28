/**
 * Host-provider abstraction.
 *
 * Easel can publish an artist's site to more than one host. The provisioning flow
 * is almost entirely host-agnostic — generating the GitHub repo, patching the admin
 * config, polling the first deploy — so each host only has to supply the few bits
 * that genuinely differ: how a site is created, whether a build needs an explicit
 * kick, and how to read the deploy state.
 *
 * Today: 'netlify' (OAuth → create site → deploy key + webhook) and 'github-pages'
 * (no extra OAuth — the GitHub token is already in hand — enable Pages + commit a
 * deploy workflow).
 */

import type { GeneratedRepo } from '../github';

export type HostId = 'netlify' | 'github-pages';

export const HOST_IDS: readonly HostId[] = ['netlify', 'github-pages'];

export function isHostId(value: unknown): value is HostId {
  return typeof value === 'string' && (HOST_IDS as readonly string[]).includes(value);
}

export type DeployState = 'building' | 'ready' | 'error' | 'unknown';

/** Tokens available for a single provisioning run. Netlify's is absent for Pages. */
export interface ProvisionTokens {
  githubToken: string;
  netlifyToken?: string;
}

/**
 * The handle returned by a host once the site exists. It carries everything the
 * deploy-poll machinery and the success page need, for either host, so the deploy
 * wait can be reconciled later (after the worker's waitUntil window) from the job
 * record alone.
 */
export interface SiteHandle {
  /** Public URL, trailing slash (https://name.netlify.app/ or https://user.github.io/repo/). */
  siteUrl: string;
  /** The editor URL (siteUrl + 'admin/'). */
  adminUrl: string;
  /** Netlify site id — used to poll its deploys. */
  siteId?: string;
  /** Slug for a host dashboard deep-link (Netlify project slug / GitHub repo name). */
  dashboardSlug?: string;
  /** Repo coordinates — how a Pages deploy is polled (owner/repo, not a site id). */
  repoOwner?: string;
  repoName?: string;
  /** Non-fatal note from site creation (e.g. auto-publish webhook unconfirmed). */
  warning?: string;
}

export interface HostProvider {
  id: HostId;
  /** Whether this host needs the second (Netlify) OAuth connection before provisioning. */
  needsNetlify: boolean;
  /** Form backend for the generated site, written into the admin config + read by the template. */
  formBackend: 'netlify' | 'formsubmit';
  /** Stand up the site and return its handle. */
  createSite(args: { tokens: ProvisionTokens; repo: GeneratedRepo; email?: string }): Promise<SiteHandle>;
  /** Optional explicit first-build trigger (Netlify); Pages builds on push. */
  triggerBuild?(args: { tokens: ProvisionTokens; site: SiteHandle }): Promise<void>;
  /** Summarize the latest deploy into one state. */
  getDeployState(args: { tokens: ProvisionTokens; site: SiteHandle }): Promise<DeployState>;
}
