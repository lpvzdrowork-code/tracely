import { verifyUser, getWorkspacesForUser } from '../lib/auth.js';
import { createSessionToken, buildSessionCookie } from '../lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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