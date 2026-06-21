import { getSessionUser } from './session.js';
import { getWorkspaceById } from './auth.js';

// ─────────────────────────────────────────
// Shared dashboard authorization check.
//
// Every dashboard-facing endpoint (logs, log-by-id, stats, settings,
// clear-logs) needs the same two checks: is there a valid session, and
// does that session's user actually own the workspaceId being requested?
// Centralized here so each endpoint can't drift out of sync on how it
// enforces that — e.g. forgetting the ownership check and only checking
// "is anyone logged in," which would let one account read another's logs.
//
// On failure, writes the response itself and returns null — callers just
// need to `if (!ctx) return;` right after calling this.
// On success, returns { user, workspace }.
// ─────────────────────────────────────────
export async function requireWorkspace(req, res, workspaceIdRaw) {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }

  const workspaceId = Number(workspaceIdRaw);
  if (!workspaceIdRaw || !Number.isFinite(workspaceId)) {
    res.status(400).json({ error: 'workspaceId is required' });
    return null;
  }

  const workspace = await getWorkspaceById(workspaceId);

  // 404 rather than 403 for a workspace that exists but belongs to someone
  // else — so this endpoint can't be used to confirm whether a given
  // workspaceId exists on another account.
  if (!workspace || Number(workspace.ownerUserId) !== Number(user.id)) {
    res.status(404).json({ error: 'Workspace not found' });
    return null;
  }

  return { user, workspace };
}