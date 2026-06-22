import { verifyUser, getWorkspacesForUser } from '../lib/auth.js';
import { createSessionToken, buildSessionCookie } from '../lib/session.js';
import { enforceRateLimit } from '../lib/rate-limit.js';

// 10 attempts per IP per 5 minutes. scrypt costs ~100ms per attempt, so a
// single IP can still try ~3000 passwords/hour without this cap — low enough
// to not bother real users, high enough to matter for brute force.
const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 5 * 60 * 1000 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!enforceRateLimit(req, res, LOGIN_RATE_LIMIT)) return;

  const { email, password } = req.body || {};

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await verifyUser({ email, password });
  if (!user) {
    // Same message whether the email doesn't exist or the password is
    // wrong — verifyUser already returns null for both cases, so this
    // endpoint can't be used to enumerate registered emails.
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  let token;
  try {
    token = createSessionToken(user);
  } catch (err) {
    return res.status(500).json({ error: `Sign-in failed: ${err.message}` });
  }
  res.setHeader('Set-Cookie', buildSessionCookie(token, req));

  // apiKeyLast4 only — the full key was shown once at workspace creation
  // and was never stored anywhere it could be read back out.
  const workspaces = await getWorkspacesForUser(user.id);

  return res.status(200).json({ user, workspaces });
}