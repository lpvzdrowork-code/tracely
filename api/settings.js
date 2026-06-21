import { getSettings, setLogRetentionDays } from '../lib/db.js';
import { requireWorkspace } from '../lib/workspace-auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const workspaceId = req.method === 'GET'
    ? req.query.workspaceId
    : (req.body || {}).workspaceId;

  const ctx = await requireWorkspace(req, res, workspaceId);
  if (!ctx) return;

  if (req.method === 'GET') {
    const settings = await getSettings(ctx.workspace.id);
    return res.status(200).json(settings);
  }

  // POST — update retention
  const { logRetentionDays } = req.body || {};
  try {
    const saved = await setLogRetentionDays(ctx.workspace.id, logRetentionDays);
    return res.status(200).json({ logRetentionDays: saved });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}