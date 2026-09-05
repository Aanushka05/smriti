/* dashboard-analysis.js — the caregiver's "AI Insights" section.
 *
 * Shape of the panel, which mirrors what the backend engine produces:
 *
 *   Overall trend   Improving / Stable / Declining / Insufficient data
 *   Strengths       what the recorded activity supports
 *   Areas to watch  what the recorded activity flags
 *   Actions         practical, non-clinical next steps
 *
 * Every line carries the numbers it came from. The panel refreshes itself
 * from the lightweight GET endpoint whenever new data arrives, and only
 * calls the (paid, slower) POST endpoint when the caregiver asks for the
 * written-up version.
 */

const TREND_STYLE = {
  improving: { badge: 'bg-leafgreen text-white', icon: '📈' },
  stable: { badge: 'bg-slateb text-white', icon: '➡️' },
  declining: { badge: 'bg-alertc text-white', icon: '📉' },
  insufficient_data: { badge: 'bg-[#EDE7D8] text-inksoft', icon: '❓' },
};

/* ------------------------------------------------------------- loading */

/**
 * Recomputes the analysis from stored data. Cheap and side-effect free —
 * this is what runs after a live update, so the panel never goes stale.
 */
async function refreshAnalysis(opts = {}) {
  if (!state.patientId) return null;
  if (!opts.silent) { setLoad('analysis', 'loading'); render(); }

  const res = await api.analysisSnapshot(state.patientId, state.dateRange && state.dateRange.days);
  if (!res.ok) {
    setLoad('analysis', 'error', res.error);
    if (!opts.silent) render();
    return null;
  }
  state.analysis = res.data;
  setLoad('analysis', 'ready');
  if (!opts.silent) render();
  return state.analysis;
}

/** The written-up version. Costs an API call, so it is explicit. */
async function runAnalysis() {
  if (state.analysisBusy) return;
  state.analysisBusy = true;
  setLoad('analysis', 'loading');
  render();

  const res = await api.analysis(state.patientId, state.dateRange && state.dateRange.days);
  state.analysisBusy = false;

  if (!res.ok) {
    setLoad('analysis', 'error', res.error);
    render();
    return;
  }
  state.analysis = res.data;
  setLoad('analysis', 'ready');
  render();
}

/* -------------------------------------------------------------- render */

function sectionAnalysis() {
  const a = state.analysis;
  const status = state.loadState.analysis;

  const header = `
  ${sectionTitle(t('aiInsights'), escapeHtml(state.patient.name))}
  <div class="card-textile rounded-2xl p-5 mb-5">
    <p class="text-sm text-inksoft mb-4">${t('analysisHelp')}</p>
    <div class="flex gap-3 flex-wrap">
      <button onclick="refreshAnalysis()" ${state.analysisBusy ? 'disabled' : ''}
        class="px-5 py-3 rounded-xl bg-slateb text-white font-semibold min-h-[44px] disabled:opacity-60">
        🔄 ${t('recalculate')}
      </button>
      <button onclick="runAnalysis()" ${state.analysisBusy ? 'disabled' : ''}
        class="px-5 py-3 rounded-xl bg-maroon text-white font-semibold min-h-[44px] disabled:opacity-60">
        ${state.analysisBusy ? t('analysing') : '🤖 ' + t('writeUp')}
      </button>
    </div>
  </div>`;

  if (status === 'loading') {
    return `${header}<div class="card-textile rounded-2xl p-6">${panelState('analysis')}</div>`;
  }
  if (status === 'error') {
    return `${header}<div class="card-textile rounded-2xl p-6">${panelState('analysis', 'refreshAnalysis()')}</div>`;
  }
  if (!a) {
    return `${header}<div class="card-textile rounded-2xl p-8 text-center text-sm text-inksoft">${t('noAnalysisYet')}</div>`;
  }

  const style = TREND_STYLE[a.overallTrend] || TREND_STYLE.insufficient_data;
  const insufficient = a.overallTrend === 'insufficient_data';

  return `
  ${header}

  <div class="card-textile rounded-2xl p-5 mb-5">
    <div class="flex items-start justify-between flex-wrap gap-3 mb-3">
      <div class="min-w-0">
        <div class="text-xs text-inksoft mb-1">${t('overallTrend')}</div>
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-2xl" aria-hidden="true">${style.icon}</span>
          <span class="text-sm px-3 py-1.5 rounded-full font-semibold ${style.badge}">${escapeHtml(a.overallTrendLabel)}</span>
        </div>
      </div>
      <div class="text-right">
        <span class="text-xs px-3 py-1 rounded-full ${a.source === 'ai' ? 'bg-slateb text-white' : 'bg-[#EDE7D8] text-inksoft'}">
          ${a.source === 'ai' ? t('sourceAi') : t('sourceEngine')}
        </span>
        <div class="text-xs text-inksoft mt-1">${fmtDateTime(a.generatedAt)}</div>
      </div>
    </div>

    <p class="text-base leading-relaxed">${escapeHtml(a.headline)}</p>
    ${a.summary ? `<p class="text-sm text-inksoft mt-1">${escapeHtml(a.summary)}</p>` : ''}
    ${a.note ? `<p class="text-xs text-inksoft mt-3 italic">${escapeHtml(a.note)}</p>` : ''}
    ${a.narrative ? `
      <div class="text-sm leading-relaxed bg-[#F9F5EB] border border-linec rounded-xl p-4 mt-4 whitespace-pre-line">
        ${escapeHtml(a.narrative)}
      </div>` : ''}
  </div>

  ${insufficient ? '' : `
  <div class="grid lg:grid-cols-2 gap-5 mb-5">
    ${findingsCard('✅', t('strengths'), a.strengths, 'border-leafgreen bg-[#F2F7F1]')}
    ${findingsCard('👀', t('areasToWatch'), a.areasToWatch, 'border-ochre bg-[#FBF6EC]')}
  </div>`}

  <div class="card-textile rounded-2xl p-5 mb-5">
    <h2 class="font-serif2 text-lg mb-3">🧭 ${t('recommendedActions')}</h2>
    <ul class="list-disc pl-5 text-sm space-y-1.5">
      ${a.recommendedActions.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
    </ul>
  </div>

  ${analysisFiguresCard(a.figures)}

  <p class="text-xs text-inksoft mt-4">${escapeHtml(a.disclaimer)}</p>`;
}

function findingsCard(icon, title, items, tone) {
  return `
  <div class="card-textile rounded-2xl p-5">
    <h2 class="font-serif2 text-lg mb-3">${icon} ${title}</h2>
    <ul class="list-none p-0 m-0 flex flex-col gap-2.5">
      ${items.map((f) => `
        <li class="border-l-4 ${tone} rounded-r-lg p-3">
          <div class="text-sm font-semibold">${escapeHtml(f.title)}</div>
          <div class="text-xs text-inksoft mt-0.5">${escapeHtml(f.detail)}</div>
        </li>`).join('')}
    </ul>
  </div>`;
}

/** The raw numbers the analysis was derived from — so it can be checked. */
function analysisFiguresCard(f) {
  if (!f) return '';
  const cell = (label, value) => `
    <div class="bg-[#F9F5EB] rounded-lg p-3 text-center">
      <div class="text-lg font-serif2">${value == null ? '—' : value}</div>
      <div class="text-[11px] text-inksoft mt-0.5">${label}</div>
    </div>`;

  const withData = (f.byArea || []).filter((d) => d.sessions > 0);

  return `
  <div class="card-textile rounded-2xl p-5">
    <h2 class="font-serif2 text-lg mb-1">🔢 ${t('figuresBehindThis')}</h2>
    <p class="text-xs text-inksoft mb-4">${t('figuresBehindThisHelp')}</p>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
      ${cell(t('sessions'), f.sessions)}
      ${cell(t('overallAccuracy'), f.averageAccuracyPct == null ? null : f.averageAccuracyPct + '%')}
      ${cell(t('avgResponseTime'), f.averageResponseSeconds == null ? null : f.averageResponseSeconds + 's')}
      ${cell(t('adherence'), f.reminders.adherence == null ? null : f.reminders.adherence + '%')}
      ${cell(t('bestScore'), f.bestAccuracyPct == null ? null : f.bestAccuracyPct + '%')}
      ${cell(t('activeDays'), f.activeDays)}
      ${cell(t('completed'), f.reminders.completed)}
      ${cell(t('missed'), f.reminders.missed)}
    </div>

    ${withData.length === 0 ? `<div class="text-sm text-inksoft text-center py-4">${t('noPerformanceData')}</div>` : `
    <div class="overflow-x-auto">
      <table class="w-full min-w-[460px] text-sm">
        <thead>
          <tr class="text-left text-xs text-inksoft border-b border-linec">
            <th class="pb-2 font-medium">${t('activityArea')}</th>
            <th class="pb-2 font-medium">${t('sessions')}</th>
            <th class="pb-2 font-medium">${t('average')}</th>
            <th class="pb-2 font-medium">${t('best')}</th>
            <th class="pb-2 font-medium">${t('avgTime')}</th>
            <th class="pb-2 font-medium">${t('trend')}</th>
          </tr>
        </thead>
        <tbody>
          ${withData.map((d) => `
            <tr class="border-b border-linec last:border-0">
              <td class="py-2">${escapeHtml(d.label)}</td>
              <td class="py-2">${d.sessions}</td>
              <td class="py-2">${d.averagePct == null ? '—' : d.averagePct + '%'}</td>
              <td class="py-2">${d.bestPct == null ? '—' : d.bestPct + '%'}</td>
              <td class="py-2">${d.averageResponseSeconds == null ? '—' : d.averageResponseSeconds + 's'}</td>
              <td class="py-2">${t('trend_' + d.trend)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`}
  </div>`;
}
