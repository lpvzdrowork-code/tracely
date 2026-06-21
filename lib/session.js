import crypto from 'node:crypto';

// ─────────────────────────────────────────
// Session tokens
//
// Functionally a minimal JWT — {payload}.{signature}, HMAC-SHA256, both
// base64url — but hand-rolled instead of pulling in `jsonwebtoken` so this
// stays dependency-free like the rest of lib/. The payload is signed, not
// encrypted, so don't put anything in it you wouldn't want a user reading
// out of their own cookie (their own id/email is fine).
// ─────────────────────────────────────────
export const SESSION_COOKIE_NAME = 'tracely_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Fails loudly on purpose — silently falling back to a hardcoded
    // secret would mean every deployment without this env var shares
    // the same signing key.
    throw new Error('SESSION_SECRET is not set');
  }
  return secret;
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
}

export function createSessionToken(user) {
  const payload = {
    uid: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(payloadB64);
  return `${payloadB64}.${signature}`;
}

export function verifySessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) return null;

  const expectedSig = sign(payloadB64);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSig);
  // Length check before timingSafeEqual — it throws on mismatched
  // lengths rather than returning false.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    return null; // expired
  }

  return { id: payload.uid, email: payload.email };
}

// `req` is passed in purely to detect localhost and skip the Secure
// attribute during `vercel dev` — browsers won't store/send a Secure
// cookie over plain http://localhost, which would otherwise break local
// testing of the login flow.
export function buildSessionCookie(token, req) {
  const isLocalhost = req?.headers?.host?.startsWith('localhost');
  const secureFlag = isLocalhost ? '' : ' Secure;';
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly;${secureFlag} SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function buildClearSessionCookie(req) {
  const isLocalhost = req?.headers?.host?.startsWith('localhost');
  const secureFlag = isLocalhost ? '' : ' Secure;';
  return `${SESSION_COOKIE_NAME}=; HttpOnly;${secureFlag} SameSite=Lax; Path=/; Max-Age=0`;
}

// Convenience for any endpoint that needs to know who's logged in —
// reads the cookie Vercel already parsed into req.cookies, verifies it,
// returns { id, email } or null. Use this in future protected routes
// (e.g. "list my workspaces") instead of re-implementing the cookie read.
export function getSessionUser(req) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return null;
  return verifySessionToken(token);
}