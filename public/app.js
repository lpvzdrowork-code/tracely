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

const statInfoEl = document.getElementById('statInfo');
const statWarnEl = document.getElementById('statWarn');
const statErrorEl = document.getElementById('statError');

const levelFilterEl = document.getElementById('levelFilter');
const gameIdFilterEl = document.getElementById('gameIdFilter');
const applyFiltersBtn = document.getElementById('applyFilters');
const clearFiltersBtn = document.getElementById('clearFilters');

let chart = null;
let refreshTimer = null;
let activeFilters = { level: '', gameId: '' };

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
    renderChart(stats.hourly);
    renderLogs(logsData.logs);

    lastUpdatedEl.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    lastUpdatedEl.textContent = 'connection lost — retrying…';
  }
}

function buildLogsUrl() {
  const params = new URLSearchParams();
  if (activeFilters.level) params.set('level', activeFilters.level);
  if (activeFilters.gameId) params.set('gameId', activeFilters.gameId);
  params.set('limit', '100');
  return `/api/logs?${params.toString()}`;
}

function renderStats(stats) {
  statInfoEl.textContent = (stats.counts.INFO ?? 0).toLocaleString();
  statWarnEl.textContent = (stats.counts.WARN ?? 0).toLocaleString();
  statErrorEl.textContent = (stats.counts.ERROR ?? 0).toLocaleString();
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

function renderLogs(logs) {
  logFeedEl.innerHTML = '';

  if (!logs || logs.length === 0) {
    emptyStateEl.hidden = false;
    logFeedEl.appendChild(emptyStateEl);
    return;
  }
  emptyStateEl.hidden = true;

  for (const log of logs) {
    logFeedEl.appendChild(buildLogRow(log));
  }
}

function buildLogRow(log) {
  const row = document.createElement('div');
  row.className = 'log-row';

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = new Date(log.timestamp * 1000).toLocaleTimeString();

  const game = document.createElement('span');
  game.className = 'log-game';
  game.textContent = String(log.gameId);

  const badge = document.createElement('span');
  badge.className = `log-badge ${log.level}`;
  badge.textContent = log.level;

  const message = document.createElement('span');
  message.className = 'log-message';
  message.textContent = log.message;

  row.append(time, game, badge, message);

  row.addEventListener('click', () => {
    row.classList.toggle('expanded');
  });

  return row;
}

applyFiltersBtn.addEventListener('click', () => {
  activeFilters = {
    level: levelFilterEl.value,
    gameId: gameIdFilterEl.value.trim(),
  };
  refresh();
});

clearFiltersBtn.addEventListener('click', () => {
  levelFilterEl.value = '';
  gameIdFilterEl.value = '';
  activeFilters = { level: '', gameId: '' };
  refresh();
});

// Boot: if a key is already stored, validate it silently before showing the app.
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
