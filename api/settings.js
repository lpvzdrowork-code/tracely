import { getSettings, setLogRetentionDays } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = req.method === 'GET'
    ? req.headers['x-tracely-key']
    : (req.body || {}).tracelyKey;

  if (key !== process.env.TRACELY_KEY) {
    return res.status(401).end();
  }

  if (req.method === 'GET') {
    const settings = await getSettings();
    return res.status(200).json(settings);
  }

  // POST — update retention
  const { logRetentionDays } = req.body || {};
  try {
    const saved = await setLogRetentionDays(logRetentionDays);
    return res.status(200).json({ logRetentionDays: saved });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}