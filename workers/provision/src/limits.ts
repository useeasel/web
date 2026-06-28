/**
 * Lightweight abuse-throttling + observability for the provisioning Worker.
 *
 * Both lean on the existing GESSO_STATE KV namespace (no new infra). KV isn't a
 * strongly-consistent counter, so neither is exact — but for "stop a script from
 * spamming repo generation" and "roughly how many signups/failures per day" that's
 * the right trade for the free tier. Hard-accuracy needs would move to a Durable
 * Object; we deliberately don't pay that cost yet.
 */

const RL_PREFIX = 'rl:';
const METRIC_PREFIX = 'metric:';

/**
 * Fixed-window rate limit. Returns true when the caller is over `limit` requests in
 * the current `windowSec` bucket for `key` (typically an IP + route). Fails OPEN:
 * if KV misbehaves we'd rather serve a legit artist than hard-block everyone.
 */
export async function isRateLimited(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  try {
    const bucket = Math.floor(nowSec() / windowSec);
    const k = `${RL_PREFIX}${key}:${bucket}`;
    const current = Number((await kv.get(k)) ?? '0');
    if (current >= limit) return true;
    // TTL a little past the window so the key self-cleans.
    await kv.put(k, String(current + 1), { expirationTtl: windowSec + 5 });
    return false;
  } catch {
    return false;
  }
}

/** Client IP for rate-limit keying (Cloudflare sets CF-Connecting-IP). */
export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

/**
 * Record a named event. Emits a structured log line (reliable, shows up in
 * `wrangler tail` / Workers Analytics) and best-effort bumps a day-bucketed KV
 * counter for an at-a-glance daily total. Never throws.
 */
export async function trackEvent(
  kv: KVNamespace,
  name: string,
  fields: Record<string, string | number> = {},
): Promise<void> {
  // Structured log — the source of truth for observability.
  try {
    console.log(JSON.stringify({ evt: name, ...fields }));
  } catch {
    /* logging must never break the run */
  }
  // Approximate daily counter — convenience only.
  try {
    const day = new Date(nowSec() * 1000).toISOString().slice(0, 10);
    const k = `${METRIC_PREFIX}${name}:${day}`;
    const current = Number((await kv.get(k)) ?? '0');
    await kv.put(k, String(current + 1), { expirationTtl: 60 * 60 * 24 * 35 });
  } catch {
    /* counters are best-effort */
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
