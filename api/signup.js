import { createUser, createWorkspace } from '../lib/auth.js';
import { createSessionToken, buildSessionCookie } from '../lib/session.js';
import { enforceRateLimit } from '../lib/rate-limit.js';

// Tighter than login — account creation is expensive (scrypt + 2 DB writes)
// and a signup flood could fill the users table with junk accounts.
const SIGNUP_RATE_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!enforceRateLimit(req, res, SIGNUP_RATE_LIMIT)) return;

  const { email, password, workspaceName } = req.body || {};

  let user;
  try {
    user = await createUser({ email, password });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Every account gets one workspace (and one API key) at signup, so
  // there's no separate "create your first workspace" step before a
  // Roblox game can start posting logs.
  const defaultName = `${user.email.split('@')[0]}'s Workspace`;
  const name = typeof workspaceName === 'string' && workspaceName.trim() ? workspaceName : defaultName;

  let workspace;
  try {
    workspace = await createWorkspace({ name, ownerUserId: user.id });
  } catch (err) {
    // The user account already exists at this point. Rather than leave
    // them with a login but no workspace/API key and no explanation,
    // surface the failure so the dashboard can prompt them to create a
    // workspace manually instead of silently losing half the signup.
    return res.status(201).json({
      user,
      workspace: null,
      warning: `Account created, but workspace setup failed: ${err.message}`,
    });
  }

  let token;
  try {
    token = createSessionToken(user);
  } catch (err) {
    // The user + workspace rows are already committed at this point (see
    // the workspace try/catch above) — this can only fail on a server
    // misconfiguration (e.g. SESSION_SECRET unset), not anything the
    // person did. Surfacing it as JSON (instead of letting it crash the
    // function with a non-JSON response) at least tells them — and you,
    // via Vercel's function logs — what actually broke.
    return res.status(500).json({
      error: `Account and workspace were created, but signing you in failed: ${err.message}. Check the server's SESSION_SECRET env var, then log in.`,
      user,
      workspace,
    });
  }
  res.setHeader('Set-Cookie', buildSessionCookie(token, req));

  return res.status(201).json({
    user,
    workspace, // includes the raw apiKey — only returned this once, show it to the user now
  });
}