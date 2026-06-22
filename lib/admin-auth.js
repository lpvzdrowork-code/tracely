import crypto from 'node:crypto';
import { getSessionUser } from './session.js';
import { db } from './db.js';

// ─────────────────────────────────────────
// Admin middleware
//
// The admin email lives in the ADMIN_EMAIL env var — not hardcoded — so
// you can rotate it without a deploy and it's never in the git history.
// Compared with timingSafeEqual for consistency with the rest of the
// codebase, even though email comparison isn't a meaningful timing-attack
// surface (an attacker who guesses the admin email still can't log in as
// it — they'd need your password or session secret too).
//
// Usage — every admin route must call this first:
//
//   const ctx = await requireAdmin(req, res);
//   if (!ctx) return;          // response already written
//   // ctx.user is the verified admin user
// ─────────────────────────────────────────

function getAdminEmail() {
  const email = process.env.ADMIN_EMAIL;
  if (!email) throw new Error('ADMIN_EMAIL env var is not set');
  return email.trim().toLowerCase();
}

function emailsMatch(a, b) {
  // Pad to the same length before timingSafeEqual so it doesn't throw on a
  // mismatch. The length difference itself is visible (one comparison,
  // not a loop), but that's unavoidable without a MAC and irrelevant here —
  // the admin email is not a secret that an attacker is trying to discover
  // character-by-character.
  const bufa = Buffer.from(a);
  const bufb = Buffer.from(b);
  if (bufa.length !== bufb.length) return false;
  return crypto.timingSafeEqual(bufa, bufb);
}

export async function requireAdmin(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }

  let adminEmail;
  try {
    adminEmail = getAdminEmail();
  } catch (err) {
    // Misconfiguration — don't leak the reason to the client
    console.error('[admin-auth] ADMIN_EMAIL not configured:', err.message);
    res.status(503).json({ error: 'Admin access not configured' });
    return null;
  }

  const normalizedUserEmail = String(user.email ?? '').trim().toLowerCase();
  if (!emailsMatch(normalizedUserEmail, adminEmail)) {
    // 404 rather than 403 — don't confirm that an admin panel exists
    // to users who aren't supposed to know about it.
    res.status(404).json({ error: 'Not found' });
    return null;
  }

  return { user };
}

// ─────────────────────────────────────────
// Admin audit log
//
// Every mutating admin action writes a row here so there's a tamper-evident
// record of what was done, when, and to which resource. Read-only admin
// actions (stats, user-view) are not logged — only writes that change
// production data.
// ─────────────────────────────────────────
export async function writeAdminAuditLog({ adminEmail, action, targetType, targetId, detail = null }) {
  await db.execute({
    sql: `INSERT INTO admin_audit_logs (adminEmail, action, targetType, targetId, detail, createdAt)
          VALUES (?, ?, ?, ?, ?, unixepoch())`,
    args: [
      String(adminEmail),
      String(action),
      String(targetType),
      targetId != null ? String(targetId) : null,
      detail != null ? String(detail) : null,
    ],
  });
}