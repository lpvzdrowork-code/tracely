import { clearLogs } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tracelyKey, gameId } = req.body || {};

  if (tracelyKey !== process.env.TRACELY_KEY) {
    return res.status(401).end();
  }

  if (gameId !== undefined && gameId !== null && gameId !== '' && !Number.isFinite(Number(gameId))) {
    return res.status(400).json({ error: 'gameId must be numeric' });
  }

  const deleted = await clearLogs({ gameId });
  return res.status(200).json({ deleted });
}