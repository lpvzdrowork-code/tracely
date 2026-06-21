import { deleteLogsOlderThan, getSettings } from '../lib/db.js';

// Triggered daily by Vercel Cron (see vercel.json). Vercel automatically sends
// `Authorization: Bearer <CRON_SECRET>` on cron-triggered requests once you've
// set the CRON_SECRET environment variable in your Vercel project — this check
// makes sure nobody else can hit the endpoint and wipe your logs early.
export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // The dashboard's Settings panel writes logRetentionDays into the
  // settings table; that takes priority over the env var so changes from
  // the UI don't require a redeploy. LOG_RETENTION_DAYS stays as the
  // fallback for anyone who hasn't touched the setting yet.
  const settings = await getSettings();
  const retentionDays = settings.logRetentionDays || Number(process.env.LOG_RETENTION_DAYS) || 30;
  const deleted = await deleteLogsOlderThan(retentionDays);

  return res.status(200).json({ deleted, retentionDays });
}