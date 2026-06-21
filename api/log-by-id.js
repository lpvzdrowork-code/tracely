import { getLogById } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.headers['x-tracely-key'] !== process.env.TRACELY_KEY) {
    return res.status(401).end();
  }

  const { id } = req.query;
  if (!id || !/^\d+$/.test(String(id))) {
    return res.status(400).json({ error: 'id must be numeric' });
  }

  const log = await getLogById(id);
  if (!log) {
    return res.status(404).json({ error: 'Log not found' });
  }

  return res.status(200).json({ log });
}