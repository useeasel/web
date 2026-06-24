/**
 * OAuth `state` handling.
 *
 * The `state` value travels through both OAuth round-trips (GitHub then Netlify)
 * and is also used as the KV key under which we stash the short-lived tokens for
 * a single provisioning run. It must be:
 *   - unforgeable  → HMAC-signed with STATE_SIGNING_KEY
 *   - single-use   → consumed (deleted) when provisioning finishes
 *   - short-lived  → KV entries carry a 10-minute TTL
 *
 * Format: `<nonce>.<base64url(hmac-sha256(nonce))>`
 */

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  const b = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Mint a fresh, signed state value. */
export async function createState(signingKey: string): Promise<string> {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const key = await hmacKey(signingKey);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(nonce));
  return `${nonce}.${b64url(sig)}`;
}

/**
 * Verify a state value's signature. Uses WebCrypto's constant-time verify.
 * Returns true only if the signature matches — does NOT check single-use; the
 * caller enforces that by deleting the KV entry on completion.
 */
export async function verifyState(value: string, signingKey: string): Promise<boolean> {
  const [nonce, sig] = value.split('.');
  if (!nonce || !sig) return false;
  const key = await hmacKey(signingKey);
  const raw = Uint8Array.from(
    atob(sig.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );
  try {
    return await crypto.subtle.verify('HMAC', key, raw, enc.encode(nonce));
  } catch {
    return false;
  }
}

/** Shape of the transient session we keep in KV for one provisioning run. */
export interface ProvisionSession {
  githubToken?: string;
  netlifyToken?: string;
  siteName?: string;
  /** Set once we know the artist's GitHub login (from the token). */
  githubLogin?: string;
  /** Optional: artist email for the completion notification (best-effort). */
  email?: string;
}

const TTL_SECONDS = 600; // 10 minutes

export async function loadSession(
  kv: KVNamespace,
  state: string,
): Promise<ProvisionSession | null> {
  return kv.get<ProvisionSession>(`sess:${state}`, 'json');
}

export async function saveSession(
  kv: KVNamespace,
  state: string,
  patch: ProvisionSession,
): Promise<void> {
  const current = (await loadSession(kv, state)) ?? {};
  const merged = { ...current, ...patch };
  await kv.put(`sess:${state}`, JSON.stringify(merged), { expirationTtl: TTL_SECONDS });
}

/** Delete transient tokens once provisioning is done (or on hard failure). */
export async function clearSession(kv: KVNamespace, state: string): Promise<void> {
  await kv.delete(`sess:${state}`);
}
