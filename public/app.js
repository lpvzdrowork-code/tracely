/* ─────────────────────────────────────────
   Tracely — app.js
   Three-pane workspace logic
───────────────────────────────────────── */

const REFRESH_MS   = 5000;
const LEVEL_COLORS = { INFO: '#3b82f6', WARN: '#f59e0b', ERROR: '#ef4444' };

// ── Auth elements ──
const authOverlay       = document.getElementById('authOverlay');
const authForm           = document.getElementById('authForm');
const authTabs           = document.querySelectorAll('.auth-tab');
const authEmail          = document.getElementById('authEmail');
const authPassword       = document.getElementById('authPassword');
const authWorkspaceName  = document.getElementById('authWorkspaceName');
const authError          = document.getElementById('authError');
const authSubmitBtn      = document.getElementById('authSubmitBtn');
const authSubmitLabel    = document.querySelector('.auth-submit-label');
const authSpinner        = document.querySelector('.auth-spinner');

// ── API key reveal (shown once, right after signup) ──
const apiKeyReveal      = document.getElementById('apiKeyReveal');
const apiKeyValueEl     = document.getElementById('apiKeyValue');
const apiKeyCopyBtn     = document.getElementById('apiKeyCopyBtn');
const apiKeyCopiedNote  = document.getElementById('apiKeyCopiedNote');
const apiKeyContinueBtn = document.getElementById('apiKeyContinueBtn');

// ── App shell ──
const appEl       = document.getElementById('app');
const lastUpdated = document.getElementById('lastUpdated');

// ── Ingestion pulse ──
const ingestPulseEl = document.getElementById('ingestPulse');

// ── Stats ──
const statInfoEl  = document.getElementById('statInfo');
const statWarnEl  = document.getElementById('statWarn');
const statErrorEl = document.getElementById('statError');

// ── Log feed ──
const logFeedEl   = document.getElementById('logFeed');
const emptyState  = document.getElementById('emptyState');
const logTotalEl  = document.getElementById('logTotal');

// ── Search + filters ──
const searchInput       = document.getElementById('searchInput');
const levelCheckboxes   = document.querySelectorAll('.level-checkbox');
const gameIdFilterEl    = document.getElementById('gameIdFilter');
const startTimeFilterEl = document.getElementById('startTimeFilter');
const endTimeFilterEl   = document.getElementById('endTimeFilter');
const applyFiltersBtn   = document.getElementById('applyFilters');
const clearFiltersBtn   = document.getElementById('clearFilters');
const toggleFiltersBtn  = document.getElementById('toggleFilters');
const filterExtrasEl    = document.getElementById('filterExtras');
const quickRangeBtns    = document.querySelectorAll('.quick-range-btn');

// ── Detail drawer ──
const detailDrawer = document.getElementById('detailDrawer');
const detailBody   = document.getElementById('detailBody');
const detailClose  = document.getElementById('detailClose');

// ── Nav ──
const navItems = document.querySelectorAll('.nav-item');

// ── Workspace switcher (nav) ──
const navWsBtn     = document.getElementById('navWsBtn');
const navWsPanel   = document.getElementById('navWsPanel');
const navWsList    = document.getElementById('navWsList');
const navWsInitial = document.getElementById('navWsInitial');
const navWsNewBtn  = document.getElementById('navWsNewBtn');

// ── Workspaces (Settings) ──
const wsSettingsList  = document.getElementById('wsSettingsList');
const wsNewNameInput  = document.getElementById('wsNewNameInput');
const wsNewCreateBtn  = document.getElementById('wsNewCreateBtn');
const wsNewError      = document.getElementById('wsNewError');
const wsNewKeyBox     = document.getElementById('wsNewKeyBox');
const wsNewKeyValue   = document.getElementById('wsNewKeyValue');
const wsNewKeyCopyBtn = document.getElementById('wsNewKeyCopyBtn');
const wsNewKeyNote    = document.getElementById('wsNewKeyNote');

// ── Settings ──
const lockBtn             = document.getElementById('lockBtn');
const accountEmailHint    = document.getElementById('accountEmailHint');

// ─────────────────────────────────────────
// State
// ─────────────────────────────────────────
let chart          = null;
let refreshTimer   = null;
let knownLogIds    = new Set();
let logDataById     = new Map(); // id -> raw log object from the API, refreshed every poll
let selectedLogId  = null;
let searchDebounce = null;
let isPaused       = false;
let kbFocusedId    = null;
let pendingPermalink = null; // { gameId, logId, after, before } parsed from URL on load, consumed once
let pendingUrlPermalink = null; // set just below, once parsePermalinkFromUrl() is defined and DOM is ready

let activeFilters = {
  search: '',
  levels: [],
  gameId: '',
  startTime: '',
  endTime: '',
  startTimeRelative: '',
  endTimeRelative: '',
};

let currentUser      = null; // { id, email }
let currentWorkspace = null; // { id, name, apiKeyLast4 } — the active workspace
let allWorkspaces    = [];   // every workspace this account owns — [{ id, name, apiKeyLast4, createdAt }]
const ACTIVE_WS_KEY  = 'tracelyActiveWorkspaceId'; // remembers the last-picked workspace across reloads
let authMode          = 'login'; // 'login' | 'signup'

// ─────────────────────────────────────────
// Auth
//
// There's no client-held secret anymore. /api/login and /api/signup set an
// HttpOnly session cookie (lib/session.js); the browser attaches it to
// every same-origin request automatically, so app.js never reads or
// stores it. Every dashboard fetch below just needs the current
// workspaceId as a query param (GET) or body field (POST) — the server
// resolves "who's asking" from the cookie via requireWorkspace().
// ─────────────────────────────────────────

function setAuthMode(mode) {
  authMode = mode;
  authTabs.forEach((tab) => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  authWorkspaceName.hidden = mode !== 'signup';
  authPassword.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  authSubmitLabel.textContent = mode === 'signup' ? 'Sign up' : 'Log in';
  authError.hidden = true;
}

authTabs.forEach((tab) => {
  tab.addEventListener('click', () => setAuthMode(tab.dataset.mode));
});

function setAuthLoading(loading) {
  authSubmitBtn.disabled = loading;
  authSubmitLabel.hidden = loading;
  authSpinner.hidden = !loading;
}

function showAuthError(message) {
  authError.textContent = message;
  authError.hidden = false;
}

// GET /api/workspaces doubles as "am I already logged in?" on page load —
// a 401 just means there's no valid session cookie yet, which is the
// normal logged-out state, not a real error.
async function checkExistingSession() {
  try {
    const res = await fetch('/api/workspaces', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const data = await res.json();
    return data.workspaces ?? [];
  } catch {
    return [];
  }
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) return;

  authError.hidden = true;
  setAuthLoading(true); // fires immediately on submit, not after the request resolves

  try {
    if (authMode === 'signup') {
      const workspaceName = authWorkspaceName.value.trim();
      const res = await fetch('/api/signup', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, workspaceName: workspaceName || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      currentUser = data.user || currentUser;
      if (data.workspace?.apiKey) {
        // The account and workspace are committed even on a non-ok
        // response here if signing-in afterward failed server-side — the
        // key still only exists this once, so show it regardless of
        // status, then surface the error underneath.
        showApiKeyReveal(data.workspace);
        if (!res.ok && data.error) showAuthError(data.error);
        return;
      }
      if (!res.ok) {
        showAuthError(data.error || 'Could not create your account.');
        return;
      }
      if (!data.workspace) {
        showAuthError(data.warning || 'Account created, but workspace setup failed.');
      }
    } else {
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showAuthError(data.error || 'Invalid email or password.');
        return;
      }
      currentUser = data.user;
      allWorkspaces = data.workspaces ?? [];
      const workspace = pickInitialWorkspace(allWorkspaces);
      if (!workspace) {
        showAuthError('No workspace found on this account yet.');
        return;
      }
      enterDashboard(workspace);
    }
  } catch {
    showAuthError("Couldn't reach the server — check your connection and try again.");
  } finally {
    setAuthLoading(false);
  }
});

function showApiKeyReveal(workspace) {
  currentWorkspace = { id: workspace.id, name: workspace.name, apiKeyLast4: workspace.apiKeyLast4 };
  allWorkspaces = [{ id: workspace.id, name: workspace.name, apiKeyLast4: workspace.apiKeyLast4, createdAt: workspace.createdAt }];
  authForm.hidden = true;
  apiKeyValueEl.textContent = workspace.apiKey;
  apiKeyCopiedNote.hidden = true;
  apiKeyReveal.hidden = false;
}

if (apiKeyCopyBtn) {
  apiKeyCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(apiKeyValueEl.textContent);
      apiKeyCopiedNote.hidden = false;
    } catch {
      /* Clipboard API unavailable (e.g. http://, older browser) — the key
         is still visible and selectable, so this isn't a hard failure. */
    }
  });
}

if (apiKeyContinueBtn) {
  apiKeyContinueBtn.addEventListener('click', () => enterDashboard(currentWorkspace));
}

function enterDashboard(workspace) {
  currentWorkspace = { id: workspace.id, name: workspace.name, apiKeyLast4: workspace.apiKeyLast4 };
  setActiveWorkspaceId(currentWorkspace.id);
  if (!allWorkspaces.some((w) => Number(w.id) === Number(currentWorkspace.id))) {
    allWorkspaces = [...allWorkspaces, currentWorkspace];
  }
  authForm.reset();
  authForm.hidden = false;
  apiKeyReveal.hidden = true;
  unlockApp();
  renderWorkspaceSwitcher();
  renderWorkspacesSettingsList();
  updateOnboardingSnippet();
  if (pendingUrlPermalink) primePermalink(pendingUrlPermalink);
}

// Populates the "send your first log" snippet in the empty-state with the
// current workspace's host + key hint. Pulled out of enterDashboard so
// switchWorkspace() can refresh it too when the active workspace changes.
//
// `lines` is the single source of truth for both the on-screen HTML (which
// needs <br>/&nbsp; since <code> collapses whitespace) and the plain-text
// version kept for the copy button — building both from one array means
// they can't quietly drift apart the way two hand-written strings could.
let onboardSnippetPlainText = '';

function updateOnboardingSnippet() {
  const snippetEl = document.getElementById('onboardSnippet');
  if (!snippetEl) return;
  const host = window.location.host;
  const key  = currentWorkspace?.apiKeyLast4
    ? `tracely_live_…${currentWorkspace.apiKeyLast4}`
    : 'tracely_live_…';

  const lines = [
    `HttpService:PostAsync("https://${host}/api/log", HttpService:JSONEncode({`,
    `  tracelyKey = "${key}",`,
    `  level = "INFO",`,
    `  message = "Hello from Roblox",`,
    `  timestamp = os.time(),`,
    `  gameId = game.GameId`,
    `}))`,
  ];

  onboardSnippetPlainText = lines.join('\n');
  snippetEl.innerHTML = lines
    .map((line) => line.replace(/^( +)/, (spaces) => '&nbsp;'.repeat(spaces.length)))
    .join('<br>');
}

const onboardSnippetCopyBtn = document.getElementById('onboardSnippetCopyBtn');
if (onboardSnippetCopyBtn) {
  onboardSnippetCopyBtn.addEventListener('click', async () => {
    try {
      // Copies the masked key as-is — there's no way around that, the raw
      // key only ever exists in memory at creation time. The note under
      // the snippet tells people to swap it for their real key before
      // running this in Roblox.
      await navigator.clipboard.writeText(onboardSnippetPlainText);
      const original = onboardSnippetCopyBtn.textContent;
      onboardSnippetCopyBtn.textContent = 'Copied';
      setTimeout(() => { onboardSnippetCopyBtn.textContent = original; }, 1500);
    } catch {
      /* Clipboard API unavailable — snippet is still visible/selectable. */
    }
  });
}

function unlockApp() {
  authOverlay.hidden = true;
  appEl.hidden = false;
  updateAccountInfo();
  startPolling();
}

function updateAccountInfo() {
  if (accountEmailHint && currentUser) {
    accountEmailHint.textContent = `Signed in as ${currentUser.email}.`;
  }
}

async function lockApp(message) {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* Cookie may already be invalid server-side — clearing local state
       below is what actually locks the UI either way. */
  }
  currentUser = null;
  currentWorkspace = null;
  allWorkspaces = [];
  stopPolling();
  appEl.hidden = true;
  authOverlay.hidden = false;
  apiKeyReveal.hidden = true;
  authForm.hidden = false;
  authForm.reset();
  setAuthMode('login');
  setAuthLoading(false);
  closeWsSwitcherPanel();
  if (navWsList) navWsList.innerHTML = '';
  if (wsSettingsList) wsSettingsList.innerHTML = '';
  if (wsNewKeyBox)  wsNewKeyBox.hidden = true;
  if (wsNewKeyNote) wsNewKeyNote.hidden = true;
  if (wsNewNameInput) wsNewNameInput.value = '';
  if (message) showAuthError(message);
}

if (lockBtn) lockBtn.addEventListener('click', () => lockApp());

// ─────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────
navItems.forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    navItems.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    document.querySelectorAll('.view').forEach((v) => { v.hidden = true; });
    const target = document.getElementById(`view-${view}`);
    if (target) target.hidden = false;

    if (view === 'metrics' && chart) chart.update();
  });
});

// ─────────────────────────────────────────
// WORKSPACES (multi-workspace switcher)
//
// One Tracely account can own several workspaces (one per Roblox game).
// `allWorkspaces` is the full list for the signed-in account; `currentWorkspace`
// is whichever one is active in the dashboard right now. The active choice is
// remembered in localStorage so a reload doesn't always snap back to the
// first workspace in the list.
// ─────────────────────────────────────────

// Matches the stroke-width/viewBox of the nav-rail icons in index.html so
// it doesn't look like a different icon set bolted on.
const WS_TRASH_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;


function pickInitialWorkspace(list) {
  if (!list || !list.length) return null;
  const savedId = Number(localStorage.getItem(ACTIVE_WS_KEY));
  const saved = list.find((w) => Number(w.id) === savedId);
  return saved || list[0];
}

function setActiveWorkspaceId(id) {
  try { localStorage.setItem(ACTIVE_WS_KEY, String(id)); } catch { /* storage unavailable — not fatal */ }
}

function renderWorkspaceSwitcher() {
  if (navWsInitial) {
    navWsInitial.textContent = currentWorkspace?.name?.trim()?.charAt(0)?.toUpperCase() || '?';
  }
  if (navWsBtn) {
    navWsBtn.title = currentWorkspace ? `Workspace: ${currentWorkspace.name}` : 'Switch workspace';
  }
  if (!navWsList) return;

  navWsList.innerHTML = '';
  for (const ws of allWorkspaces) {
    const isActive = !!currentWorkspace && Number(ws.id) === Number(currentWorkspace.id);

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'nav-ws-row' + (isActive ? ' active' : '');
    row.dataset.id = ws.id;
    row.setAttribute('role', 'menuitem');

    const dot = document.createElement('span');
    dot.className = 'nav-ws-row-dot';

    const name = document.createElement('span');
    name.className = 'nav-ws-row-name';
    name.textContent = ws.name;

    row.append(dot, name);
    row.addEventListener('click', () => {
      closeWsSwitcherPanel();
      if (!isActive) switchWorkspace(ws.id);
    });
    navWsList.appendChild(row);
  }
}

function renderWorkspacesSettingsList() {
  if (!wsSettingsList) return;
  wsSettingsList.innerHTML = '';

  for (const ws of allWorkspaces) {
    const isActive = !!currentWorkspace && Number(ws.id) === Number(currentWorkspace.id);

    const row = document.createElement('div');
    row.className = 'ws-row' + (isActive ? ' active' : '');

    const text = document.createElement('div');
    text.className = 'ws-row-text';

    const name = document.createElement('span');
    name.className = 'ws-row-name';
    name.textContent = ws.name;

    const key = document.createElement('span');
    key.className = 'ws-row-key';
    key.textContent = `····${ws.apiKeyLast4 ?? '····'}`;

    text.append(name, key);
    row.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'ws-row-actions';

    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'ws-row-current';
      badge.textContent = 'Current';
      actions.appendChild(badge);
    } else {
      const switchBtn = document.createElement('button');
      switchBtn.type = 'button';
      switchBtn.className = 'btn-ghost btn-sm';
      switchBtn.textContent = 'Switch';
      switchBtn.addEventListener('click', () => switchWorkspace(ws.id));
      actions.appendChild(switchBtn);

      // Delete is only ever offered on a row that isn't the active
      // workspace — switching away first is what stands in for "you can't
      // delete the one you're currently looking at," so there's no extra
      // state to track for that rule. Also hidden entirely when this is
      // the last workspace left, matching the server-side guard in
      // DELETE /api/workspaces.
      if (allWorkspaces.length > 1) {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'ws-row-delete';
        deleteBtn.title = `Delete ${ws.name}`;
        deleteBtn.setAttribute('aria-label', `Delete ${ws.name}`);
        deleteBtn.innerHTML = WS_TRASH_ICON_SVG;
        deleteBtn.addEventListener('click', () => openDeleteWsModal(ws));
        actions.appendChild(deleteBtn);
      }
    }

    row.appendChild(actions);
    wsSettingsList.appendChild(row);
  }
}

function openWsSwitcherPanel() {
  if (!navWsPanel) return;
  navWsPanel.hidden = false;
  if (navWsBtn) navWsBtn.setAttribute('aria-expanded', 'true');
}

function closeWsSwitcherPanel() {
  if (!navWsPanel) return;
  navWsPanel.hidden = true;
  if (navWsBtn) navWsBtn.setAttribute('aria-expanded', 'false');
}

if (navWsBtn) {
  navWsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (navWsPanel.hidden) openWsSwitcherPanel();
    else closeWsSwitcherPanel();
  });
}

if (navWsNewBtn) {
  navWsNewBtn.addEventListener('click', () => {
    closeWsSwitcherPanel();
    // Jump to Settings, where the "create workspace" form lives.
    document.querySelector('.nav-item[data-view="settings"]')?.click();
    wsNewNameInput?.focus();
  });
}

document.addEventListener('click', (e) => {
  if (!navWsPanel || navWsPanel.hidden) return;
  if (navWsPanel.contains(e.target) || navWsBtn?.contains(e.target)) return;
  closeWsSwitcherPanel();
});

// Clears every piece of UI state that's specific to the previously-active
// workspace (rows, chart, stats, selection) so nothing from the old
// workspace lingers on screen while the new one's first refresh is in flight.
function resetWorkspaceData() {
  closeDrawer();
  knownLogIds = new Set();
  logDataById = new Map();
  selectedLogId = null;
  kbFocusedId = null;
  if (logFeedEl) logFeedEl.innerHTML = '';
  renderStats({ counts: {} });
  renderChart([]);
}

function switchWorkspace(id) {
  const ws = allWorkspaces.find((w) => Number(w.id) === Number(id));
  if (!ws) return;

  currentWorkspace = { id: ws.id, name: ws.name, apiKeyLast4: ws.apiKeyLast4 };
  setActiveWorkspaceId(currentWorkspace.id);

  resetWorkspaceData();
  updateAccountInfo();
  renderWorkspaceSwitcher();
  renderWorkspacesSettingsList();
  updateOnboardingSnippet();
  loadRetentionSetting();

  // Game IDs and filter state belong to the previous workspace — reset the
  // filter bar to defaults, which (per its own handler) also clears
  // knownLogIds and triggers a fresh fetch scoped to the new workspace.
  if (clearFiltersBtn) clearFiltersBtn.click();
}

async function createNewWorkspace() {
  const name = (wsNewNameInput?.value || '').trim();
  if (wsNewError) wsNewError.hidden = true;

  if (!name) {
    if (wsNewError) { wsNewError.textContent = 'Workspace name is required.'; wsNewError.hidden = false; }
    return;
  }

  if (wsNewCreateBtn) wsNewCreateBtn.disabled = true;
  try {
    const res = await fetch('/api/workspaces', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (wsNewError) { wsNewError.textContent = data.error || 'Could not create workspace.'; wsNewError.hidden = false; }
      return;
    }

    allWorkspaces = [...allWorkspaces, data.workspace];
    if (wsNewNameInput) wsNewNameInput.value = '';

    // The raw key only ever comes back here, once — show it immediately.
    if (wsNewKeyValue) wsNewKeyValue.textContent = data.workspace.apiKey;
    if (wsNewKeyBox)   wsNewKeyBox.hidden = false;
    if (wsNewKeyNote)  wsNewKeyNote.hidden = false;

    switchWorkspace(data.workspace.id);
  } catch {
    if (wsNewError) { wsNewError.textContent = "Couldn't reach the server — try again."; wsNewError.hidden = false; }
  } finally {
    if (wsNewCreateBtn) wsNewCreateBtn.disabled = false;
  }
}

if (wsNewCreateBtn) wsNewCreateBtn.addEventListener('click', createNewWorkspace);
if (wsNewNameInput) {
  wsNewNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createNewWorkspace(); }
  });
}
if (wsNewKeyCopyBtn) {
  wsNewKeyCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(wsNewKeyValue.textContent);
      const original = wsNewKeyCopyBtn.textContent;
      wsNewKeyCopyBtn.textContent = 'Copied';
      setTimeout(() => { wsNewKeyCopyBtn.textContent = original; }, 1500);
    } catch {
      /* Clipboard API unavailable — key is still visible/selectable. */
    }
  });
}

// ─────────────────────────────────────────
// Polling
// ─────────────────────────────────────────
const streamToggle = document.getElementById('streamToggle');
const streamDot    = document.getElementById('streamDot');
const streamLabel  = document.getElementById('streamLabel');
const navLiveDot   = document.getElementById('liveDot');

function startPolling() {
  refresh();
  stopPolling();
  if (!isPaused) refreshTimer = setInterval(refresh, REFRESH_MS);
}

function stopPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function applyStreamUI() {
  if (streamToggle) streamToggle.classList.toggle('paused', isPaused);
  if (streamLabel)  streamLabel.textContent = isPaused ? 'Paused' : 'Live';
  if (streamDot)    streamDot.classList.toggle('dot-paused', isPaused);
  if (navLiveDot)   navLiveDot.classList.toggle('dot-paused', isPaused);
}

function triggerIngestPulse() {
  if (!ingestPulseEl) return;
  ingestPulseEl.hidden = false;
  ingestPulseEl.classList.remove('pulse-flash');
  // Force reflow so re-adding the class restarts the animation
  void ingestPulseEl.offsetWidth;
  ingestPulseEl.classList.add('pulse-flash');
}

function setPaused(paused) {
  isPaused = paused;
  applyStreamUI();
  if (isPaused) {
    stopPolling();
    lastUpdated.textContent = `paused at ${new Date().toLocaleTimeString()}`;
  } else {
    startPolling();
  }
}

if (streamToggle) {
  streamToggle.addEventListener('click', () => setPaused(!isPaused));
}

async function refresh() {
  if (isPaused || !currentWorkspace) return;
  try {
    const [statsRes, logsRes] = await Promise.all([
      fetch(`/api/stats?workspaceId=${currentWorkspace.id}`, { credentials: 'same-origin' }),
      fetch(buildLogsUrl(),   { credentials: 'same-origin' }),
    ]);

    if (statsRes.status === 401 || logsRes.status === 401) {
      lockApp('Session expired. Please log in again.');
      return;
    }

    const stats    = await statsRes.json();
    const logsData = await logsRes.json();

    const prevSize = knownLogIds.size;
    renderStats(stats);
    renderChart(stats.hourly ?? []);
    renderLogs(logsData.logs, logsData.total);

    // Flash the ingestion pulse whenever new log rows arrive
    if (!isPaused && knownLogIds.size > prevSize) triggerIngestPulse();

    lastUpdated.textContent = `updated ${new Date().toLocaleTimeString()}`;

    // A pending permalink (from a shared URL) is resolved against the
    // first successful refresh, then cleared so later polls don't keep
    // re-triggering the scroll/highlight.
    if (pendingPermalink) {
      const target = pendingPermalink;
      pendingPermalink = null;
      resolvePermalink(target);
    }
  } catch {
    lastUpdated.textContent = 'connection lost — retrying…';
  }
}

// ─────────────────────────────────────────
// URL builder
// ─────────────────────────────────────────
function buildLogsUrl() {
  const params = new URLSearchParams();
  params.set('workspaceId', currentWorkspace.id);
  if (activeFilters.levels.length) params.set('level', activeFilters.levels.join(','));
  if (activeFilters.gameId)        params.set('gameId', activeFilters.gameId);

  // Relative windows (after:5m, after:1h…) are re-resolved against "now" on
  // every call instead of once at parse time, so a quick-range filter keeps
  // rolling forward as new logs arrive rather than freezing at click time.
  const startTime = resolveTimeFilter(activeFilters.startTime, activeFilters.startTimeRelative);
  const endTime   = resolveTimeFilter(activeFilters.endTime, activeFilters.endTimeRelative);
  if (startTime) params.set('startTime', startTime);
  if (endTime)   params.set('endTime', endTime);

  params.set('limit', activeFilters.search ? '200' : '100');
  return `/api/logs?${params.toString()}`;
}

function resolveTimeFilter(absolute, relative) {
  if (relative) {
    const ts = parseRelativeTime(relative);
    return ts !== null ? String(ts) : '';
  }
  return absolute || '';
}

// ─────────────────────────────────────────
// Stats
// ─────────────────────────────────────────
function renderStats(stats) {
  const counts = stats.counts ?? stats;
  statInfoEl.textContent  = (counts.INFO  ?? 0).toLocaleString();
  statWarnEl.textContent  = (counts.WARN  ?? 0).toLocaleString();
  statErrorEl.textContent = (counts.ERROR ?? 0).toLocaleString();
}

// ─────────────────────────────────────────
// Chart
// ─────────────────────────────────────────
function buildHourBuckets() {
  const now              = Math.floor(Date.now() / 1000);
  const currentHourStart = Math.floor(now / 3600) * 3600;
  const buckets = [];
  for (let i = 23; i >= 0; i--) buckets.push(currentHourStart - i * 3600);
  return buckets;
}

function renderChart(hourly) {
  const buckets    = buildHourBuckets();
  const dataByLevel = { INFO: [], WARN: [], ERROR: [] };

  for (const bucket of buckets) {
    const matches = hourly.filter((r) => r.bucket === bucket);
    for (const level of ['INFO', 'WARN', 'ERROR']) {
      const found = matches.find((r) => r.level === level);
      dataByLevel[level].push(found ? found.count : 0);
    }
  }

  const labels   = buckets.map((ts) =>
    new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );
  const datasets = ['INFO', 'WARN', 'ERROR'].map((level) => ({
    label: level, data: dataByLevel[level],
    backgroundColor: LEVEL_COLORS[level], stack: 'logs',
  }));

  if (!chart) {
    const ctx = document.getElementById('activityChart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: {
              color: '#888', usePointStyle: true, pointStyle: 'circle',
              boxWidth: 7, boxHeight: 7, padding: 16,
              font: { family: 'Inter', size: 12 },
            },
          },
          tooltip: {
            backgroundColor: '#1f1f1f', borderColor: '#2a2a2a', borderWidth: 1,
            titleColor: '#fff', bodyColor: '#888', padding: 10, cornerRadius: 8,
            titleFont: { family: 'Inter', size: 12, weight: '600' },
            bodyFont: { family: 'JetBrains Mono', size: 12 }, boxPadding: 4,
          },
        },
        scales: {
          x: { stacked: true, ticks: { color: '#888', font: { family: 'Inter', size: 11 } }, grid: { display: false }, border: { color: '#2a2a2a' } },
          y: { stacked: true, ticks: { color: '#888', font: { family: 'Inter', size: 11 }, precision: 0 }, grid: { color: '#202020' }, border: { display: false } },
        },
      },
    });
  } else {
    chart.data.labels   = labels;
    chart.data.datasets = datasets;
    chart.update();
  }
}

// ─────────────────────────────────────────
// ── SMART QUERY PARSER ──
//
// Supported tokens (all case-insensitive):
//   level:<value>          INFO, WARN, ERROR — comma-separated ok
//   level:<a>,<b>          e.g. level:warn,error
//   game:<id>              numeric game ID
//   game_id:<id>           alias for game:
//   id:<n>                 filter to a specific log ID (client-side)
//   after:<time>           ISO date, or relative: 1h 30m 2d 1w
//   before:<time>          same formats
//   <bare text>            message substring search
//
// Returns a ParsedQuery object consumed by applyParsedQuery().
// ─────────────────────────────────────────

const VALID_LEVELS = new Set(['INFO', 'WARN', 'ERROR']);

// Maps short aliases → canonical key
const TOKEN_ALIASES = {
  level:   'level',
  lvl:     'level',
  game:    'game',
  game_id: 'game',
  gameid:  'game',
  after:   'after',
  since:   'after',
  from:    'after',
  before:  'before',
  until:   'before',
  to:      'before',
  id:      'id',
};

// All canonical keys we recognise, for autocomplete
const KNOWN_KEYS = Object.keys(TOKEN_ALIASES);

/**
 * Parse a relative time string like "3h", "2d", "30m", "1w"
 * into a Unix timestamp (seconds). Returns null if not a relative expr.
 */
function parseRelativeTime(val) {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d|day|w|wk|week)s?$/i.exec(val.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const multipliers = { m: 60, min: 60, h: 3600, hr: 3600, d: 86400, day: 86400, w: 604800, wk: 604800, week: 604800 };
  return Math.floor(Date.now() / 1000) - n * multipliers[unit];
}

/**
 * Parse an absolute or relative date/time string into Unix seconds.
 * Returns { ts: number, error: string|null }
 */
function parseTimeValue(raw) {
  const rel = parseRelativeTime(raw);
  if (rel !== null) return { ts: rel, error: null };

  // Try native Date parse (handles ISO, "Jan 15 2024", etc.)
  const ms = Date.parse(raw);
  if (!isNaN(ms)) return { ts: Math.floor(ms / 1000), error: null };

  return { ts: null, error: `"${raw}" isn't a valid date or relative time (e.g. 3h, 2d, 2024-01-15)` };
}

/**
 * Core parser. Returns:
 * {
 *   levels: string[],        // ['INFO','WARN'] etc., empty = all
 *   gameId: string,          // '' = no filter
 *   logId:  string,          // '' = no filter
 *   startTime: string,       // unix seconds as string, or ''
 *   endTime:   string,       // unix seconds as string, or ''
 *   search: string,          // remaining free text
 *   tokens: Token[],         // for pill rendering
 * }
 *
 * Token: { key, rawKey, value, valid, error }
 */
function parseQuery(raw) {
  const result = {
    levels: [], gameId: '', logId: '', startTime: '', endTime: '',
    startTimeRelative: '', endTimeRelative: '', search: '',
    tokens: [],
  };

  if (!raw || !raw.trim()) return result;

  // Tokenise: match `key:value` pairs (value may be quoted) and bare words
  // Pattern: (\w+):(\"[^\"]*\"|'[^']*'|\S+)  OR  \S+
  const tokenRe = /(\w+):(\"[^\"]*\"|'[^']*'|\S+)|(\S+)/g;
  const freeParts = [];
  let match;

  while ((match = tokenRe.exec(raw)) !== null) {
    if (match[1]) {
      // key:value token
      const rawKey   = match[1].toLowerCase();
      const rawValue = match[2].replace(/^['"]|['"]$/g, ''); // strip quotes
      const canonical = TOKEN_ALIASES[rawKey];

      if (!canonical) {
        // Unknown key — treat the whole thing as free text
        freeParts.push(match[0]);
        continue;
      }

      const token = { key: canonical, rawKey, value: rawValue, valid: true, error: null };

      if (canonical === 'level') {
        const parts = rawValue.split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
        const invalid = parts.filter((p) => !VALID_LEVELS.has(p));
        if (invalid.length) {
          token.valid = false;
          token.error = `Unknown level(s): ${invalid.join(', ')}. Use INFO, WARN, or ERROR.`;
        } else {
          // Merge — later tokens add to existing set
          const merged = new Set([...result.levels, ...parts]);
          result.levels = [...merged];
        }

      } else if (canonical === 'game') {
        const n = Number(rawValue);
        if (!rawValue || isNaN(n) || !Number.isFinite(n)) {
          token.valid = false;
          token.error = `Game ID must be a number, got "${rawValue}".`;
        } else {
          result.gameId = String(Math.round(n));
        }

      } else if (canonical === 'id') {
        const n = Number(rawValue);
        if (!rawValue || isNaN(n) || !Number.isFinite(n)) {
          token.valid = false;
          token.error = `Log ID must be a number, got "${rawValue}".`;
        } else {
          result.logId = String(Math.round(n));
        }

      } else if (canonical === 'after') {
        const { ts, error } = parseTimeValue(rawValue);
        if (error) {
          token.valid = false; token.error = error;
        } else if (parseRelativeTime(rawValue) !== null) {
          // Relative expressions (5m, 1h, 24h…) stay "live" — re-resolved
          // against the current time on every poll instead of freezing at
          // the moment the filter was set.
          result.startTimeRelative = rawValue;
        } else {
          result.startTime = String(ts);
        }

      } else if (canonical === 'before') {
        const { ts, error } = parseTimeValue(rawValue);
        if (error) {
          token.valid = false; token.error = error;
        } else if (parseRelativeTime(rawValue) !== null) {
          result.endTimeRelative = rawValue;
        } else {
          result.endTime = String(ts);
        }
      }

      result.tokens.push(token);

    } else {
      // Bare word / free text
      freeParts.push(match[3]);
    }
  }

  result.search = freeParts.join(' ').trim();
  return result;
}

// ─────────────────────────────────────────
// Apply parsed query → activeFilters + UI sync
// ─────────────────────────────────────────
function applyParsedQuery(parsed) {
  activeFilters = {
    search:            parsed.search,
    levels:            parsed.levels,
    gameId:            parsed.gameId,
    startTime:         parsed.startTime,
    endTime:           parsed.endTime,
    startTimeRelative: parsed.startTimeRelative,
    endTimeRelative:   parsed.endTimeRelative,
    logId:             parsed.logId ?? '',
  };

  // Sync the legacy checkbox UI so they stay consistent
  levelCheckboxes.forEach((cb) => {
    cb.checked = parsed.levels.includes(cb.value);
  });
  if (gameIdFilterEl) gameIdFilterEl.value = parsed.gameId;

  // Sync datetime-local inputs — only for absolute timestamps. A relative
  // window ("last 5m") can't be represented as a fixed calendar value, so
  // the picker stays blank and the search-bar pill remains the source of truth.
  if (startTimeFilterEl && parsed.startTime && !parsed.startTimeRelative) {
    const d = new Date(Number(parsed.startTime) * 1000);
    startTimeFilterEl.value = toDatetimeLocal(d);
  } else if (startTimeFilterEl) {
    startTimeFilterEl.value = '';
  }
  if (endTimeFilterEl && parsed.endTime && !parsed.endTimeRelative) {
    const d = new Date(Number(parsed.endTime) * 1000);
    endTimeFilterEl.value = toDatetimeLocal(d);
  } else if (endTimeFilterEl) {
    endTimeFilterEl.value = '';
  }

  renderTokenPills(parsed.tokens);
  syncQuickRangeButtons(parsed.tokens);
  knownLogIds.clear();
  refresh();
}

function toDatetimeLocal(date) {
  // Returns "YYYY-MM-DDTHH:MM" for datetime-local input
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ─────────────────────────────────────────
// Quick range shortcuts (5m / 1h / 24h)
// ─────────────────────────────────────────

/** Highlight whichever quick-range button matches the current `after:` token, if any. */
function syncQuickRangeButtons(tokens) {
  const afterToken = tokens.find((t) => t.key === 'after' && t.valid);
  const rawVal = afterToken ? afterToken.value.toLowerCase() : null;
  quickRangeBtns.forEach((btn) => {
    btn.classList.toggle('active', rawVal !== null && rawVal === btn.dataset.range.toLowerCase());
  });
}

/** Strip every token for a canonical key (e.g. 'after') out of the search bar and re-apply. */
function clearQueryKey(canonical) {
  let current = searchInput.value;
  for (const alias of Object.entries(TOKEN_ALIASES).filter(([, c]) => c === canonical).map(([a]) => a)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\s)${escaped}:(?:"[^"]*"|'[^']*'|\\S+)`, 'gi');
    current = current.replace(re, ' ');
  }
  current = current.trim().replace(/\s{2,}/g, ' ');
  searchInput.value = current;
  applyParsedQuery(parseQuery(current));
}

quickRangeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    // Click an active button again to clear the time filter entirely.
    if (btn.classList.contains('active')) {
      clearQueryKey('after');
    } else {
      injectQueryToken(`after:${btn.dataset.range}`);
    }
  });
});

// ─────────────────────────────────────────
// Token pills
// ─────────────────────────────────────────
function renderTokenPills(tokens) {
  let pillBar = document.getElementById('queryPillBar');
  if (!pillBar) return;

  pillBar.innerHTML = '';
  if (!tokens.length) {
    pillBar.hidden = true;
    return;
  }
  pillBar.hidden = false;

  for (const token of tokens) {
    const pill = document.createElement('span');
    pill.className = 'query-pill' + (token.valid ? '' : ' query-pill-error');
    if (token.error) pill.title = token.error;

    const keyEl = document.createElement('span');
    keyEl.className   = 'pill-key';
    keyEl.textContent = token.rawKey;

    const sep = document.createElement('span');
    sep.className   = 'pill-sep';
    sep.textContent = ':';

    const valEl = document.createElement('span');
    valEl.className = 'pill-val';

    // For level tokens, colour-code the value
    if (token.key === 'level' && token.valid) {
      const parts = token.value.split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
      parts.forEach((p, i) => {
        const s = document.createElement('span');
        s.className   = `pill-level-${p.toLowerCase()}`;
        s.textContent = p.charAt(0) + p.slice(1).toLowerCase();
        valEl.appendChild(s);
        if (i < parts.length - 1) {
          const comma = document.createElement('span');
          comma.className   = 'pill-sep';
          comma.textContent = ',';
          valEl.appendChild(comma);
        }
      });
    } else {
      valEl.textContent = token.value;
    }

    const dismiss = document.createElement('button');
    dismiss.className   = 'pill-dismiss';
    dismiss.textContent = '×';
    dismiss.setAttribute('aria-label', `Remove ${token.rawKey} filter`);
    dismiss.addEventListener('click', () => removeToken(token));

    pill.append(keyEl, sep, valEl, dismiss);
    pillBar.appendChild(pill);
  }
}

/** Remove a single token from the search bar and re-parse */
function removeToken(token) {
  // Re-build raw query string without this token
  const current = searchInput.value;
  // Match "rawKey:value" with possible quoting, remove it
  const escaped = token.rawKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\s)${escaped}:(?:"[^"]*"|'[^']*'|\\S+)`, 'i');
  const next = current.replace(re, ' ').replace(/\s{2,}/g, ' ').trim();
  searchInput.value = next;
  const parsed = parseQuery(next);
  applyParsedQuery(parsed);
}

// ─────────────────────────────────────────
// Autocomplete ghost
// ─────────────────────────────────────────
// Shows a ghost hint in the search bar for known keyword prefixes.
// E.g. typing "leve" shows ghost "l:" in muted text.
// Canvas used to measure text width for ghost offset
let _measureCanvas = null;
function measureTextWidth(text, font) {
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  const ctx = _measureCanvas.getContext('2d');
  ctx.font = font;
  return ctx.measureText(text).width;
}

function updateAutocompleteHint(raw) {
  const ghostEl = document.getElementById('searchGhost');
  if (!ghostEl) return;

  // Find the last "word" the user is typing (no space yet, at end of input)
  const lastWord = raw.split(/\s+/).pop();
  if (!lastWord || lastWord.includes(':')) {
    ghostEl.textContent = '';
    return;
  }

  // Suggest the first known key that starts with what they've typed
  const match = KNOWN_KEYS.find(
    (k) => k.startsWith(lastWord.toLowerCase()) && k !== lastWord.toLowerCase()
  );
  if (match) {
    // Completion suffix + ":"
    const completion = match.slice(lastWord.length) + ':';
    ghostEl.textContent = completion;

    // Offset ghost to appear right after the typed text
    // Measure the full input value width to position the ghost
    const style = window.getComputedStyle(searchInput);
    const font  = `${style.fontSize} ${style.fontFamily}`;
    const inputPadLeft = parseFloat(style.paddingLeft) || 0;
    const textWidth = measureTextWidth(raw, font);
    ghostEl.style.setProperty('--ghost-offset', `${inputPadLeft + textWidth}px`);
  } else {
    ghostEl.textContent = '';
  }
}

// Accept ghost with Tab
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    const ghostEl = document.getElementById('searchGhost');
    if (ghostEl && ghostEl.textContent) {
      e.preventDefault();
      searchInput.value = searchInput.value + ghostEl.textContent;
      ghostEl.textContent = '';
      // Don't trigger a full re-parse yet — user is still typing
    }
  }
});

// ─────────────────────────────────────────
// Search input → debounced parse + apply
// ─────────────────────────────────────────
searchInput.addEventListener('input', () => {
  updateAutocompleteHint(searchInput.value);

  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    const parsed = parseQuery(searchInput.value);
    applyParsedQuery(parsed);
  }, 220);
});

// ─────────────────────────────────────────
// Log feed — client-side message + id filter
// ─────────────────────────────────────────
function applyClientFilter(logs) {
  let out = logs;

  // Free-text message search
  const q = (activeFilters.search || '').trim().toLowerCase();
  if (q) {
    out = out.filter((l) =>
      l.message.toLowerCase().includes(q) ||
      String(l.gameId).includes(q) ||
      l.level.toLowerCase().includes(q)
    );
  }

  // Specific log ID filter (client-side only)
  if (activeFilters.logId) {
    const targetId = Number(activeFilters.logId);
    out = out.filter((l) => l.id === targetId);
  }

  return out;
}

function renderLogs(logs, total) {
  const filtered = applyClientFilter(logs ?? []);

  if (logTotalEl) {
    const shown = filtered.length;
    logTotalEl.textContent = total != null
      ? (activeFilters.search || activeFilters.logId
          ? `${shown} of ${total.toLocaleString()}`
          : `${total.toLocaleString()} total`)
      : '';
  }

  if (filtered.length === 0) {
    logFeedEl.innerHTML = '';
    emptyState.hidden = false;
    logFeedEl.appendChild(emptyState);
    knownLogIds.clear();
    return;
  }
  emptyState.hidden = true;

  const logsById  = new Map(filtered.map((l) => [l.id, l]));
  const newIds    = new Set(logsById.keys());
  const firstLoad = knownLogIds.size === 0;

  for (const [id, log] of logsById) logDataById.set(id, log);
  // Cap the cache so a long-running tab doesn't accumulate unbounded
  // entries; rows that scroll off-screen and out of the cache just fall
  // back to the by-id API fetch if a permalink targets them later.
  if (logDataById.size > 500) {
    const excess = logDataById.size - 500;
    const oldestKeys = [...logDataById.keys()].slice(0, excess);
    for (const k of oldestKeys) logDataById.delete(k);
  }

  [...logFeedEl.querySelectorAll('.log-row')].forEach((row) => {
    const id = Number(row.dataset.id);
    if (!newIds.has(id)) { row.remove(); }
    else { updateLogRow(row, logsById.get(id)); }
  });

  for (const log of [...filtered].reverse()) {
    if (!knownLogIds.has(log.id)) {
      const row = buildLogRow(log, !firstLoad);
      logFeedEl.insertBefore(row, logFeedEl.firstChild);
    }
  }

  knownLogIds = newIds;

  if (selectedLogId !== null && !newIds.has(selectedLogId)) {
    closeDrawer();
  }
}

function updateLogRow(row, log) {
  const timeEl = row.querySelector('.log-time');
  if (timeEl) timeEl.textContent = formatTime(log.timestamp);

  let countEl = row.querySelector('.log-count');
  if (log.count > 1) {
    if (!countEl) {
      countEl = document.createElement('span');
      countEl.className = 'log-count';
      row.querySelector('.log-message-wrap')?.insertBefore(countEl, row.querySelector('.log-link-btn'));
    }
    countEl.textContent = `×${log.count}`;
  } else if (countEl) { countEl.remove(); }

  row.classList.toggle('selected', log.id === selectedLogId);
  row.classList.toggle('kb-focused', log.id === kbFocusedId);
}

function buildLogRow(log, animate = false) {
  const row = document.createElement('div');
  row.className = 'log-row' + (animate ? ' new' : '') + (log.id % 2 === 0 ? ' log-row-alt' : '');
  row.dataset.id    = log.id;
  row.dataset.level = log.level;
  if (log.id === selectedLogId) row.classList.add('selected');
  if (log.id === kbFocusedId)   row.classList.add('kb-focused');

  const time = document.createElement('span');
  time.className   = 'log-time';
  time.textContent = formatTime(log.timestamp);

  const game = document.createElement('span');
  game.className   = 'log-game';
  game.textContent = String(log.gameId);

  const badge = document.createElement('span');
  badge.className   = `log-badge ${log.level}`;
  badge.textContent = log.level;

  const msgWrap = document.createElement('div');
  msgWrap.className = 'log-message-wrap';

  const msg = document.createElement('span');
  msg.className   = 'log-message';
  renderRedactedInto(msg, log.message);
  msgWrap.appendChild(msg);

  if (log.count > 1) {
    const cnt = document.createElement('span');
    cnt.className   = 'log-count';
    cnt.textContent = `×${log.count}`;
    msgWrap.appendChild(cnt);
  }

  msgWrap.appendChild(buildLinkButton(log));

  row.append(time, game, badge, msgWrap);
  row.addEventListener('click', () => openDrawer(log));
  return row;
}

/**
 * Small "copy permalink" icon button. Builds a URL encoding the current
 * filter context (gameId + time range) plus this specific log's id, so a
 * teammate opening the link lands on the same row even if it's since
 * scrolled off the default page.
 */
function buildLinkButton(log) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'log-link-btn';
  btn.title = 'Copy link to this log';
  btn.setAttribute('aria-label', 'Copy link to this log');
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also trigger the row's open-drawer click
    copyPermalink(log, btn);
  });
  return btn;
}

function copyPermalink(log, btn) {
  const url = buildPermalinkUrl(log);
  navigator.clipboard.writeText(url).then(() => {
    btn.classList.add('copied');
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
    }, 1500);
  });
}

/**
 * Builds a shareable URL for one log entry. Includes the current active
 * time-range filters (so the teammate's view is scoped similarly) plus
 * this row's gameId and id, which together are enough for resolvePermalink()
 * to find — or specifically fetch — the exact row on the other end.
 */
function buildPermalinkUrl(log) {
  const params = new URLSearchParams();
  params.set('gameId', String(log.gameId));
  params.set('logId', String(log.id));
  if (activeFilters.startTimeRelative) params.set('after', activeFilters.startTimeRelative);
  else if (activeFilters.startTime)    params.set('after', activeFilters.startTime);
  if (activeFilters.endTimeRelative)   params.set('before', activeFilters.endTimeRelative);
  else if (activeFilters.endTime)      params.set('before', activeFilters.endTime);

  const url = new URL(window.location.href);
  url.search = params.toString();
  return url.toString();
}

// ─────────────────────────────────────────
// TIMESTAMP FORMATTING
// UTC vs Local toggle — persisted in localStorage
// ─────────────────────────────────────────
const TZ_KEY = 'tracelyTzMode'; // 'local' | 'utc'
let tzMode = localStorage.getItem(TZ_KEY) || 'local';

function setTzMode(mode) {
  tzMode = mode;
  localStorage.setItem(TZ_KEY, mode);
  // Update toggle button state
  const tzBtns = document.querySelectorAll('.tz-btn');
  tzBtns.forEach((b) => b.classList.toggle('active', b.dataset.tz === mode));
  // Re-render all visible timestamps without a full refresh
  document.querySelectorAll('.log-row').forEach((row) => {
    const id  = Number(row.dataset.id);
    const log = logDataById.get(id);
    if (!log) return;
    const timeEl = row.querySelector('.log-time');
    if (timeEl) timeEl.textContent = formatTime(log.timestamp);
  });
  // Re-render drawer if open
  if (selectedLogId !== null) {
    const log = logDataById.get(selectedLogId);
    if (log) {
      const tsField = document.querySelector('.detail-field [data-field="timestamp"]');
      if (tsField) tsField.textContent = formatFullTime(log.timestamp);
      const utcField = document.querySelector('.detail-field [data-field="utc"]');
      if (utcField) utcField.textContent = formatUtcFull(log.timestamp);
    }
  }
}

/**
 * Short timestamp for the log feed column.
 * Shows time only if the log is from today (local or UTC depending on mode),
 * otherwise prepends the date so yesterday's logs aren't ambiguous.
 */
function formatTime(ts) {
  const d    = new Date(ts * 1000);
  const now  = new Date();
  const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit' };

  if (tzMode === 'utc') {
    const sameDay =
      d.getUTCFullYear() === now.getUTCFullYear() &&
      d.getUTCMonth()    === now.getUTCMonth() &&
      d.getUTCDate()     === now.getUTCDate();
    const time = d.toLocaleTimeString([], { ...opts, timeZone: 'UTC' });
    return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${time}`;
  }

  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth()    === now.getMonth() &&
    d.getDate()     === now.getDate();
  const time = d.toLocaleTimeString([], opts);
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** Full timestamp for the detail drawer — always shows both local and UTC. */
function formatFullTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatUtcFull(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'UTC', timeZoneName: 'short',
  });
}

// ─────────────────────────────────────────
// Detail drawer
// ─────────────────────────────────────────
function openDrawer(log) {
  selectedLogId = log.id;
  kbFocusedId   = log.id;

  document.querySelectorAll('.log-row').forEach((r) => {
    r.classList.toggle('selected', Number(r.dataset.id) === log.id);
    r.classList.toggle('kb-focused', Number(r.dataset.id) === log.id);
  });

  detailBody.innerHTML = '';

  const sec1 = makeDetailSection('Overview');

  const levelBadge = document.createElement('span');
  levelBadge.className = `detail-level-badge ${log.level}`;
  levelBadge.textContent = log.level;
  sec1.appendChild(levelBadge);

  const tsWrap = makeDetailField('Local time', formatFullTime(log.timestamp));
  tsWrap.querySelector('.detail-field-val').dataset.field = 'timestamp';
  sec1.appendChild(tsWrap);
  const utcWrap = makeDetailField('UTC', formatUtcFull(log.timestamp));
  utcWrap.querySelector('.detail-field-val').dataset.field = 'utc';
  sec1.appendChild(utcWrap);
  sec1.appendChild(makeDetailField('Game ID',   String(log.gameId)));
  sec1.appendChild(makeDetailField('Log ID',    String(log.id)));
  if (log.count > 1) {
    sec1.appendChild(makeDetailField('Occurrences', `×${log.count} (deduplicated)`));
  }

  // Quick-filter button inside the drawer — clicking game ID adds it to the search bar
  const gfBtn = document.createElement('button');
  gfBtn.className   = 'detail-filter-btn';
  gfBtn.textContent = `Filter by game ${log.gameId}`;
  gfBtn.addEventListener('click', () => {
    injectQueryToken(`game:${log.gameId}`);
  });
  sec1.appendChild(gfBtn);

  detailBody.appendChild(sec1);
  detailBody.appendChild(makeDivider());

  const sec2 = makeDetailSection('Message');
  const msgBlock = document.createElement('pre');
  msgBlock.className   = 'detail-message-block';
  renderRedactedInto(msgBlock, log.message);
  sec2.appendChild(msgBlock);

  const copyBtn = document.createElement('button');
  copyBtn.className   = 'detail-copy-btn';
  copyBtn.textContent = 'Copy message';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(redactText(log.message)).then(() => {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy message'; copyBtn.classList.remove('copied'); }, 1800);
    });
  });
  sec2.appendChild(copyBtn);
  detailBody.appendChild(sec2);
  detailBody.appendChild(makeDivider());

  const sec3 = makeDetailSection('Raw JSON');
  const jsonBlock = document.createElement('pre');
  jsonBlock.className   = 'detail-message-block';
  jsonBlock.textContent = JSON.stringify({
    id:        log.id,
    level:     log.level,
    message:   redactText(log.message),
    timestamp: log.timestamp,
    gameId:    log.gameId,
    count:     log.count ?? 1,
    createdAt: log.createdAt,
  }, null, 2);
  sec3.appendChild(jsonBlock);

  const copyJsonBtn = document.createElement('button');
  copyJsonBtn.className   = 'detail-copy-btn';
  copyJsonBtn.textContent = 'Copy JSON';
  copyJsonBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(jsonBlock.textContent).then(() => {
      copyJsonBtn.textContent = 'Copied!';
      copyJsonBtn.classList.add('copied');
      setTimeout(() => { copyJsonBtn.textContent = 'Copy JSON'; copyJsonBtn.classList.remove('copied'); }, 1800);
    });
  });
  sec3.appendChild(copyJsonBtn);
  detailBody.appendChild(sec3);

  detailDrawer.classList.add('open');
  detailDrawer.setAttribute('aria-hidden', 'false');
}

/**
 * Inject or update a key:value token in the search bar.
 * If that key already exists, replaces its value; otherwise appends.
 */
function injectQueryToken(tokenStr) {
  injectQueryTokens([tokenStr]);
}

/**
 * Same as injectQueryToken but applies several tokens in one pass, so
 * callers setting multiple filters at once (e.g. resolving a permalink)
 * only trigger a single refresh() instead of one per token.
 */
function injectQueryTokens(tokenStrs) {
  let current = searchInput.value;

  for (const tokenStr of tokenStrs) {
    const [k] = tokenStr.split(':');
    const canonical = TOKEN_ALIASES[k.toLowerCase()];
    if (!canonical) continue;

    for (const alias of Object.entries(TOKEN_ALIASES).filter(([, c]) => c === canonical).map(([a]) => a)) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|\\s)${escaped}:(?:"[^"]*"|'[^']*'|\\S+)`, 'gi');
      current = current.replace(re, ' ');
    }
    current = (current.trim() + ' ' + tokenStr).trim().replace(/\s{2,}/g, ' ');
  }

  searchInput.value = current;
  applyParsedQuery(parseQuery(current));
}

// ─────────────────────────────────────────
// PERMALINKS
//
// A permalink URL looks like:
//   ?gameId=123456&logId=4821&after=3h&before=...
// gameId/logId are required to identify the row; after/before are
// optional context carried over from whoever copied the link, so the
// recipient's view is scoped similarly (not strictly required to find
// the log — id: alone would do that — but it keeps the surrounding
// feed relevant rather than dumping them into an unfiltered view).
// ─────────────────────────────────────────

/** Parses location.search into a pendingPermalink object, or null if absent/invalid. */
function parsePermalinkFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const gameId = params.get('gameId');
  const logId  = params.get('logId');
  if (!gameId || !logId || !/^\d+$/.test(gameId) || !/^\d+$/.test(logId)) return null;

  return {
    gameId,
    logId,
    after:  params.get('after')  || '',
    before: params.get('before') || '',
  };
}

// Parsed once at script load — both the auto-unlock path (already has a
// session key) and the manual-login path (auth form submit) read from
// this same value, so a permalink survives the auth gate either way.
pendingUrlPermalink = parsePermalinkFromUrl();

/**
 * Applies a permalink's filters to the search bar (so the surrounding feed
 * matches what was shared) and queues the target log id to be resolved
 * once the first refresh() completes.
 */
function primePermalink(link) {
  const tokens = [`game:${link.gameId}`];
  if (link.after)  tokens.push(`after:${link.after}`);
  if (link.before) tokens.push(`before:${link.before}`);
  injectQueryTokens(tokens);
  pendingPermalink = link;
}

/**
 * Called once after the first refresh() following a permalink load.
 * If the target log is already in the rendered feed, scroll + highlight it.
 * Otherwise fall back to fetching it directly by id, since it may be
 * outside the current page/time-range window.
 */
async function resolvePermalink(link) {
  const targetId = Number(link.logId);
  const existingRow = logFeedEl.querySelector(`.log-row[data-id="${targetId}"]`);

  if (existingRow) {
    highlightPermalinkRow(existingRow, targetId);
    return;
  }

  try {
    const res = await fetch(`/api/log-by-id?id=${targetId}&workspaceId=${currentWorkspace.id}`, { credentials: 'same-origin' });
    if (!res.ok) {
      lastUpdated.textContent = res.status === 404
        ? 'linked log not found — it may have been cleared or has rolled off retention'
        : lastUpdated.textContent;
      return;
    }
    const { log } = await res.json();
    if (!log) return;

    logDataById.set(log.id, log);
    kbFocusedId = log.id;
    openDrawer(log);
    // The log lives outside the currently filtered page, so there's no
    // row to scroll to in the feed — the drawer alone carries it. A small
    // status note explains why the feed itself doesn't show a highlighted row.
    lastUpdated.textContent = `opened linked log #${log.id} (outside current filter window)`;
  } catch {
    /* leave the feed as-is; nothing to resolve */
  }
}

function highlightPermalinkRow(row, targetId) {
  row.scrollIntoView({ block: 'center' });
  row.classList.add('permalink-highlight');
  setTimeout(() => row.classList.remove('permalink-highlight'), 1900);

  kbFocusedId = targetId;
  syncKbFocusClass();

  const log = logDataById.get(targetId);
  if (log) openDrawer(log);
}

function closeDrawer() {
  selectedLogId = null;
  detailDrawer.classList.remove('open');
  detailDrawer.setAttribute('aria-hidden', 'true');
  document.querySelectorAll('.log-row.selected').forEach((r) => r.classList.remove('selected'));
}

function makeDetailSection(title) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-section';
  const h = document.createElement('p');
  h.className   = 'detail-section-title';
  h.textContent = title;
  wrap.appendChild(h);
  return wrap;
}

function makeDetailField(key, val) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-field';
  const k = document.createElement('span');
  k.className   = 'detail-field-key';
  k.textContent = key;
  const v = document.createElement('span');
  v.className   = 'detail-field-val';
  v.textContent = val;
  wrap.append(k, v);
  return wrap;
}

function makeDivider() {
  const d = document.createElement('div');
  d.className = 'detail-divider';
  return d;
}

detailClose.addEventListener('click', closeDrawer);

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && detailDrawer.classList.contains('open')) {
    closeDrawer();
  }
  if (e.key === '/' && !isTypingTarget(document.activeElement)) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }

  if (isTypingTarget(document.activeElement)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault();
    moveKbFocus(e.key === 'j' ? 1 : -1);
  } else if (e.key === 'Enter' && kbFocusedId !== null) {
    e.preventDefault();
    const log = logDataById.get(kbFocusedId);
    if (log) openDrawer(log);
  } else if (e.key === '?') {
    e.preventDefault();
    openShortcutsModal();
  } else if (e.key === ' ') {
    e.preventDefault();
    setPaused(!isPaused);
  }
});

/** Visible rows top-to-bottom, newest first — matches what the user sees. */
function getVisibleRows() {
  return [...logFeedEl.querySelectorAll('.log-row')];
}

function syncKbFocusClass() {
  getVisibleRows().forEach((row) => {
    row.classList.toggle('kb-focused', Number(row.dataset.id) === kbFocusedId);
  });
}

/**
 * Moves keyboard focus by `dir` (+1 = j/down, -1 = k/up) through the
 * currently rendered rows. If nothing is focused yet, starts at the top.
 * If the detail drawer is already open, the newly focused log is opened
 * live so the drawer tracks navigation instead of needing a separate
 * Enter press each time.
 */
function moveKbFocus(dir) {
  const rows = getVisibleRows();
  if (!rows.length) return;

  let idx = rows.findIndex((r) => Number(r.dataset.id) === kbFocusedId);
  if (idx === -1) {
    idx = dir > 0 ? 0 : rows.length - 1;
  } else {
    idx = Math.min(Math.max(idx + dir, 0), rows.length - 1);
  }

  const row = rows[idx];
  kbFocusedId = Number(row.dataset.id);
  syncKbFocusClass();
  row.scrollIntoView({ block: 'nearest' });

  if (detailDrawer.classList.contains('open')) {
    const log = logDataById.get(kbFocusedId);
    if (log) openDrawer(log);
  }
}

// ─────────────────────────────────────────
// Legacy checkbox / extras UI (still works,
// writes back to search bar in query syntax)
// ─────────────────────────────────────────
function toUnixSeconds(v) {
  if (!v) return '';
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : '';
}

function syncLegacyToSearchBar() {
  const checkedLevels = [...levelCheckboxes].filter((cb) => cb.checked).map((cb) => cb.value);
  const gameId        = gameIdFilterEl ? gameIdFilterEl.value.trim() : '';
  const startTs       = toUnixSeconds(startTimeFilterEl ? startTimeFilterEl.value : '');
  const endTs         = toUnixSeconds(endTimeFilterEl   ? endTimeFilterEl.value   : '');

  const parts = [];
  if (checkedLevels.length) parts.push(`level:${checkedLevels.join(',').toLowerCase()}`);
  if (gameId)  parts.push(`game:${gameId}`);
  if (startTs) parts.push(`after:${startTs}`);
  if (endTs)   parts.push(`before:${endTs}`);

  // Preserve any existing free text from the search bar
  const currentParsed = parseQuery(searchInput.value);
  if (currentParsed.search) parts.push(currentParsed.search);

  const next = parts.join(' ');
  searchInput.value = next;
  const parsed = parseQuery(next);
  applyParsedQuery(parsed);
}

if (applyFiltersBtn) {
  applyFiltersBtn.addEventListener('click', syncLegacyToSearchBar);
}

if (clearFiltersBtn) {
  clearFiltersBtn.addEventListener('click', () => {
    levelCheckboxes.forEach((cb) => (cb.checked = false));
    if (gameIdFilterEl)    gameIdFilterEl.value    = '';
    if (startTimeFilterEl) startTimeFilterEl.value = '';
    if (endTimeFilterEl)   endTimeFilterEl.value   = '';
    searchInput.value = '';
    const parsed = parseQuery('');
    applyParsedQuery(parsed);
  });
}

if (toggleFiltersBtn) {
  toggleFiltersBtn.addEventListener('click', () => {
    filterExtrasEl.classList.toggle('open');
    toggleFiltersBtn.classList.toggle('active');
  });
}

// ─────────────────────────────────────────
// THEME
// ─────────────────────────────────────────
const THEME_KEY = 'tracelyTheme';
const themeSegmented = document.getElementById('themeSegmented');
const lightMediaQuery = window.matchMedia('(prefers-color-scheme: light)');

function resolveTheme(pref) {
  return pref === 'system' ? (lightMediaQuery.matches ? 'light' : 'dark') : pref;
}

function applyTheme(pref) {
  document.documentElement.classList.toggle('theme-light', resolveTheme(pref) === 'light');
  if (themeSegmented) {
    themeSegmented.querySelectorAll('.segmented-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === pref);
    });
  }
}

function getThemePref() {
  return localStorage.getItem(THEME_KEY) || 'system';
}

function setThemePref(pref) {
  localStorage.setItem(THEME_KEY, pref);
  applyTheme(pref);
}

if (themeSegmented) {
  themeSegmented.addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented-btn');
    if (btn) setThemePref(btn.dataset.value);
  });
}

// Keep in sync if the OS theme changes while "System" is selected
lightMediaQuery.addEventListener('change', () => {
  if (getThemePref() === 'system') applyTheme('system');
});

// ─────────────────────────────────────────
// DENSITY
// ─────────────────────────────────────────
const DENSITY_KEY = 'tracelyDensity';
const densitySegmented = document.getElementById('densitySegmented');

function applyDensity(pref) {
  document.documentElement.classList.toggle('density-compact', pref === 'compact');
  if (densitySegmented) {
    densitySegmented.querySelectorAll('.segmented-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === pref);
    });
  }
}

function getDensityPref() {
  return localStorage.getItem(DENSITY_KEY) || 'cozy';
}

function setDensityPref(pref) {
  localStorage.setItem(DENSITY_KEY, pref);
  applyDensity(pref);
}

if (densitySegmented) {
  densitySegmented.addEventListener('click', (e) => {
    const btn = e.target.closest('.segmented-btn');
    if (btn) setDensityPref(btn.dataset.value);
  });
}

// ─────────────────────────────────────────
// REDACTION RULES
// Stored per-browser in localStorage. Applied at display time only —
// the underlying log data (search, raw JSON copy target) is untouched,
// so adding a rule retroactively masks old logs too without needing a
// server round trip.
// ─────────────────────────────────────────
const REDACTION_KEY = 'tracelyRedactionTerms';
const redactionInput = document.getElementById('redactionInput');
const redactionAddBtn = document.getElementById('redactionAddBtn');
const redactionTagsEl = document.getElementById('redactionTags');

function getRedactionTerms() {
  try {
    const raw = localStorage.getItem(REDACTION_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function setRedactionTerms(terms) {
  localStorage.setItem(REDACTION_KEY, JSON.stringify(terms));
  renderRedactionTags();
  // updateLogRow() (used by the normal poll diff) never touches
  // .log-message, so a plain refresh() wouldn't re-mask rows already on
  // screen. Clear the known-IDs cache first to force renderLogs() to treat
  // every visible row as new and rebuild it with the updated rules.
  knownLogIds.clear();
  logFeedEl.innerHTML = '';
  refresh();
  if (selectedLogId !== null) {
    // Drawer holds its own log reference; close it so stale unredacted
    // text doesn't linger until the next click re-applies redaction.
    closeDrawer();
  }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the message with every redaction term replaced by bullet
 * characters of the same length (so leak-by-length-guessing is at least
 * a little harder than a fixed-width mask, and copy-paste output doesn't
 * literally contain the word "REDACTED" next to a key value).
 */
function redactText(message) {
  const terms = getRedactionTerms().filter(Boolean);
  if (!terms.length || typeof message !== 'string') return message;
  let out = message;
  for (const term of terms) {
    const re = new RegExp(escapeRegExp(term), 'gi');
    out = out.replace(re, (match) => '•'.repeat(match.length));
  }
  return out;
}

/**
 * Renders `message` into `el` with matched redaction terms wrapped in a
 * highlighted span, so it's visually obvious something was hidden (vs.
 * silently rewriting text in a way that looks like normal content).
 */
function renderRedactedInto(el, message) {
  el.innerHTML = '';
  const terms = getRedactionTerms().filter(Boolean);
  if (!terms.length || typeof message !== 'string') {
    el.textContent = message;
    return;
  }
  const re = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const parts = message.split(re);
  for (const part of parts) {
    if (terms.some((t) => t.toLowerCase() === part.toLowerCase())) {
      const mark = document.createElement('span');
      mark.className = 'redacted-mask';
      mark.textContent = '•'.repeat(part.length);
      mark.title = 'Redacted by your local rules';
      el.appendChild(mark);
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  }
}

function renderRedactionTags() {
  if (!redactionTagsEl) return;
  const terms = getRedactionTerms();
  redactionTagsEl.innerHTML = '';

  if (!terms.length) {
    const hint = document.createElement('span');
    hint.className = 'redaction-empty-hint';
    hint.textContent = 'No redaction rules yet.';
    redactionTagsEl.appendChild(hint);
    return;
  }

  terms.forEach((term, i) => {
    const tag = document.createElement('span');
    tag.className = 'redaction-tag';
    const label = document.createElement('span');
    label.textContent = term;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'redaction-tag-remove';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', `Remove redaction rule "${term}"`);
    removeBtn.addEventListener('click', () => {
      const next = getRedactionTerms();
      next.splice(i, 1);
      setRedactionTerms(next);
    });
    tag.append(label, removeBtn);
    redactionTagsEl.appendChild(tag);
  });
}

function addRedactionTerm() {
  if (!redactionInput) return;
  const val = redactionInput.value.trim();
  if (!val) return;
  const terms = getRedactionTerms();
  if (!terms.some((t) => t.toLowerCase() === val.toLowerCase())) {
    terms.push(val);
    setRedactionTerms(terms);
  }
  redactionInput.value = '';
  redactionInput.focus();
}

if (redactionAddBtn) redactionAddBtn.addEventListener('click', addRedactionTerm);
if (redactionInput) {
  redactionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addRedactionTerm(); }
  });
}

// ─────────────────────────────────────────
// DATA RETENTION
// ─────────────────────────────────────────
const retentionSelect = document.getElementById('retentionSelect');
const retentionStatus = document.getElementById('retentionStatus');

async function loadRetentionSetting() {
  if (!retentionSelect || !currentWorkspace) return;
  try {
    const res = await fetch(`/api/settings?workspaceId=${currentWorkspace.id}`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.logRetentionDays) retentionSelect.value = String(data.logRetentionDays);
  } catch { /* leave default selected */ }
}

if (retentionSelect) {
  retentionSelect.addEventListener('change', async () => {
    if (retentionStatus) retentionStatus.hidden = true;
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: currentWorkspace.id, logRetentionDays: Number(retentionSelect.value) }),
      });
      if (!res.ok) throw new Error('save failed');
      if (retentionStatus) {
        retentionStatus.textContent = 'Saved.';
        retentionStatus.hidden = false;
        setTimeout(() => { retentionStatus.hidden = true; }, 2200);
      }
    } catch {
      if (retentionStatus) {
        retentionStatus.textContent = 'Could not save — try again.';
        retentionStatus.style.color = 'var(--error)';
        retentionStatus.hidden = false;
      }
    }
  });
}

// ─────────────────────────────────────────
// NUKE (clear logs)
// ─────────────────────────────────────────
const nukeBtn = document.getElementById('nukeBtn');
const nukeModalOverlay = document.getElementById('nukeModalOverlay');
const nukeCancelBtn = document.getElementById('nukeCancelBtn');
const nukeConfirmBtn = document.getElementById('nukeConfirmBtn');
const nukeConfirmCheckbox = document.getElementById('nukeConfirmCheckbox');
const nukeGameIdInput = document.getElementById('nukeGameIdInput');
const nukeModalError = document.getElementById('nukeModalError');
const nukeScopeRadios = document.querySelectorAll('input[name="nukeScope"]');

function openNukeModal() {
  if (!nukeModalOverlay) return;
  nukeConfirmCheckbox.checked = false;
  nukeConfirmBtn.disabled = true;
  nukeGameIdInput.value = '';
  nukeGameIdInput.disabled = true;
  nukeModalError.hidden = true;
  document.querySelector('input[name="nukeScope"][value="all"]').checked = true;
  nukeModalOverlay.hidden = false;
}

function closeNukeModal() {
  if (nukeModalOverlay) nukeModalOverlay.hidden = true;
}

if (nukeBtn) nukeBtn.addEventListener('click', openNukeModal);
if (nukeCancelBtn) nukeCancelBtn.addEventListener('click', closeNukeModal);
if (nukeModalOverlay) {
  nukeModalOverlay.addEventListener('click', (e) => {
    if (e.target === nukeModalOverlay) closeNukeModal();
  });
}

nukeScopeRadios.forEach((r) => {
  r.addEventListener('change', () => {
    const isGame = document.querySelector('input[name="nukeScope"]:checked')?.value === 'game';
    nukeGameIdInput.disabled = !isGame;
    if (isGame) nukeGameIdInput.focus();
  });
});

if (nukeConfirmCheckbox) {
  nukeConfirmCheckbox.addEventListener('change', () => {
    nukeConfirmBtn.disabled = !nukeConfirmCheckbox.checked;
  });
}

if (nukeConfirmBtn) {
  nukeConfirmBtn.addEventListener('click', async () => {
    const scope = document.querySelector('input[name="nukeScope"]:checked')?.value;
    const gameId = scope === 'game' ? nukeGameIdInput.value.trim() : '';

    if (scope === 'game' && (!gameId || !/^\d+$/.test(gameId))) {
      nukeModalError.textContent = 'Enter a valid numeric game ID.';
      nukeModalError.hidden = false;
      return;
    }

    nukeConfirmBtn.disabled = true;
    nukeConfirmBtn.textContent = 'Clearing…';

    try {
      const res = await fetch('/api/clear-logs', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: currentWorkspace.id, gameId: gameId || undefined }),
      });
      if (!res.ok) throw new Error('clear failed');
      closeNukeModal();
      knownLogIds.clear();
      closeDrawer();
      refresh();
    } catch {
      nukeModalError.textContent = 'Something went wrong — try again.';
      nukeModalError.hidden = false;
    } finally {
      nukeConfirmBtn.disabled = !nukeConfirmCheckbox.checked;
      nukeConfirmBtn.textContent = 'Clear logs';
    }
  });
}

// ─────────────────────────────────────────
// DELETE WORKSPACE
// ─────────────────────────────────────────
const deleteWsModalOverlay    = document.getElementById('deleteWsModalOverlay');
const deleteWsModalName       = document.getElementById('deleteWsModalName');
const deleteWsCancelBtn       = document.getElementById('deleteWsCancelBtn');
const deleteWsConfirmBtn      = document.getElementById('deleteWsConfirmBtn');
const deleteWsConfirmCheckbox = document.getElementById('deleteWsConfirmCheckbox');
const deleteWsModalError      = document.getElementById('deleteWsModalError');

let workspacePendingDelete = null; // { id, name } passed in from the row's trash button

function openDeleteWsModal(ws) {
  if (!deleteWsModalOverlay) return;
  workspacePendingDelete = ws;
  if (deleteWsModalName) deleteWsModalName.textContent = ws.name;
  deleteWsConfirmCheckbox.checked = false;
  deleteWsConfirmBtn.disabled = true;
  deleteWsModalError.hidden = true;
  deleteWsModalOverlay.hidden = false;
}

function closeDeleteWsModal() {
  if (deleteWsModalOverlay) deleteWsModalOverlay.hidden = true;
  workspacePendingDelete = null;
}

if (deleteWsCancelBtn) deleteWsCancelBtn.addEventListener('click', closeDeleteWsModal);
if (deleteWsModalOverlay) {
  deleteWsModalOverlay.addEventListener('click', (e) => {
    if (e.target === deleteWsModalOverlay) closeDeleteWsModal();
  });
}
if (deleteWsConfirmCheckbox) {
  deleteWsConfirmCheckbox.addEventListener('change', () => {
    deleteWsConfirmBtn.disabled = !deleteWsConfirmCheckbox.checked;
  });
}

if (deleteWsConfirmBtn) {
  deleteWsConfirmBtn.addEventListener('click', async () => {
    if (!workspacePendingDelete) return;
    const ws = workspacePendingDelete;

    deleteWsConfirmBtn.disabled = true;
    deleteWsConfirmBtn.textContent = 'Deleting…';
    deleteWsModalError.hidden = true;

    try {
      const res = await fetch('/api/workspaces', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: ws.id }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        deleteWsModalError.textContent = data.error || 'Could not delete workspace.';
        deleteWsModalError.hidden = false;
        return;
      }

      allWorkspaces = allWorkspaces.filter((w) => Number(w.id) !== Number(ws.id));
      closeDeleteWsModal();
      renderWorkspaceSwitcher();
      renderWorkspacesSettingsList();
    } catch {
      deleteWsModalError.textContent = "Couldn't reach the server — try again.";
      deleteWsModalError.hidden = false;
    } finally {
      deleteWsConfirmBtn.disabled = !deleteWsConfirmCheckbox.checked;
      deleteWsConfirmBtn.textContent = 'Delete workspace';
    }
  });
}

// ─────────────────────────────────────────
// KEYBOARD SHORTCUTS MODAL
// ─────────────────────────────────────────
const shortcutsModal = document.getElementById('shortcutsModal');
const shortcutsBtn   = document.getElementById('shortcutsBtn');
const shortcutsClose = document.getElementById('shortcutsClose');

function openShortcutsModal() {
  if (shortcutsModal) shortcutsModal.hidden = false;
}

function closeShortcutsModal() {
  if (shortcutsModal) shortcutsModal.hidden = true;
}

if (shortcutsBtn)   shortcutsBtn.addEventListener('click', openShortcutsModal);
if (shortcutsClose) shortcutsClose.addEventListener('click', closeShortcutsModal);
if (shortcutsModal) {
  shortcutsModal.addEventListener('click', (e) => {
    if (e.target === shortcutsModal) closeShortcutsModal();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && shortcutsModal && !shortcutsModal.hidden) {
    closeShortcutsModal();
    return;
  }
  if (e.key === 'Escape' && nukeModalOverlay && !nukeModalOverlay.hidden) closeNukeModal();
  if (e.key === 'Escape' && deleteWsModalOverlay && !deleteWsModalOverlay.hidden) closeDeleteWsModal();
  if (e.key === 'Escape' && navWsPanel && !navWsPanel.hidden) closeWsSwitcherPanel();
});

// ─────────────────────────────────────────
// Init
// ─────────────────────────────────────────
(async function init() {
  applyTheme(getThemePref());
  applyDensity(getDensityPref());
  renderRedactionTags();
  applyStreamUI();
  setAuthMode('login');

  // Wire UTC/Local toggle buttons (rendered in the topbar by index.html)
  document.querySelectorAll('.tz-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tz === tzMode);
    btn.addEventListener('click', () => setTzMode(btn.dataset.tz));
  });

  const workspaces = await checkExistingSession();
  if (workspaces.length) {
    // No user object comes back from /api/workspaces (it's workspace-only),
    // so the email shown in Settings just won't populate until the next
    // login — the session itself is still perfectly valid.
    allWorkspaces = workspaces;
    enterDashboard(pickInitialWorkspace(workspaces));
    loadRetentionSetting();
  }
})();