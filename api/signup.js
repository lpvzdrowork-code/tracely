import { createUser, createWorkspace } from '../lib/auth.js';
import { createSessionToken, buildSessionCookie } from '../lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

  const token = createSessionToken(user);
  res.setHeader('Set-Cookie', buildSessionCookie(token, req));

  return res.status(201).json({
    user,
    workspace, // includes the raw apiKey — only returned this once, show it to the user now
  });
}