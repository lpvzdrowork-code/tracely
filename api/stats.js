import { getStats } from '../lib/db.js';
import { requireWorkspace } from '../lib/workspace-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { workspaceId } = req.query;
  const ctx = await requireWorkspace(req, res, workspaceId);
  if (!ctx) return;

  res.setHeader('Cache-Control', 'no-store');
  const data = await getStats(ctx.workspace.id);
  return res.status(200).json(data);
}