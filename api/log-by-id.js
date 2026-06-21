import { getLogById } from '../lib/db.js';
import { requireWorkspace } from '../lib/workspace-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id, workspaceId } = req.query;

  const ctx = await requireWorkspace(req, res, workspaceId);
  if (!ctx) return;

  if (!id || !/^\d+$/.test(String(id))) {
    return res.status(400).json({ error: 'id must be numeric' });
  }

  const log = await getLogById(id, ctx.workspace.id);
  if (!log) {
    return res.status(404).json({ error: 'Log not found' });
  }

  return res.status(200).json({ log });
}