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
const quickRangeBtns    = document.querySelectorAll('.quick-range-btn');

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
  if (pendingUrlPermalink) primePermalink(pendingUrlPermalink);
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

    if (view === 'metrics' && chart) chart.update();
  });
});

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
  if (isPaused) return;
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

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString();
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

  sec1.appendChild(makeDetailField('Timestamp', new Date(log.timestamp * 1000).toLocaleString()));
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
    const res = await fetch(`/api/log-by-id?id=${targetId}`, { headers: authHeaders() });
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
  if (!retentionSelect) return;
  try {
    const res = await fetch('/api/settings', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (data.logRetentionDays) retentionSelect.value = String(data.logRetentionDays);
  } catch { /* leave default selected */ }
}

if (retentionSelect) {
  retentionSelect.addEventListener('change', async () => {
    const key = sessionStorage.getItem(STORAGE_KEY);
    if (retentionStatus) retentionStatus.hidden = true;
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracelyKey: key, logRetentionDays: Number(retentionSelect.value) }),
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
      const key = sessionStorage.getItem(STORAGE_KEY);
      const res = await fetch('/api/clear-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracelyKey: key, gameId: gameId || undefined }),
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && nukeModalOverlay && !nukeModalOverlay.hidden) closeNukeModal();
});

// ─────────────────────────────────────────
// Init
// ─────────────────────────────────────────
(async function init() {
  applyTheme(getThemePref());
  applyDensity(getDensityPref());
  renderRedactionTags();
  applyStreamUI();

  const key = sessionStorage.getItem(STORAGE_KEY);
  if (!key) return;
  const ok = await tryUnlock(key);
  if (ok) {
    unlockApp();
    loadRetentionSetting();
    if (pendingUrlPermalink) primePermalink(pendingUrlPermalink);
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }
})();