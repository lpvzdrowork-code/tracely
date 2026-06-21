/* ─────────────────────────────────────────
   Tracely — app.js
   Three-pane workspace logic
───────────────────────────────────────── */

const STORAGE_KEY  = 'tracelyKey';
const REFRESH_MS   = 5000;
const LEVEL_COLORS = { INFO: '#3b82f6', WARN: '#f59e0b', ERROR: '#ef4444' };

// ── Auth elements ──
const authOverlay = document.getElementById('authOverlay');
const authForm    = document.getElementById('authForm');
const authInput   = document.getElementById('authInput');
const authError   = document.getElementById('authError');

// ── App shell ──
const appEl       = document.getElementById('app');
const lastUpdated = document.getElementById('lastUpdated');

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

// ── Detail drawer ──
const detailDrawer = document.getElementById('detailDrawer');
const detailBody   = document.getElementById('detailBody');
const detailClose  = document.getElementById('detailClose');

// ── Nav ──
const navItems = document.querySelectorAll('.nav-item');

// ── Settings ──
const lockBtn = document.getElementById('lockBtn');

// ─────────────────────────────────────────
// State
// ─────────────────────────────────────────
let chart          = null;
let refreshTimer   = null;
let knownLogIds    = new Set();
let selectedLogId  = null;
let searchDebounce = null;

let activeFilters = {
  search: '',
  levels: [],
  gameId: '',
  startTime: '',
  endTime: '',
};

// ─────────────────────────────────────────
// Auth
// ─────────────────────────────────────────
function authHeaders() {
  const key = sessionStorage.getItem(STORAGE_KEY);
  return key ? { 'x-tracely-key': key } : {};
}

async function tryUnlock(key) {
  try {
    const res = await fetch('/api/stats', { headers: { 'x-tracely-key': key } });
    return res.ok;
  } catch { return false; }
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = authInput.value.trim();
  if (!key) return;
  authError.hidden = true;
  const ok = await tryUnlock(key);
  if (!ok) { authError.hidden = false; return; }
  sessionStorage.setItem(STORAGE_KEY, key);
  unlockApp();
});

function unlockApp() {
  authOverlay.hidden = true;
  appEl.hidden = false;
  startPolling();
}

function lockApp(message) {
  sessionStorage.removeItem(STORAGE_KEY);
  stopPolling();
  appEl.hidden = true;
  authOverlay.hidden = false;
  authInput.value = '';
  if (message) { authError.textContent = message; authError.hidden = false; }
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

    // Re-render chart when switching to metrics (canvas needs visible parent)
    if (view === 'metrics' && chart) chart.update();
  });
});

// ─────────────────────────────────────────
// Polling
// ─────────────────────────────────────────
function startPolling() {
  refresh();
  stopPolling();
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

function stopPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

async function refresh() {
  try {
    const [statsRes, logsRes] = await Promise.all([
      fetch('/api/stats',     { headers: authHeaders() }),
      fetch(buildLogsUrl(),   { headers: authHeaders() }),
    ]);

    if (statsRes.status === 401 || logsRes.status === 401) {
      lockApp('Session expired. Enter your key again.');
      return;
    }

    const stats    = await statsRes.json();
    const logsData = await logsRes.json();

    renderStats(stats);
    renderChart(stats.hourly ?? []);
    renderLogs(logsData.logs, logsData.total);

    lastUpdated.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch {
    lastUpdated.textContent = 'connection lost — retrying…';
  }
}

// ─────────────────────────────────────────
// URL builder (includes client-side search)
// ─────────────────────────────────────────
function buildLogsUrl() {
  const params = new URLSearchParams();
  if (activeFilters.levels.length) params.set('level', activeFilters.levels.join(','));
  if (activeFilters.gameId)        params.set('gameId',     activeFilters.gameId);
  if (activeFilters.startTime)     params.set('startTime',  activeFilters.startTime);
  if (activeFilters.endTime)       params.set('endTime',    activeFilters.endTime);
  // Fetch more rows when searching so we can filter client-side for instant feel
  params.set('limit', activeFilters.search ? '200' : '100');
  return `/api/logs?${params.toString()}`;
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
  const now             = Math.floor(Date.now() / 1000);
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
// Log feed
// ─────────────────────────────────────────
function applySearchFilter(logs) {
  const q = activeFilters.search.trim().toLowerCase();
  if (!q) return logs;
  return logs.filter((l) =>
    l.message.toLowerCase().includes(q) ||
    String(l.gameId).includes(q) ||
    l.level.toLowerCase().includes(q)
  );
}

function renderLogs(logs, total) {
  const filtered = applySearchFilter(logs ?? []);

  if (logTotalEl) {
    const shown = filtered.length;
    logTotalEl.textContent = total != null
      ? (activeFilters.search ? `${shown} of ${total.toLocaleString()}` : `${total.toLocaleString()} total`)
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

  // Remove rows no longer in the result
  [...logFeedEl.querySelectorAll('.log-row')].forEach((row) => {
    const id = Number(row.dataset.id);
    if (!newIds.has(id)) { row.remove(); }
    else { updateLogRow(row, logsById.get(id)); }
  });

  // Prepend new rows
  for (const log of [...filtered].reverse()) {
    if (!knownLogIds.has(log.id)) {
      const row = buildLogRow(log, !firstLoad);
      logFeedEl.insertBefore(row, logFeedEl.firstChild);
    }
  }

  knownLogIds = newIds;

  // If the selected log is no longer visible, close drawer
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
      row.querySelector('.log-message-wrap')?.appendChild(countEl);
    }
    countEl.textContent = `×${log.count}`;
  } else if (countEl) { countEl.remove(); }

  // Keep selected highlight in sync
  row.classList.toggle('selected', log.id === selectedLogId);
}

function buildLogRow(log, animate = false) {
  const row = document.createElement('div');
  row.className = 'log-row' + (animate ? ' new' : '') + (log.id % 2 === 0 ? ' log-row-alt' : '');
  row.dataset.id    = log.id;
  row.dataset.level = log.level;
  if (log.id === selectedLogId) row.classList.add('selected');

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
  msg.textContent = log.message;
  msgWrap.appendChild(msg);

  if (log.count > 1) {
    const cnt = document.createElement('span');
    cnt.className   = 'log-count';
    cnt.textContent = `×${log.count}`;
    msgWrap.appendChild(cnt);
  }

  row.append(time, game, badge, msgWrap);

  row.addEventListener('click', () => openDrawer(log));

  return row;
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString();
}

// ─────────────────────────────────────────
// Detail drawer
// ─────────────────────────────────────────
function openDrawer(log) {
  selectedLogId = log.id;

  // Update row highlight
  document.querySelectorAll('.log-row').forEach((r) => {
    r.classList.toggle('selected', Number(r.dataset.id) === log.id);
  });

  detailBody.innerHTML = '';

  // ── Level + timestamp ──
  const sec1 = makeDetailSection('Overview');

  const levelBadge = document.createElement('span');
  levelBadge.className = `detail-level-badge ${log.level}`;
  levelBadge.textContent = log.level;
  sec1.appendChild(levelBadge);

  sec1.appendChild(makeDetailField('Timestamp', new Date(log.timestamp * 1000).toLocaleString()));
  sec1.appendChild(makeDetailField('Game ID',   String(log.gameId)));
  sec1.appendChild(makeDetailField('Log ID',    String(log.id)));
  if (log.count > 1) {
    sec1.appendChild(makeDetailField('Occurrences', `×${log.count} (deduplicated)`));
  }
  detailBody.appendChild(sec1);

  detailBody.appendChild(makeDivider());

  // ── Message ──
  const sec2 = makeDetailSection('Message');
  const msgBlock = document.createElement('pre');
  msgBlock.className   = 'detail-message-block';
  msgBlock.textContent = log.message;
  sec2.appendChild(msgBlock);

  const copyBtn = document.createElement('button');
  copyBtn.className   = 'detail-copy-btn';
  copyBtn.textContent = 'Copy message';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(log.message).then(() => {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => { copyBtn.textContent = 'Copy message'; copyBtn.classList.remove('copied'); }, 1800);
    });
  });
  sec2.appendChild(copyBtn);
  detailBody.appendChild(sec2);

  detailBody.appendChild(makeDivider());

  // ── Raw JSON ──
  const sec3 = makeDetailSection('Raw JSON');
  const jsonBlock = document.createElement('pre');
  jsonBlock.className   = 'detail-message-block';
  jsonBlock.textContent = JSON.stringify({
    id:        log.id,
    level:     log.level,
    message:   log.message,
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

// Escape key closes drawer
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && detailDrawer.classList.contains('open')) {
    closeDrawer();
  }
  // '/' focuses search (unless already in an input)
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// ─────────────────────────────────────────
// Search
// ─────────────────────────────────────────
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    activeFilters.search = searchInput.value;
    // Re-filter the last fetched data instantly (no extra network call)
    refresh();
  }, 180);
});

// ─────────────────────────────────────────
// Filter extras toggle
// ─────────────────────────────────────────
toggleFiltersBtn.addEventListener('click', () => {
  filterExtrasEl.classList.toggle('open');
  toggleFiltersBtn.classList.toggle('active');
});

// ─────────────────────────────────────────
// Filter apply / clear
// ─────────────────────────────────────────
function toUnixSeconds(v) {
  if (!v) return '';
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : '';
}

applyFiltersBtn.addEventListener('click', () => {
  const checkedLevels = [...levelCheckboxes].filter((cb) => cb.checked).map((cb) => cb.value);
  activeFilters = {
    ...activeFilters,
    levels:    checkedLevels,
    gameId:    gameIdFilterEl.value.trim(),
    startTime: toUnixSeconds(startTimeFilterEl.value),
    endTime:   toUnixSeconds(endTimeFilterEl.value),
  };
  knownLogIds.clear();
  refresh();
});

clearFiltersBtn.addEventListener('click', () => {
  levelCheckboxes.forEach((cb) => (cb.checked = false));
  gameIdFilterEl.value    = '';
  startTimeFilterEl.value = '';
  endTimeFilterEl.value   = '';
  searchInput.value       = '';
  activeFilters = { search: '', levels: [], gameId: '', startTime: '', endTime: '' };
  knownLogIds.clear();
  refresh();
});

// ─────────────────────────────────────────
// Init
// ─────────────────────────────────────────
(async function init() {
  const key = sessionStorage.getItem(STORAGE_KEY);
  if (!key) return;
  const ok = await tryUnlock(key);
  if (ok) { unlockApp(); }
  else    { sessionStorage.removeItem(STORAGE_KEY); }
})();