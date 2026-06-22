import { rotateApiKey } from '../lib/auth.js';
import { requireWorkspace } from '../lib/workspace-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { workspaceId } = req.body || {};
  const ctx = await requireWorkspace(req, res, workspaceId);
  if (!ctx) return;

  // requireWorkspace already confirmed ctx.workspace.id is owned by
  // ctx.user.id, but rotateApiKey re-checks ownership itself in its SQL
  // WHERE clause — same belt-and-suspenders pattern as deleteWorkspace.
  const result = await rotateApiKey(ctx.workspace.id, ctx.user.id);
  if (!result) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  return res.status(200).json({ workspace: result });
}