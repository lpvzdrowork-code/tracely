const STORAGE_KEY = 'tracelyKey';
const REFRESH_MS = 5000;
const LEVEL_COLORS = {
  INFO: '#3b82f6',
  WARN: '#f59e0b',
  ERROR: '#ef4444',
};

const authOverlay = document.getElementById('authOverlay');
const authForm = document.getElementById('authForm');
const authInput = document.getElementById('authInput');
const authError = document.getElementById('authError');

const appEl = document.getElementById('app');
const lastUpdatedEl = document.getElementById('lastUpdated');
const logFeedEl = document.getElementById('logFeed');
const emptyStateEl = document.getElementById('emptyState');
const logTotalEl = document.getElementById('logTotal');

const statInfoEl = document.getElementById('statInfo');
const statWarnEl = document.getElementById('statWarn');
const statErrorEl = document.getElementById('statError');

const levelCheckboxes = document.querySelectorAll('.level-checkbox');
const gameIdFilterEl = document.getElementById('gameIdFilter');
const startTimeFilterEl = document.getElementById('startTimeFilter');
const endTimeFilterEl = document.getElementById('endTimeFilter');
const applyFiltersBtn = document.getElementById('applyFilters');
const clearFiltersBtn = document.getElementById('clearFilters');

let chart = null;
let refreshTimer = null;
let activeFilters = { levels: [], gameId: '', startTime: '', endTime: '' };

function authHeaders() {
  const key = sessionStorage.getItem(STORAGE_KEY);
  return key ? { 'x-tracely-key': key } : {};
}

async function tryUnlock(key) {
  const res = await fetch('/api/stats', { headers: { 'x-tracely-key': key } });
  return res.ok;
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = authInput.value.trim();
  if (!key) return;

  authError.hidden = true;
  const ok = await tryUnlock(key);

  if (!ok) {
    authError.hidden = false;
    return;
  }

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
  if (message) {
    authError.textContent = message;
    authError.hidden = false;
  }
}

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
      fetch('/api/stats', { headers: authHeaders() }),
      fetch(buildLogsUrl(), { headers: authHeaders() }),
    ]);

    if (statsRes.status === 401 || logsRes.status === 401) {
      lockApp('Session expired. Enter your key again.');
      return;
    }

    const stats = await statsRes.json();
    const logsData = await logsRes.json();

    renderStats(stats);
    renderChart(stats.hourly ?? []);
    renderLogs(logsData.logs, logsData.total);

    lastUpdatedEl.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    lastUpdatedEl.textContent = 'connection lost — retrying…';
  }
}

function buildLogsUrl() {
  const params = new URLSearchParams();
  if (activeFilters.levels.length) params.set('level', activeFilters.levels.join(','));
  if (activeFilters.gameId) params.set('gameId', activeFilters.gameId);
  if (activeFilters.startTime) params.set('startTime', activeFilters.startTime);
  if (activeFilters.endTime) params.set('endTime', activeFilters.endTime);
  params.set('limit', '100');
  return `/api/logs?${params.toString()}`;
}

function renderStats(stats) {
  const counts = stats.counts ?? stats;
  statInfoEl.textContent = (counts.INFO ?? 0).toLocaleString();
  statWarnEl.textContent = (counts.WARN ?? 0).toLocaleString();
  statErrorEl.textContent = (counts.ERROR ?? 0).toLocaleString();
}

function renderChart(hourly) {
  const buckets = buildHourBuckets();
  const dataByLevel = { INFO: [], WARN: [], ERROR: [] };

  for (const bucketStart of buckets) {
    const matches = hourly.filter((row) => row.bucket === bucketStart);
    for (const level of ['INFO', 'WARN', 'ERROR']) {
      const found = matches.find((row) => row.level === level);
      dataByLevel[level].push(found ? found.count : 0);
    }
  }

  const labels = buckets.map((ts) =>
    new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );

  const datasets = ['INFO', 'WARN', 'ERROR'].map((level) => ({
    label: level,
    data: dataByLevel[level],
    backgroundColor: LEVEL_COLORS[level],
    stack: 'logs',
  }));

  if (!chart) {
    const ctx = document.getElementById('activityChart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: {
              color: '#888888',
              usePointStyle: true,
              pointStyle: 'circle',
              boxWidth: 7,
              boxHeight: 7,
              padding: 16,
              font: { family: 'Inter', size: 12 },
            },
          },
          tooltip: {
            backgroundColor: '#1f1f1f',
            borderColor: '#2a2a2a',
            borderWidth: 1,
            titleColor: '#ffffff',
            bodyColor: '#888888',
            padding: 10,
            cornerRadius: 8,
            titleFont: { family: 'Inter', size: 12, weight: '600' },
            bodyFont: { family: 'JetBrains Mono', size: 12 },
            boxPadding: 4,
          },
        },
        scales: {
          x: {
            stacked: true,
            ticks: { color: '#888888', font: { family: 'Inter', size: 11 } },
            grid: { display: false },
            border: { color: '#2a2a2a' },
          },
          y: {
            stacked: true,
            ticks: { color: '#888888', font: { family: 'Inter', size: 11 }, precision: 0 },
            grid: { color: '#202020' },
            border: { display: false },
          },
        },
      },
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets = datasets;
    chart.update();
  }
}

function buildHourBuckets() {
  const now = Math.floor(Date.now() / 1000);
  const currentHourStart = Math.floor(now / 3600) * 3600;
  const buckets = [];
  for (let i = 23; i >= 0; i--) {
    buckets.push(currentHourStart - i * 3600);
  }
  return buckets;
}

let knownLogIds = new Set();

function renderLogs(logs, total) {
  if (logTotalEl) {
    logTotalEl.textContent = total != null ? `${total.toLocaleString()} total` : '';
  }

  if (!logs || logs.length === 0) {
    logFeedEl.innerHTML = '';
    emptyStateEl.hidden = false;
    logFeedEl.appendChild(emptyStateEl);
    knownLogIds.clear();
    return;
  }
  emptyStateEl.hidden = true;

  const logsById = new Map(logs.map((l) => [l.id, l]));
  const newIds = new Set(logsById.keys());
  const isFirstLoad = knownLogIds.size === 0;

  const existingRows = [...logFeedEl.querySelectorAll('.log-row')];
  existingRows.forEach(row => {
    const id = Number(row.dataset.id);
    if (!newIds.has(id)) {
      row.remove();
    } else {
      updateLogRow(row, logsById.get(id));
    }
  });

  for (const log of [...logs].reverse()) {
    if (!knownLogIds.has(log.id)) {
      const row = buildLogRow(log, !isFirstLoad);
      logFeedEl.insertBefore(row, logFeedEl.firstChild);
    }
  }

  knownLogIds = newIds;
}

function updateLogRow(row, log) {
  const time = row.querySelector('.log-time');
  if (time) time.textContent = new Date(log.timestamp * 1000).toLocaleTimeString();

  let countEl = row.querySelector('.log-count');
  if (log.count > 1) {
    if (!countEl) {
      countEl = document.createElement('span');
      countEl.className = 'log-count';
      row.querySelector('.log-message-wrap')?.appendChild(countEl);
    }
    countEl.textContent = `×${log.count}`;
  } else if (countEl) {
    countEl.remove();
  }
}

function buildLogRow(log, animate = false) {
  const row = document.createElement('div');
  row.className = 'log-row' + (animate ? ' new' : '');
  row.dataset.id = log.id;
  row.dataset.level = log.level;
  if (log.id % 2 === 0) row.classList.add('log-row-alt');

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date(log.timestamp * 1000).toLocaleTimeString();

  const game = document.createElement('span');
  game.className = 'log-game';
  game.textContent = String(log.gameId);

  const badge = document.createElement('span');
  badge.className = `log-badge ${log.level}`;
  badge.textContent = log.level;

  const messageWrap = document.createElement('div');
  messageWrap.className = 'log-message-wrap';

  const message = document.createElement('span');
  message.className = 'log-message';
  message.textContent = log.message;
  messageWrap.appendChild(message);

  if (log.count > 1) {
    const countBadge = document.createElement('span');
    countBadge.className = 'log-count';
    countBadge.textContent = `×${log.count}`;
    messageWrap.appendChild(countBadge);
  }

  row.append(time, game, badge, messageWrap);

  row.addEventListener('click', () => {
    row.classList.toggle('expanded');
  });

  return row;
}

function toUnixSeconds(datetimeLocalValue) {
  if (!datetimeLocalValue) return '';
  const ms = new Date(datetimeLocalValue).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : '';
}

applyFiltersBtn.addEventListener('click', () => {
  const checkedLevels = [...levelCheckboxes].filter((cb) => cb.checked).map((cb) => cb.value);
  activeFilters = {
    levels: checkedLevels,
    gameId: gameIdFilterEl.value.trim(),
    startTime: toUnixSeconds(startTimeFilterEl.value),
    endTime: toUnixSeconds(endTimeFilterEl.value),
  };
  refresh();
});

clearFiltersBtn.addEventListener('click', () => {
  levelCheckboxes.forEach((cb) => (cb.checked = false));
  gameIdFilterEl.value = '';
  startTimeFilterEl.value = '';
  endTimeFilterEl.value = '';
  activeFilters = { levels: [], gameId: '', startTime: '', endTime: '' };
  refresh();
});

(async function init() {
  const storedKey = sessionStorage.getItem(STORAGE_KEY);
  if (!storedKey) return;

  const ok = await tryUnlock(storedKey);
  if (ok) {
    unlockApp();
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }
})();