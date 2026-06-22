import { insertLog } from '../lib/db.js';
import { getWorkspaceByApiKey } from '../lib/auth.js';

const VALID_LEVELS = new Set(['INFO', 'WARN', 'ERROR']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { level, message, timestamp, gameId, tracelyKey } = req.body || {};

  // tracelyKey is now a per-workspace API key (tracely_live_...) instead of
  // one secret shared by every Roblox game on the instance. Each game
  // posts with the key generated for its own workspace.
  const workspace = await getWorkspaceByApiKey(tracelyKey);
  if (!workspace) {
    return res.status(401).end();
  }

  const normalizedLevel = typeof level === 'string' ? level.toUpperCase() : '';
  const numericTimestamp = Number(timestamp);
  const numericGameId = Number(gameId);

  const isValid =
    VALID_LEVELS.has(normalizedLevel) &&
    typeof message === 'string' &&
    message.trim().length > 0 &&
    Number.isFinite(numericTimestamp) &&
    // Roblox game IDs are always positive integers — 0 is never a real game
    // ID and most likely a misconfigured Roblox script. Rejecting it here
    // produces an immediate 400 that's easy to diagnose, rather than silently
    // storing logs under a nonsense ID that won't match any real game filter.
    Number.isFinite(numericGameId) && numericGameId > 0;

  if (!isValid) {
    return res.status(400).json({ error: 'Invalid log payload' });
  }

  const result = await insertLog({
    level: normalizedLevel,
    message: message.slice(0, 4000),
    timestamp: numericTimestamp,
    gameId: numericGameId,
    workspaceId: workspace.id,
  });

  if (!result.inserted) {
    return res.status(429).json({ error: 'Rate limited' });
  }

  return res.status(204).end();
}