/* dashboard-reports.js — the caregiver Reports section.
 *
 * Flow: pick a patient → pick a period (Daily / Weekly / Monthly / Yearly,
 * or the dashboard's custom range) → preview it → Download PDF or CSV.
 *
 * The preview, the PDF and the CSV are all rendered by the backend from
 * one report object, so what is on screen is exactly what downloads.
 */

const REPORT_PERIODS = [
  { key: 'daily', label: () => t('periodDaily') },
  { key: 'weekly', label: () => t('periodWeekly') },
  { key: 'monthly', label: () => t('periodMonthly') },
  { key: 'yearly', label: () => t('periodYearly') },
  { key: 'all', label: () => t('periodAll') },
];

/* ---------------------------------------------------------------- state */

function reportPatientId() {
  return state.reportPatientId || state.patientId;
}
function reportPeriodKey() {
  return state.reportPeriod || (state.dateRange && state.dateRange.reportPeriod !== 'custom'
    ? state.dateRange.reportPeriod : 'weekly');
}

function setReportPatient(id) {
  state.reportPatientId = id;
  state.report = null;              // the old preview belongs to another patient
  setLoad('report', 'idle');
  render();
}
function setReportPeriod(key) {
  state.reportPeriod = key;
  state.report = null;              // and to another period
  setLoad('report', 'idle');
  render();
}

/* ------------------------------------------------------------- actions */

async function generateReport() {
  const patientId = reportPatientId();
  if (!patientId) { showToast(t('selectPatientFirst')); return; }

  state.reportBusy = true;
  setLoad('report', 'loading');
  render();

  const res = await api.report(patientId, reportPeriodKey());
  state.reportBusy = false;

  if (!res.ok) {
    setLoad('report', 'error', res.error);
    render();
    return;
  }
  state.report = res.data.report;
  setLoad('report', 'ready');
  showToast(t('reportReady'));
  render();
}

/**
 * Downloads through fetch so the Authorization header travels with it —
 * a plain <a href> could not carry the token.
 */
async function downloadReportFile(format) {
  const patientId = reportPatientId();
  if (!patientId) { showToast(t('selectPatientFirst')); return; }

  state.downloadBusy = format;
  render();

  const period = reportPeriodKey();
  let query = `format=${encodeURIComponent(format)}&period=${encodeURIComponent(period)}`;
  // A custom dashboard range wins, so the download matches what is on screen.
  if (state.dateRange && state.dateRange.key === 'custom') {
    query += `&from=${state.dateRange.from}&to=${state.dateRange.to}`;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/patients/${encodeURIComponent(patientId)}/report/download?${query}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (res.status === 401) { handleSessionExpired(); return; }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error || t('reportFailed'));
      return;
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^"]+)"?/);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = match ? match[1] : `SmritiSaathi_Care_Report.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    showToast(`${t('reportDownloaded')} (${format.toUpperCase()})`);
  } catch (err) {
    showToast(t('reportFailed'));
  } finally {
    state.downloadBusy = null;
    render();
  }
}

/* -------------------------------------------------------------- render */

function sectionReports() {
  const patients = state.patients || [];
  const patientId = reportPatientId();
  const period = reportPeriodKey();
  const r = state.report;
  const status = state.loadState.report;

  const picker = `
  <div class="card-textile rounded-2xl p-5 mb-5">
    <h2 class="font-serif2 text-lg mb-1">${t('downloadReport')}</h2>
    <p class="text-sm text-inksoft mb-4">${t('reportHelp')}</p>

    <div class="grid md:grid-cols-2 gap-x-4">
      ${field(t('patient'), `<select id="rp-patient" onchange="setReportPatient(this.value)" class="${inputCls}">
        ${patients.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === patientId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
      </select>`)}
      ${field(t('reportPeriod'), `<select id="rp-period" onchange="setReportPeriod(this.value)" class="${inputCls}">
        ${REPORT_PERIODS.map((p) => `<option value="${p.key}" ${p.key === period ? 'selected' : ''}>${p.label()}</option>`).join('')}
      </select>`)}
    </div>

    <div class="flex flex-wrap gap-3">
      <button onclick="generateReport()" ${state.reportBusy ? 'disabled' : ''}
        class="px-6 py-3 rounded-xl bg-slateb text-white font-semibold min-h-[48px] disabled:opacity-60">
        ${state.reportBusy ? t('pleaseWait') : '👁 ' + t('preview')}
      </button>
      <button onclick="downloadReportFile('pdf')" ${state.downloadBusy ? 'disabled' : ''}
        class="px-6 py-3 rounded-xl bg-maroon text-white font-semibold min-h-[48px] disabled:opacity-60">
        ${state.downloadBusy === 'pdf' ? t('pleaseWait') : '⬇ ' + t('downloadPdf')}
      </button>
      <button onclick="downloadReportFile('csv')" ${state.downloadBusy ? 'disabled' : ''}
        class="px-6 py-3 rounded-xl border-2 border-linec bg-white font-semibold min-h-[48px] disabled:opacity-60">
        ${state.downloadBusy === 'csv' ? t('pleaseWait') : '⬇ ' + t('downloadCsv')}
      </button>
      <button onclick="downloadReportFile('html')" ${state.downloadBusy ? 'disabled' : ''}
        class="px-5 py-3 rounded-xl border border-linec bg-white text-sm font-semibold min-h-[48px] disabled:opacity-60">
        ⬇ ${t('downloadHtml')}
      </button>
    </div>
    <p class="text-xs text-inksoft mt-3">${t('reportContentNote')}</p>
  </div>`;

  const header = sectionTitle(t('reports'), escapeHtml(state.patient ? state.patient.name : ''));

  if (status === 'loading') return `${header}${picker}<div class="card-textile rounded-2xl p-6">${panelState('report')}</div>`;
  if (status === 'error') return `${header}${picker}<div class="card-textile rounded-2xl p-6">${panelState('report', 'generateReport()')}</div>`;
  if (!r) {
    return `${header}${picker}
    <div class="card-textile rounded-2xl p-8 text-center text-sm text-inksoft">${t('noReportYet')}</div>`;
  }

  return `${header}${picker}${reportPreview(r)}`;
}

/** On-screen preview: the same sections, in the same order, as the PDF. */
function reportPreview(r) {
  const dash = (v, s) => (v == null ? '—' : `${v}${s || ''}`);
  const kv = (label, value) => `
    <div>
      <div class="text-xs text-inksoft">${label}</div>
      <div class="text-sm font-semibold">${escapeHtml(value == null ? '—' : value)}</div>
    </div>`;

  return `
  <div class="card-textile rounded-2xl p-5">
    <div class="flex items-start justify-between flex-wrap gap-3 mb-4 pb-4 border-b border-linec">
      <div>
        <div class="font-serif2 text-xl text-maroon">${APP_NAME} — ${escapeHtml(r.period.title)}</div>
        <div class="text-xs text-inksoft mt-0.5">
          ${t('generated')} ${fmtDateTime(r.generatedAt)} ·
          ${r.period.from === 0 ? t('showingAllActivity')
    : `${new Date(r.period.from).toLocaleDateString()} – ${new Date(r.period.to).toLocaleDateString()}`}
        </div>
      </div>
    </div>

    <h3 class="font-serif2 text-base mb-2">${t('patientInformation')}</h3>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
      ${kv(t('fullName'), r.patient.name)}
      ${kv(t('patientId'), r.patient.patientId)}
      ${kv(t('age'), r.patient.age)}
      ${kv(t('reportPeriod'), r.period.label)}
    </div>

    <h3 class="font-serif2 text-base mb-2">${t('performanceSummary')}</h3>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
      ${kpiCard(t('overallScore'), dash(r.performance.overallScore, '%'), '')}
      ${kpiCard(t('bestScore'), dash(r.performance.bestScore, '%'), '')}
      ${kpiCard(t('avgResponseTime'), dash(r.performance.averageResponseSeconds, 's'), '')}
      ${kpiCard(t('sessions'), r.performance.totalSessions, '')}
    </div>
    <div class="overflow-x-auto mb-5">
      <table class="w-full min-w-[520px] text-sm">
        <thead><tr class="text-left text-xs text-inksoft border-b border-linec">
          <th class="pb-2">${t('activityArea')}</th><th class="pb-2">${t('sessions')}</th>
          <th class="pb-2">${t('average')}</th><th class="pb-2">${t('best')}</th>
          <th class="pb-2">${t('avgTime')}</th><th class="pb-2">${t('trend')}</th>
        </tr></thead>
        <tbody>
          ${r.performance.byDomain.map((d) => `
            <tr class="border-b border-linec last:border-0">
              <td class="py-2">${escapeHtml(d.label)}</td>
              <td class="py-2">${d.sessions}</td>
              <td class="py-2">
                ${d.avgAccuracy == null ? '—' : `
                  <div class="flex items-center gap-2">
                    <div class="h-2 rounded-full bg-[#EDE7D8] flex-1 min-w-[50px] max-w-[110px] overflow-hidden">
                      <div class="h-full rounded-full" style="width:${d.avgAccuracy}%;background:${DOMAIN_META[d.domain] ? DOMAIN_META[d.domain].color : '#6B2737'}"></div>
                    </div><span>${d.avgAccuracy}%</span>
                  </div>`}
              </td>
              <td class="py-2">${dash(d.bestAccuracy, '%')}</td>
              <td class="py-2">${dash(d.avgResponseSeconds, 's')}</td>
              <td class="py-2">${t('trend_' + d.trend) || escapeHtml(d.trend)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <h3 class="font-serif2 text-base mb-2">${t('reminderSummary')}</h3>
    <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
      ${kpiCard(t('totalReminders'), r.reminders.total, '')}
      ${kpiCard(t('completed'), r.reminders.completed, '')}
      ${kpiCard(t('missed'), r.reminders.missed, '')}
      ${kpiCard(t('snoozed'), r.reminders.snoozed, '')}
      ${kpiCard(t('adherence'), dash(r.reminders.adherence, '%'), '')}
    </div>

    <h3 class="font-serif2 text-base mb-2">${t('cognitiveSessionsHeading')}</h3>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
      ${kpiCard(t('numberOfSessions'), r.cognitiveSessions.count, '')}
      ${kpiCard(t('averageScore'), dash(r.cognitiveSessions.averageScore, '%'), '')}
      ${kpiCard(t('bestScore'), dash(r.cognitiveSessions.bestScore, '%'), '')}
      ${kpiCard(t('trend'), r.cognitiveSessions.trend, '')}
    </div>
    ${r.cognitiveSessions.recent.length ? `
    <div class="overflow-x-auto mb-5">
      <table class="w-full min-w-[560px] text-sm">
        <thead><tr class="text-left text-xs text-inksoft border-b border-linec">
          <th class="pb-2">${t('time')}</th><th class="pb-2">${t('game')}</th>
          <th class="pb-2">${t('activityArea')}</th><th class="pb-2">${t('score')}</th>
          <th class="pb-2">${t('accuracy')}</th><th class="pb-2">${t('avgTime')}</th>
        </tr></thead>
        <tbody>
          ${r.cognitiveSessions.recent.map((s) => `
            <tr class="border-b border-linec last:border-0">
              <td class="py-2">${escapeHtml(s.when)}</td>
              <td class="py-2">${escapeHtml(s.game)}</td>
              <td class="py-2">${escapeHtml(s.area)}</td>
              <td class="py-2">${escapeHtml(s.score || '—')}</td>
              <td class="py-2">${dash(s.accuracy, '%')}</td>
              <td class="py-2">${dash(s.responseSeconds, 's')}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `<p class="text-sm text-inksoft mb-5">${t('noSessionsInPeriod')}</p>`}

    ${r.analysis ? `
    <h3 class="font-serif2 text-base mb-2">${t('dataAnalysis')}</h3>
    <p class="text-sm mb-1"><strong>${t('overallTrend')}:</strong> ${escapeHtml(r.analysis.overallTrendLabel)}</p>
    <p class="text-sm mb-3">${escapeHtml(r.analysis.headline)}</p>
    <div class="grid md:grid-cols-2 gap-4 mb-3">
      <div>
        <div class="text-sm font-semibold mb-1">${t('strengths')}</div>
        <ul class="list-disc pl-5 text-sm space-y-1">
          ${r.analysis.strengths.map((s) => `<li>${escapeHtml(s.title)} — <span class="text-inksoft">${escapeHtml(s.detail)}</span></li>`).join('') || `<li class="text-inksoft">—</li>`}
        </ul>
      </div>
      <div>
        <div class="text-sm font-semibold mb-1">${t('areasToWatch')}</div>
        <ul class="list-disc pl-5 text-sm space-y-1">
          ${r.analysis.areasToWatch.map((s) => `<li>${escapeHtml(s.title)} — <span class="text-inksoft">${escapeHtml(s.detail)}</span></li>`).join('') || `<li class="text-inksoft">—</li>`}
        </ul>
      </div>
    </div>
    <div class="text-sm font-semibold mb-1">${t('suggestedCaregiverActions')}</div>
    <ul class="list-disc pl-5 text-sm space-y-1 mb-4">
      ${r.analysis.recommendedActions.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
    </ul>` : ''}

    <p class="text-xs text-inksoft border-t border-linec pt-3">${escapeHtml(r.disclaimer)}</p>
  </div>`;
}
