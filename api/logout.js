import { buildClearSessionCookie } from '../lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Set-Cookie', buildClearSessionCookie(req));
  return res.status(204).end();
}