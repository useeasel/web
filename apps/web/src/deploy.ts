// Client-side record of the artist's most recent Easel deployment.
//
// Provisioning happens once and then Easel steps out — but the artist often comes
// back later to do the one thing we can't do for them: point a custom domain at
// their site. We stash a small first-party cookie at /start/done so any later page
// (the custom-domain guide especially) can pick up where they left off and deep-link
// straight into *their* Netlify project instead of giving generic directions.
//
// It's a plain JS-readable cookie (no server reads it — these are static pages), so
// keep nothing sensitive in it: just the public URLs Netlify already shows the user.

export type HostId = 'netlify' | 'github-pages';

export interface DeployRecord {
  /** The live site's URL at provision time (the "internal" address). */
  site: string;
  /** The /admin editor URL. */
  admin?: string;
  /** The GitHub repo URL. */
  repo?: string;
  /** Which host the site was published to. Absent on older records ⇒ treat as Netlify. */
  provider?: HostId;
  /** Netlify project slug, e.g. 'radiant-nasturtium-ed9625'. */
  netlify?: string;
  /** ISO timestamp of when the deployment completed. */
  at: string;
}

const COOKIE = 'easel_deploy';
const ONE_YEAR = 60 * 60 * 24 * 365;

/** Netlify dashboard deep link to a project's add-a-domain setup flow. The
 *  `/setup` suffix drops the artist straight onto the "add a domain" step rather
 *  than the domain-management overview. */
export function netlifyDomainUrl(slug: string): string {
  return `https://app.netlify.com/projects/${slug}/domain-management/setup`;
}

/** GitHub Pages custom-domain settings live in the repo's Settings → Pages. Derive
 *  that deep link from the repo URL (https://github.com/owner/repo). */
export function githubPagesSettingsUrl(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  try {
    const u = new URL(repoUrl);
    if (u.hostname !== 'github.com') return null;
    return `https://github.com${u.pathname.replace(/\/$/, '')}/settings/pages`;
  } catch {
    return null;
  }
}

/** Resolve the right "set up a custom domain" deep link for a deployment record. */
export function domainSetupUrl(rec: DeployRecord): string | null {
  if (rec.provider === 'github-pages') return githubPagesSettingsUrl(rec.repo);
  const slug = rec.netlify ?? slugFromSite(rec.site);
  return slug ? netlifyDomainUrl(slug) : 'https://app.netlify.com/';
}

/** Best-effort: derive the Netlify project slug from its *.netlify.app URL. */
export function slugFromSite(site: string | null | undefined): string | null {
  if (!site) return null;
  try {
    const host = new URL(site).hostname;
    const m = host.match(/^([^.]+)\.netlify\.app$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function writeDeploy(rec: DeployRecord): void {
  try {
    const value = encodeURIComponent(JSON.stringify(rec));
    document.cookie = `${COOKIE}=${value}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
  } catch {
    /* cookies disabled — non-fatal, the pages all work without it */
  }
}

export function readDeploy(): DeployRecord | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
    if (!match) return null;
    const rec = JSON.parse(decodeURIComponent(match[1])) as DeployRecord;
    return rec && rec.site ? rec : null;
  } catch {
    return null;
  }
}
