import crypto from 'node:crypto';
import { db } from '../../lib/db.js';
import { requireAdmin, writeAdminAuditLog } from '../../lib/admin-auth.js';
import { SESSION_COOKIE_NAME } from '../../lib/session.js';

// ─────────────────────────────────────────
// Admin impersonation
//
// Issues a short-lived, flagged session cookie that lets the admin view the
// dashboard exactly as a target user would see it — same workspace list, same
// logs, same settings — without knowing the user's password or having their
// original session token.
//
// DESIGN CONSTRAINTS
// ──────────────────
// • TTL is 1 hour (vs. 30 days for a real login). The cookie Max-Age
//   matches, so it expires automatically in the browser.
//
// • The payload carries `imp: adminEmail` so the server can distinguish an
//   impersonation token from a real login if needed in the future (e.g. to
//   block impersonated sessions from changing passwords or rotating keys).
//   getSessionUser() in lib/session.js returns { id, email } regardless —
//   impersonation is transparent to the rest of the API today, which is
//   intentional: the whole point is to see what the user sees.
//
// • The token is signed with the same SESSION_SECRET as normal sessions —
//   no separate key needed. The `imp` field in the payload is the
//   distinguishing marker, not a different signing key.
//
// • Every impersonation start is written to admin_audit_logs. There is no
//   "end impersonation" — the cookie just expires after 1 hour, or the
//   admin can call /api/logout to clear it. Either way, their original
//   session is already gone once this cookie is set (SameSite=Lax, same
//   name); they'll need to log back in as themselves afterward.
//
// WHY NOT A SEPARATE COOKIE NAME
// ───────────────────────────────
// Using the same SESSION_COOKIE_NAME means the dashboard JS needs no changes —
// it just sees a logged-in session for the target user. A second cookie name
// would require every requireWorkspace() call to check both. The trade-off is
// that the admin loses their own session; the 1-hour TTL makes that acceptable
// for a debugging session.
// ─────────────────────────────────────────

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret;
}

const IMPERSONATION_TTL_SECONDS = 60 * 60; // 1 hour

function createImpersonationToken(targetUser, adminEmail) {
  const payload = {
    uid:   targetUser.id,
    email: targetUser.email,
    exp:   Math.floor(Date.now() / 1000) + IMPERSONATION_TTL_SECONDS,
    imp:   adminEmail, // marks this as an impersonation token
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSecret())
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

function buildImpersonationCookie(token, req) {
  const isLocalhost = req?.headers?.host?.startsWith('localhost');
  const secureFlag  = isLocalhost ? '' : ' Secure;';
  // Explicit Max-Age matches TTL so the browser discards it automatically
  // even if the admin doesn't explicitly log out.
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly;${secureFlag} SameSite=Lax; Path=/; Max-Age=${IMPERSONATION_TTL_SECONDS}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ctx = await requireAdmin(req, res);
  if (!ctx) return;

  const { targetUserId } = req.body || {};
  const uid = Number(targetUserId);
  if (!targetUserId || !Number.isFinite(uid)) {
    return res.status(400).json({ error: 'targetUserId is required and must be numeric' });
  }

  // Don't allow impersonating yourself — pointless, and avoids the odd edge
  // case of the admin locking themselves out of their own panel by replacing
  // their 30-day session with a 1-hour impersonation of their own account.
  if (Number(ctx.user.id) === uid) {
    return res.status(400).json({ error: 'Cannot impersonate your own account' });
  }

  const result = await db.execute({
    sql: `SELECT id, email FROM users WHERE id = ?`,
    args: [uid],
  });
  const targetUser = result.rows[0];
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  let token;
  try {
    token = createImpersonationToken(
      { id: Number(targetUser.id), email: targetUser.email },
      ctx.user.email,
    );
  } catch (err) {
    return res.status(500).json({ error: `Token generation failed: ${err.message}` });
  }

  await writeAdminAuditLog({
    adminEmail: ctx.user.email,
    action:     'impersonate-start',
    targetType: 'user',
    targetId:   String(uid),
    detail:     `targetEmail="${targetUser.email}" ttl=${IMPERSONATION_TTL_SECONDS}s`,
  });

  res.setHeader('Set-Cookie', buildImpersonationCookie(token, req));

  return res.status(200).json({
    ok:            true,
    targetUserId:  uid,
    targetEmail:   targetUser.email,
    expiresInSecs: IMPERSONATION_TTL_SECONDS,
    // Remind the caller they'll need to log in again when this expires
    note: 'Your admin session has been replaced. Log in again as yourself after this session expires or when done.',
  });
}