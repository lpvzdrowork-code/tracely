import crypto from 'node:crypto';
import { deleteLogsOlderThan, getSettings, getAllWorkspaceIds, clearExpiredPreviousApiKeys } from '../lib/db.js';

// How many workspaces to process in parallel. High enough to finish well
// within Vercel's 60s cron timeout even with hundreds of workspaces, low
// enough not to saturate Turso's connection pool.
const CLEANUP_CONCURRENCY = 10;

// Triggered daily by Vercel Cron (see vercel.json). Vercel automatically sends
// `Authorization: Bearer <CRON_SECRET>` on cron-triggered requests once you've
// set the CRON_SECRET environment variable in your Vercel project — this check
// makes sure nobody else can hit the endpoint and wipe logs early.
export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  // Constant-time comparison — keeps this consistent with the rest of the
  // codebase (timingSafeEqual everywhere) even though cron auth isn't a
  // high-frequency attack surface. timingSafeEqual requires equal-length
  // buffers, so we compare against a fixed-length encoding of both sides.
  const isAuthorized = (() => {
    if (!cronSecret || !authHeader) return false;
    const expected = `Bearer ${cronSecret}`;
    try {
      const a = Buffer.from(authHeader);
      const b = Buffer.from(expected);
      // Pad shorter to the longer length before comparing — mismatched lengths
      // would throw otherwise. The length difference itself leaks one bit of
      // info but that's unavoidable without a MAC, and it's not a meaningful
      // attack surface for a cron secret.
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  })();

  if (!isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Retention is per-workspace now (set from each workspace's own Settings
  // panel), so the cron has to process every workspace individually instead of
  // running one global DELETE. LOG_RETENTION_DAYS stays as the fallback for
  // any workspace that hasn't set its own value yet.
  const workspaceIds = await getAllWorkspaceIds();
  const fallbackDays = Number(process.env.LOG_RETENTION_DAYS) || 30;

  // Process workspaces in parallel batches rather than one at a time.
  // Sequential processing makes 2 × N Turso round-trips in series — with
  // 500 workspaces that's 1000 sequential awaits, which will hit Vercel's
  // 60s cron timeout well before it finishes. CLEANUP_CONCURRENCY keeps
  // N inflight at once, finishing the same work in ~(N / concurrency) trips.
  const results = [];
  for (let i = 0; i < workspaceIds.length; i += CLEANUP_CONCURRENCY) {
    const batch = workspaceIds.slice(i, i + CLEANUP_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (workspaceId) => {
        const settings = await getSettings(workspaceId);
        const retentionDays = settings.logRetentionDays || fallbackDays;
        const deleted = await deleteLogsOlderThan(workspaceId, retentionDays);
        return { workspaceId, deleted, retentionDays };
      }),
    );
    results.push(...batchResults);
  }

  const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);

  // Unrelated to log retention, but it's the same daily cron and there's no
  // reason to stand up a second one just for this — scrub any rotated-out
  // API key hash whose grace window has passed.
  const expiredKeysCleared = await clearExpiredPreviousApiKeys();

  return res.status(200).json({ workspaces: results.length, totalDeleted, expiredKeysCleared, results });
}