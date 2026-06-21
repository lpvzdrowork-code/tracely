import { deleteLogsOlderThan, getSettings, getAllWorkspaceIds } from '../lib/db.js';

// Triggered daily by Vercel Cron (see vercel.json). Vercel automatically sends
// `Authorization: Bearer <CRON_SECRET>` on cron-triggered requests once you've
// set the CRON_SECRET environment variable in your Vercel project — this check
// makes sure nobody else can hit the endpoint and wipe logs early.
export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Retention is per-workspace now (set from each workspace's own Settings
  // panel), so the cron has to loop every workspace individually instead of
  // running one global DELETE. LOG_RETENTION_DAYS stays as the fallback for
  // any workspace that hasn't set its own value yet.
  const workspaceIds = await getAllWorkspaceIds();
  const fallbackDays = Number(process.env.LOG_RETENTION_DAYS) || 30;

  const results = [];
  for (const workspaceId of workspaceIds) {
    const settings = await getSettings(workspaceId);
    const retentionDays = settings.logRetentionDays || fallbackDays;
    const deleted = await deleteLogsOlderThan(workspaceId, retentionDays);
    results.push({ workspaceId, deleted, retentionDays });
  }

  const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
  return res.status(200).json({ workspaces: results.length, totalDeleted, results });
}