import { getLogs } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.headers['x-tracely-key'] !== process.env.TRACELY_KEY) {
    return res.status(401).end();
  }

  const { level, gameId, page, limit, startTime, endTime } = req.query;

  const levels = typeof level === 'string' && level.length
    ? level.split(',').map((l) => l.trim()).filter(Boolean)
    : [];

  const data = await getLogs({ level: levels, gameId, startTime, endTime, page, limit });
  return res.status(200).json(data);
}