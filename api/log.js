import { insertLog } from '../lib/db.js';

const VALID_LEVELS = new Set(['INFO', 'WARN', 'ERROR']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { level, message, timestamp, gameId, tracelyKey } = req.body || {};

  if (tracelyKey !== process.env.TRACELY_KEY) {
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
    Number.isFinite(numericGameId);

  if (!isValid) {
    return res.status(400).json({ error: 'Invalid log payload' });
  }

  await insertLog({
    level: normalizedLevel,
    message: message.slice(0, 4000),
    timestamp: numericTimestamp,
    gameId: numericGameId,
  });

  return res.status(204).end();
}
