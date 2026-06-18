import { getStats } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.headers['x-tracely-key'] !== process.env.TRACELY_KEY) {
    return res.status(401).end();
  }

  const data = await getStats();
  return res.status(200).json(data);
}
