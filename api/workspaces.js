import { getWorkspacesForUser, createWorkspace } from '../lib/auth.js';
import { getSessionUser } from '../lib/session.js';

export default async function handler(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.method === 'GET') {
    const workspaces = await getWorkspacesForUser(user.id);
    return res.status(200).json({ workspaces });
  }

  if (req.method === 'POST') {
    const { name } = req.body || {};
    try {
      // Includes the raw apiKey ONCE — same rule as signup's auto-created
      // workspace. Show it to the user immediately; it can't be read back
      // out of the database afterward.
      const workspace = await createWorkspace({ name, ownerUserId: user.id });
      return res.status(201).json({ workspace });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}