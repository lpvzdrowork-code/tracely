import { getWorkspacesForUser, createWorkspace, getWorkspaceById, deleteWorkspace } from '../lib/auth.js';
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

  if (req.method === 'DELETE') {
    const { workspaceId } = req.body || {};
    const id = Number(workspaceId);
    if (!workspaceId || !Number.isFinite(id)) {
      return res.status(400).json({ error: 'workspaceId is required' });
    }

    // 404 rather than 403 for a workspace owned by someone else — same
    // reasoning as requireWorkspace(): don't let this endpoint confirm
    // whether a given workspaceId exists on another account.
    const workspace = await getWorkspaceById(id);
    if (!workspace || Number(workspace.ownerUserId) !== Number(user.id)) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    // There's no "create your first workspace" screen outside signup, and
    // login resolves a session straight into one — so every account has
    // to keep at least one. The UI already never offers delete on the
    // active workspace, but this is the server-side backstop in case that
    // ever drifts, or this endpoint gets called directly.
    const remaining = await getWorkspacesForUser(user.id);
    if (remaining.length <= 1) {
      return res.status(400).json({ error: "Can't delete your only workspace" });
    }

    const deleted = await deleteWorkspace(id, user.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    return res.status(204).end();
  }

  return res.status(405).json({ error: 'Method not allowed' });
}