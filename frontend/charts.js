/* charts.js — every chart on the caregiver dashboard.
 *
 * Load order: Chart.js is a synchronous <script> in <head> (see index.html,
 * frontend/vendor/), so the Chart global already exists by the time this
 * file is parsed at the end of <body>. chartsReady() is not a guard around
 * a bug — it is how we report honestly if the library genuinely could not
 * be loaded, instead of throwing "Chart is not defined" at the console.
 *
 * Instance management: every chart is created through renderChart(), which
 * destroys the previous instance bound to that canvas first. That is what
 * prevents "Canvas is already in use" and duplicate-instance leaks when the
 * dashboard re-renders (which it does on every live update).
 *
 * Data: charts read state.patient.sessions / .metrics / .reminderStats —
 * the records the backend actually stored. Nothing here is generated.
 */

/* canvasId -> Chart instance */
const CHART_REGISTRY = new Map();

/** True when the charting library is available. */
function chartsReady() {
  return typeof Chart !== 'undefined' && typeof Chart === 'function';
}

/**
 * Creates a chart on `canvasId`, destroying whatever was there before.
 * Returns the instance, or null when the canvas is not on screen.
 */
function renderChart(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  destroyChart(canvasId);
  clearChartMessage(canvasId);
  canvas.classList.remove('hidden');

  // Chart.js also tracks instances by canvas; if anything else attached one
  // (a stale instance from a previous page state), take it down too.
  const existing = typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
  if (existing) existing.destroy();

  const instance = new Chart(canvas, config);
  CHART_REGISTRY.set(canvasId, instance);
  return instance;
}

function destroyChart(canvasId) {
  const instance = CHART_REGISTRY.get(canvasId);
  if (instance) {
    try { instance.destroy(); } catch (e) { /* already gone */ }
    CHART_REGISTRY.delete(canvasId);
  }
}

/** Called before the dashboard re-renders, so no instance outlives its canvas. */
function destroyAllCharts() {
  for (const id of Array.from(CHART_REGISTRY.keys())) destroyChart(id);
}

/* ------------------------------------------------- non-chart chart states */

function chartMessageHost(canvasId) {
  const canvas = document.getElementById(canvasId);
  return canvas && canvas.parentElement ? canvas.parentElement : null;
}

function clearChartMessage(canvasId) {
  const host = chartMessageHost(canvasId);
  if (!host) return;
  host.querySelectorAll('.chart-message').forEach((el) => el.remove());
}

/**
 * Replaces a canvas with a readable message. `tone` picks the wording style:
 * 'empty' (no data yet), 'loading', or 'error'.
 */
function showChartMessage(canvasId, message, tone) {
  const canvas = document.getElementById(canvasId);
  const host = chartMessageHost(canvasId);
  if (!canvas || !host) return;

  destroyChart(canvasId);
  clearChartMessage(canvasId);
  canvas.classList.add('hidden');
  if (!host.style.position) host.style.position = 'relative';

  const el = document.createElement('div');
  el.className = 'chart-message absolute inset-0 flex flex-col items-center justify-center text-center px-4 gap-2';
  if (tone === 'loading') {
    el.innerHTML = `<span class="spinner" aria-hidden="true"></span><span class="text-sm text-inksoft">${escapeHtml(message)}</span>`;
    el.setAttribute('role', 'status');
  } else if (tone === 'error') {
    el.innerHTML = `<span class="text-2xl" aria-hidden="true">⚠️</span><span class="text-sm text-alertc">${escapeHtml(message)}</span>`;
    el.setAttribute('role', 'alert');
  } else {
    el.innerHTML = `<span class="text-2xl opacity-50" aria-hidden="true">📊</span><span class="text-sm text-inksoft">${escapeHtml(message)}</span>`;
  }
  host.appendChild(el);
}

/* --------------------------------------------------------------- helpers */

const CHART_BASE_OPTIONS = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 400 },
  interaction: { intersect: false, mode: 'nearest' },
};

const percentScale = () => ({
  y: { min: 0, max: 100, ticks: { callback: (v) => `${v}%`, font: { size: 12 } } },
  x: { ticks: { font: { size: 12 } } },
});

function domainLabel(domain) {
  return DOMAIN_META[domain] ? DOMAIN_META[domain].label() : domain;
}
function domainColor(domain) {
  return DOMAIN_META[domain] ? DOMAIN_META[domain].color : '#6B2737';
}

/** Sessions sorted oldest-first, tolerating either timestamp field. */
function sortedSessions(patient) {
  return (patient && patient.sessions ? patient.sessions : [])
    .slice()
    .sort((a, b) => (a.ts || a.completed_at || 0) - (b.ts || b.completed_at || 0));
}

/* ===================================================================== */
/* 1. COGNITIVE PERFORMANCE OVER TIME                                    */
/* ===================================================================== */
/**
 * One line per activity area, plotted against that area's own session
 * number. Handles the single-session case by drawing a visible point
 * rather than an invisible zero-length line.
 */
function drawCognitivePerformanceChart(sessions, canvasId) {
  const id = canvasId || 'trendChart';
  if (!chartsReady()) { showChartMessage(id, t('chartsUnavailable'), 'error'); return null; }
  if (!sessions || sessions.length === 0) {
    showChartMessage(id, t('noPerformanceData'), 'empty');
    return null;
  }

  const domains = Object.keys(DOMAIN_META).filter((d) => sessions.some((s) => s.domain === d));
  const maxLen = Math.max(...domains.map((d) => sessions.filter((s) => s.domain === d).length));
  const labels = Array.from({ length: maxLen }, (_, i) => `#${i + 1}`);

  const datasets = domains.map((d) => {
    const rows = sessions.filter((s) => s.domain === d);
    return {
      label: domainLabel(d),
      data: rows.map((s) => Math.round(s.accuracy * 100)),
      borderColor: domainColor(d),
      backgroundColor: domainColor(d),
      tension: 0.35,
      spanGaps: true,
      pointRadius: rows.length === 1 ? 6 : 3,
      pointHoverRadius: 7,
      borderWidth: 2,
    };
  });

  return renderChart(id, {
    type: 'line',
    data: { labels, datasets },
    options: {
      ...CHART_BASE_OPTIONS,
      scales: percentScale(),
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            afterBody: (items) => {
              const item = items[0];
              if (!item) return '';
              const d = domains[item.datasetIndex];
              const s = sessions.filter((x) => x.domain === d)[item.dataIndex];
              if (!s) return '';
              const when = new Date(s.ts || s.completed_at).toLocaleString();
              return `${s.gameType || domainLabel(d)}\n${when}`;
            },
          },
        },
      },
    },
  });
}

/* ===================================================================== */
/* 2. AVERAGE PERFORMANCE BY DOMAIN                                      */
/* ===================================================================== */
/**
 * Averages come from the backend's performance_metrics rollup when it is
 * present (the authoritative figure), falling back to the session rows.
 * Areas with no activity are left out rather than drawn as a zero bar.
 */
function drawDomainChart(metrics, sessions, canvasId) {
  const id = canvasId || 'compareChart';
  if (!chartsReady()) { showChartMessage(id, t('chartsUnavailable'), 'error'); return null; }

  const rows = Object.keys(DOMAIN_META).map((d) => {
    const metric = (metrics || []).find((m) => m.domain === d);
    if (metric && metric.sessions_count > 0) {
      return { domain: d, value: Math.round(metric.avg_accuracy * 100), count: metric.sessions_count };
    }
    const played = (sessions || []).filter((s) => s.domain === d);
    if (!played.length) return null;
    return {
      domain: d,
      value: Math.round((played.reduce((a, s) => a + s.accuracy, 0) / played.length) * 100),
      count: played.length,
    };
  }).filter(Boolean);

  if (!rows.length) { showChartMessage(id, t('noPerformanceData'), 'empty'); return null; }

  return renderChart(id, {
    type: 'bar',
    data: {
      labels: rows.map((r) => domainLabel(r.domain)),
      datasets: [{
        data: rows.map((r) => r.value),
        backgroundColor: rows.map((r) => domainColor(r.domain)),
        borderRadius: 6,
      }],
    },
    options: {
      ...CHART_BASE_OPTIONS,
      scales: percentScale(),
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const row = rows[ctx.dataIndex];
              return `${ctx.parsed.y}% · ${row.count} ${row.count === 1 ? t('sessionSingular') : t('sessions').toLowerCase()}`;
            },
          },
        },
      },
    },
  });
}

/* ===================================================================== */
/* 3. AVERAGE RESPONSE TIME OVER SESSIONS                                */
/* ===================================================================== */
/** Measured seconds per answer, oldest session first. */
function drawResponseTimeChart(sessions, canvasId) {
  const id = canvasId || 'respChart';
  if (!chartsReady()) { showChartMessage(id, t('chartsUnavailable'), 'error'); return null; }
  if (!sessions || sessions.length === 0) {
    showChartMessage(id, t('noResponseTimeData'), 'empty');
    return null;
  }

  const values = sessions.map((s) => +(s.avgTimeMs / 1000).toFixed(1));
  return renderChart(id, {
    type: 'line',
    data: {
      labels: sessions.map((_, i) => `#${i + 1}`),
      datasets: [{
        label: t('avgResponseTime'),
        data: values,
        borderColor: '#8B5E34',
        backgroundColor: 'rgba(139,94,52,0.12)',
        fill: true,
        tension: 0.3,
        pointRadius: sessions.length === 1 ? 6 : 3,
        borderWidth: 2,
      }],
    },
    options: {
      ...CHART_BASE_OPTIONS,
      scales: {
        y: { beginAtZero: true, ticks: { callback: (v) => `${v}s`, font: { size: 12 } } },
        x: { ticks: { font: { size: 12 } } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.parsed.y}s ${t('perQuestion')}`,
            afterBody: (items) => {
              const s = sessions[items[0].dataIndex];
              if (!s) return '';
              return `${s.gameType || domainLabel(s.domain)}\n${new Date(s.ts || s.completed_at).toLocaleString()}`;
            },
          },
        },
      },
    },
  });
}

/* ===================================================================== */
/* 4. REMINDER ADHERENCE                                                 */
/* ===================================================================== */
/** Counts come from the backend's stored occurrences, all time. */
function drawReminderAdherenceChart(reminderStats, canvasId) {
  const id = canvasId || 'adherenceChart';
  if (!chartsReady()) { showChartMessage(id, t('chartsUnavailable'), 'error'); return null; }

  const stats = reminderStats && reminderStats.allTime;
  if (!stats || !stats.total) { showChartMessage(id, t('noAdherenceData'), 'empty'); return null; }

  const slices = [
    { label: t('completed'), value: stats.completed, color: '#3E5C3A' },
    { label: t('pending'), value: stats.pending, color: '#E4DCC9' },
    { label: t('snoozed'), value: stats.snoozed, color: '#C88B2E' },
    { label: t('missed'), value: stats.missed, color: '#B23A2E' },
  ].filter((s) => s.value > 0);

  if (!slices.length) { showChartMessage(id, t('noAdherenceData'), 'empty'); return null; }

  return renderChart(id, {
    type: 'doughnut',
    data: {
      labels: slices.map((s) => s.label),
      datasets: [{ data: slices.map((s) => s.value), backgroundColor: slices.map((s) => s.color), borderWidth: 0 }],
    },
    options: {
      ...CHART_BASE_OPTIONS,
      cutout: '58%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = slices.reduce((a, s) => a + s.value, 0);
              const pct = Math.round((ctx.parsed / total) * 100);
              return `${ctx.label}: ${ctx.parsed} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

/* ===================================================================== */
/* SUMMARY NUMBERS (shared by the KPI cards)                             */
/* ===================================================================== */
function statsFor(patient) {
  const domains = Object.keys(DOMAIN_META);
  const empty = {
    all: [], totalSessions: 0, overallAccuracy: null, domainAvg: {}, avgResponseTime: '—',
    remCompletion: null, remStatuses: [], flags: [], improving: [],
  };
  if (!patient) return empty;

  const all = sortedSessions(patient);
  const reminders = patient.reminders || [];
  const totalSessions = all.length;
  const overallAccuracy = totalSessions
    ? Math.round((all.reduce((a, s) => a + s.accuracy, 0) / totalSessions) * 100) : null;

  const domainAvg = {};
  domains.forEach((d) => {
    const arr = all.filter((s) => s.domain === d);
    domainAvg[d] = arr.length ? Math.round((arr.reduce((a, s) => a + s.accuracy, 0) / arr.length) * 100) : null;
  });

  const avgResponseTime = totalSessions
    ? (all.reduce((a, s) => a + s.avgTimeMs, 0) / totalSessions / 1000).toFixed(1) : '—';

  // Adherence: completed out of the reminders that actually came due.
  // null = nothing has come due yet, which the UI shows as a dash.
  const remStatuses = reminders.map((r) => r.status || 'pending');
  const remCompletion = patient.reminderStats ? patient.reminderStats.allTime.adherence : null;

  const flags = domains.filter((d) => {
    const arr = all.filter((s) => s.domain === d);
    if (arr.length < 3) return false;
    const last3 = arr.slice(-3);
    return last3[0].accuracy > last3[1].accuracy && last3[1].accuracy > last3[2].accuracy;
  });
  const improving = domains.filter((d) => {
    const arr = all.filter((s) => s.domain === d);
    return arr.length >= 2 && arr[arr.length - 1].accuracy >= arr[0].accuracy;
  });

  return { all, totalSessions, overallAccuracy, domainAvg, avgResponseTime, remCompletion, remStatuses, flags, improving };
}

/* ===================================================================== */
/* ENTRY POINT — called after every dashboard render                     */
/* ===================================================================== */
/**
 * Draws whichever of the four charts have a canvas on the current screen.
 * Safe to call repeatedly: renderChart() destroys the old instance first,
 * so a live update never leaves two Chart objects on one canvas.
 */
function drawCharts() {
  const p = state.patient;

  // Honest reporting, not suppression: if the library is genuinely absent we
  // say so on every canvas AND log it once, rather than throwing on each call.
  if (!chartsReady()) {
    if (!drawCharts._warned) {
      console.error('[charts] Chart.js did not load. Expected frontend/vendor/chart.umd.min.js to be served.');
      drawCharts._warned = true;
    }
    ['trendChart', 'compareChart', 'respChart', 'adherenceChart']
      .forEach((id) => showChartMessage(id, t('chartsUnavailable'), 'error'));
    return;
  }

  // The dashboard is still fetching this patient.
  if (state.loadState && state.loadState.patient === 'loading') {
    ['trendChart', 'compareChart', 'respChart', 'adherenceChart']
      .forEach((id) => showChartMessage(id, t('loadingPerformance'), 'loading'));
    return;
  }
  // The fetch failed — say so on the charts too, not just in the panel.
  if (state.loadState && state.loadState.patient === 'error') {
    ['trendChart', 'compareChart', 'respChart', 'adherenceChart']
      .forEach((id) => showChartMessage(id, t('couldNotLoadPerformance'), 'error'));
    return;
  }
  if (!p) return;

  const sessions = sortedSessions(p);
  drawCognitivePerformanceChart(sessions);
  drawDomainChart(p.metrics, sessions);
  drawResponseTimeChart(sessions);
  drawReminderAdherenceChart(p.reminderStats);
}
