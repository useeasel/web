/**
 * Optional transactional "your site is live" email.
 *
 * Status lives only in the browser tab running the flow, so if the artist closes it
 * they lose the links to their site + editor. One email turns that fragile session
 * into a durable artifact.
 *
 * Provider-agnostic but ships a Resend implementation (simple REST, works from
 * Workers). It is *gated on configuration*: with no RESEND_API_KEY / EASEL_FROM_EMAIL
 * set, send is a silent no-op so provisioning is never blocked or broken by email.
 *
 * To enable (decisions the operator must make — see AGENTS.md):
 *   1. Pick/verify a sending domain in Resend (or swap in another provider here).
 *   2. wrangler secret put RESEND_API_KEY
 *   3. Set EASEL_FROM_EMAIL in wrangler.toml [vars] (e.g. "Easel <hello@easel.rosematcha.com>")
 */

export interface EmailEnv {
  RESEND_API_KEY?: string;
  EASEL_FROM_EMAIL?: string;
}

export interface CompletionEmailData {
  to: string;
  siteUrl: string;
  adminUrl: string;
  repoUrl?: string;
}

/** True when the email feature is configured; lets callers skip work cleanly. */
export function emailEnabled(env: EmailEnv): boolean {
  return !!(env.RESEND_API_KEY && env.EASEL_FROM_EMAIL);
}

/**
 * Send the completion email. Best-effort: returns false (never throws) on any
 * failure or when not configured, so it can sit at the very end of a successful
 * run without risking the run's success.
 */
export async function sendCompletionEmail(
  env: EmailEnv,
  data: CompletionEmailData,
): Promise<boolean> {
  if (!emailEnabled(env) || !data.to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EASEL_FROM_EMAIL,
        to: [data.to],
        subject: 'Your Easel portfolio is live 🎉',
        html: completionHtml(data),
        text: completionText(data),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function completionText(d: CompletionEmailData): string {
  return [
    'Your portfolio is live!',
    '',
    `View your site:  ${d.siteUrl}`,
    `Edit your site:  ${d.adminUrl}`,
    d.repoUrl ? `Your files live here (you own them): ${d.repoUrl}` : '',
    '',
    'Bookmark the edit link — that’s where you add work and change your design.',
    'Made with Easel.',
  ]
    .filter(Boolean)
    .join('\n');
}

function completionHtml(d: CompletionEmailData): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
    );
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:0 auto;padding:1.5rem;color:#161616">
  <h1 style="font-size:1.4rem">Your portfolio is live 🎉</h1>
  <p>Everything's set up. Two links to keep:</p>
  <p><a href="${esc(d.siteUrl)}" style="display:inline-block;padding:.6rem 1rem;background:#1D4ED8;color:#fff;text-decoration:none">View your site</a>
     &nbsp;
     <a href="${esc(d.adminUrl)}" style="display:inline-block;padding:.6rem 1rem;border:2px solid #161616;color:#161616;text-decoration:none">Edit your site</a></p>
  <p style="color:#6B6B63;font-size:.9rem">Bookmark the edit link — that's where you add work and change your design.</p>
  ${d.repoUrl ? `<p style="color:#6B6B63;font-size:.9rem">Your files live in your own GitHub repo (<a href="${esc(d.repoUrl)}">${esc(d.repoUrl)}</a>) — you own them, and you can take your site elsewhere any time.</p>` : ''}
  <p style="color:#6B6B63;font-size:.8rem">Made with Easel.</p>
</body></html>`;
}
