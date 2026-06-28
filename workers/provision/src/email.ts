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

/** Strip protocol + trailing slash so URLs read as clean labels (usersite.netlify.app). */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
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
    'Howdy!',
    '',
    'Thank you for choosing Easel as your portfolio software. Your site has been',
    `deployed to ${displayUrl(d.siteUrl)}, and your admin portal can be found at`,
    `${displayUrl(d.adminUrl)}. If you've added a custom domain, use that instead!`,
    "(And frankly, you really should, if you haven't already.)",
    '',
    "I'd also like to plug my Ko-Fi (https://ko-fi.com/useeasel) if you'd like to",
    "optionally leave me a tip. I'm a working teacher and artist, and made Easel in",
    'my free time out of my distaste for expensive, low-agency site builders you’re',
    'probably familiar with. Easel will never charge for the self-hosted plan, and',
    'donations help keep new features in development.',
    d.repoUrl ? `\nYour files live in your own GitHub repo — ${d.repoUrl} — you own them.` : '',
    '',
    'Thanks again for choosing Easel, and feel free to reach out to me with any',
    'questions or feature requests you may have!',
    '',
    'Reese',
    'easel@rosematcha.com',
  ].join('\n');
}

/**
 * Bauhaus completion email. Table-based + fully inline-styled for email-client
 * compatibility; mirrors the site's identity (true primaries, near-black ink on
 * paper, hard edges, solid offset shadows, lowercase Jost display + Hanken body,
 * geometric circle/square/triangle motif). Web fonts degrade to system-ui where
 * blocked, which keeps the geometric character.
 */
function completionHtml(d: CompletionEmailData): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
    );

  // Palette (hex — OKLCH isn't safe in email clients).
  const blue = '#1235d6';
  const red = '#e8132b';
  const yellow = '#ffce00';
  const ink = '#16181d';
  const paper = '#f5f1e6';
  const white = '#ffffff';
  const stone = '#57564f';

  const display = `'Jost', Futura, 'Century Gothic', system-ui, sans-serif`;
  const body = `'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;

  const siteHref = esc(d.siteUrl);
  const adminHref = esc(d.adminUrl);
  const siteLabel = esc(displayUrl(d.siteUrl));
  const adminLabel = esc(displayUrl(d.adminUrl));

  // Flush bordered box — same 3px ink border + width as every other band, so all
  // sections share one clean left/right edge (no offset shadow that breaks alignment).
  const card = (inner: string) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate">
      <tr><td style="background:${white};border:3px solid ${ink};padding:32px 30px">${inner}</td></tr>
    </table>`;

  const repoLine = d.repoUrl
    ? `<p style="margin:0 0 0;color:${stone};font-size:14px;line-height:1.6;font-family:${body}">
         Your files live in your own GitHub repo —
         <a href="${esc(d.repoUrl)}" style="color:${blue};font-weight:600">${esc(displayUrl(d.repoUrl))}</a>
         — you own them, and you can take your site elsewhere any time.
       </p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light only">
  <title>Your Easel portfolio is live</title>
  <!--[if !mso]><!-->
  <link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;600;700&family=Jost:wght@600;800&display=swap" rel="stylesheet">
  <!--<![endif]-->
</head>
<body style="margin:0;padding:0;background:${paper};-webkit-font-smoothing:antialiased">
  <span style="display:none;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden">Your portfolio is live — here are your links.</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${paper}">
    <tr>
      <td align="center" style="padding:32px 16px 48px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

          <!-- Wordmark + geometric motif -->
          <tr>
            <td style="padding:0 0 22px">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:${display};font-weight:800;font-size:26px;letter-spacing:-0.02em;color:${ink};padding-right:14px">easel</td>
                  <td style="padding-right:7px"><span style="display:inline-block;width:14px;height:14px;background:${red}"></span></td>
                  <td style="padding-right:7px"><span style="display:inline-block;width:14px;height:14px;background:${blue};border-radius:50%"></span></td>
                  <td><span style="display:inline-block;width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-bottom:14px solid ${yellow}"></span></td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Yellow headline band -->
          <tr>
            <td style="background:${yellow};border:3px solid ${ink};padding:30px 28px">
              <h1 style="margin:0;font-family:${display};font-weight:800;text-transform:lowercase;font-size:40px;line-height:0.95;letter-spacing:-0.02em;color:${ink}">welcome to easel</h1>
            </td>
          </tr>

          <tr><td style="height:18px;line-height:18px;font-size:0">&nbsp;</td></tr>

          <!-- Main card -->
          <tr>
            <td>
              ${card(`
                <p style="margin:0 0 16px;color:${ink};font-size:17px;line-height:1.6;font-family:${body}">Howdy!</p>
                <p style="margin:0 0 22px;color:${ink};font-size:17px;line-height:1.6;font-family:${body}">
                  Thank you for choosing Easel as your portfolio software. Your site has been deployed, and your admin portal is ready whenever you are.
                </p>

                <!-- Link block -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid ${ink};background:${paper};margin:0 0 22px">
                  <tr>
                    <td style="padding:16px 18px;border-bottom:2px solid ${ink}">
                      <div style="font-family:${display};font-weight:700;text-transform:uppercase;letter-spacing:0.16em;font-size:11px;color:${blue};margin:0 0 4px">your site</div>
                      <a href="${siteHref}" style="font-family:${body};font-weight:700;font-size:16px;color:${ink};text-decoration:none;word-break:break-all">${siteLabel}</a>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 18px">
                      <div style="font-family:${display};font-weight:700;text-transform:uppercase;letter-spacing:0.16em;font-size:11px;color:${red};margin:0 0 4px">your admin portal</div>
                      <a href="${adminHref}" style="font-family:${body};font-weight:700;font-size:16px;color:${ink};text-decoration:none;word-break:break-all">${adminLabel}</a>
                    </td>
                  </tr>
                </table>

                <!-- Buttons -->
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
                  <tr>
                    <td style="padding:0 12px 0 0">
                      <a href="${siteHref}" style="display:inline-block;font-family:${display};font-weight:700;text-transform:lowercase;font-size:16px;color:${white};background:${blue};border:3px solid ${ink};padding:12px 22px;text-decoration:none">view your site</a>
                    </td>
                    <td>
                      <a href="${adminHref}" style="display:inline-block;font-family:${display};font-weight:700;text-transform:lowercase;font-size:16px;color:${ink};background:${white};border:3px solid ${ink};padding:12px 22px;text-decoration:none">edit your site</a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 0;color:${stone};font-size:14px;line-height:1.6;font-family:${body}">
                  If you've added a custom domain, use that instead! (And frankly, you <i>really</i> should, if you haven't already.)
                </p>
              `)}
            </td>
          </tr>

          <tr><td style="height:18px;line-height:18px;font-size:0">&nbsp;</td></tr>

          <!-- Ko-Fi band -->
          <tr>
            <td style="background:${ink};border:3px solid ${ink};padding:24px 28px">
              <div style="font-family:${display};font-weight:700;text-transform:uppercase;letter-spacing:0.18em;font-size:12px;color:${yellow};margin:0 0 10px">support easel</div>
              <p style="margin:0 0 16px;color:${paper};font-size:15px;line-height:1.6;font-family:${body}">
                I'm a working teacher and artist, and made Easel in my free time out of my distaste for expensive, low-agency site builders you're probably familiar with. Easel will never charge for the self-hosted plan — donations just help keep new features in development.
              </p>
              <a href="https://ko-fi.com/useeasel" style="display:inline-block;font-family:${display};font-weight:700;text-transform:lowercase;font-size:15px;color:${ink};background:${yellow};border:3px solid ${yellow};padding:10px 20px;text-decoration:none">leave a tip on ko-fi</a>
            </td>
          </tr>

          <tr><td style="height:24px;line-height:24px;font-size:0">&nbsp;</td></tr>

          <!-- Sign-off -->
          <tr>
            <td style="padding:0 2px">
              ${repoLine ? repoLine + `<div style="height:16px;line-height:16px;font-size:0">&nbsp;</div>` : ''}
              <p style="margin:0 0 16px;color:${ink};font-size:16px;line-height:1.6;font-family:${body}">
                Thanks again for choosing Easel, and feel free to reach out with any questions or feature requests you may have!
              </p>
              <p style="margin:0;color:${ink};font-size:16px;line-height:1.5;font-family:${body}">
                <span style="font-family:${display};font-weight:800;font-size:18px">Reese</span><br>
                <a href="mailto:easel@rosematcha.com" style="color:${blue};font-weight:600;text-decoration:none">easel@rosematcha.com</a>
              </p>
            </td>
          </tr>

          <tr><td style="height:28px;line-height:28px;font-size:0">&nbsp;</td></tr>

          <!-- Footer rule + motif -->
          <tr>
            <td style="border-top:2px solid ${ink};padding:16px 2px 0">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:${display};font-weight:700;font-size:13px;letter-spacing:0.04em;color:${stone}">made with easel</td>
                  <td align="right">
                    <span style="display:inline-block;width:10px;height:10px;background:${red};margin-left:6px"></span>
                    <span style="display:inline-block;width:10px;height:10px;background:${blue};border-radius:50%;margin-left:6px"></span>
                    <span style="display:inline-block;width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:10px solid ${yellow};margin-left:6px"></span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
