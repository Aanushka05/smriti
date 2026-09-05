/* daterange.js — ONE date filter, shared by everything.
 *
 * The caregiver picks a range once and it drives, together:
 *   charts · performance figures · session list · AI analysis · reports
 *
 * It works because every one of those reads the same state.dateRange and
 * passes the same {from, to} to the backend, and because changing the
 * range goes through a single function (setDateRange) that re-fetches and
 * re-renders. There is no second copy of "the selected period" anywhere.
 */

const DATE_PRESETS = [
  {
    key: 'today',
    label: () => t('rangeToday'),
    reportPeriod: 'daily',
    resolve: () => {
      const from = new Date(); from.setHours(0, 0, 0, 0);
      return { from: from.getTime(), to: Date.now() };
    },
  },
  {
    key: 'last7',
    label: () => t('rangeLast7'),
    reportPeriod: 'weekly',
    resolve: () => ({ from: Date.now() - 7 * 86400000, to: Date.now() }),
  },
  {
    key: 'last30',
    label: () => t('rangeLast30'),
    reportPeriod: 'monthly',
    resolve: () => ({ from: Date.now() - 30 * 86400000, to: Date.now() }),
  },
  {
    key: 'thisYear',
    label: () => t('rangeThisYear'),
    reportPeriod: 'yearly',
    resolve: () => ({ from: new Date(new Date().getFullYear(), 0, 1).getTime(), to: Date.now() }),
  },
  {
    key: 'all',
    label: () => t('rangeAll'),
    reportPeriod: 'all',
    resolve: () => ({ from: 0, to: Date.now() }),
  },
  {
    key: 'custom',
    label: () => t('rangeCustom'),
    reportPeriod: 'custom',
    resolve: (custom) => {
      const from = custom && custom.from ? new Date(`${custom.from}T00:00:00`).getTime() : Date.now() - 7 * 86400000;
      const to = custom && custom.to ? new Date(`${custom.to}T23:59:59`).getTime() : Date.now();
      return { from, to };
    },
  },
];

const DEFAULT_RANGE_KEY = 'last30';

function presetByKey(key) {
  return DATE_PRESETS.find((p) => p.key === key) || DATE_PRESETS.find((p) => p.key === DEFAULT_RANGE_KEY);
}

/** Builds the range object the whole app passes around. */
function makeDateRange(key, custom) {
  const preset = presetByKey(key);
  const { from, to } = preset.resolve(custom);
  return {
    key: preset.key,
    label: preset.label(),
    reportPeriod: preset.reportPeriod,
    from,
    to,
    custom: custom || null,
    // Kept for the endpoints that still take a day count.
    days: from === 0 ? 0 : Math.max(1, Math.round((to - from) / 86400000)),
  };
}

/** The one place the selected range changes. Everything re-reads from here. */
async function setDateRange(key, custom) {
  const next = makeDateRange(key, custom);
  if (next.key === 'custom' && next.from > next.to) {
    showToast(t('rangeInvalid'));
    return;
  }
  state.dateRange = next;
  try { localStorage.setItem('smritisaathi_range_v1', JSON.stringify({ key: next.key, custom: next.custom })); } catch (e) { /* private mode */ }

  // Re-pull the patient for the new window; the charts, KPI cards and the
  // session table all read that one object, so they move together.
  if (state.patientId) await refreshPatientData(state.patientId);

  // The analysis is period-scoped too — refresh it if it is on screen.
  if (state.role === 'caregiver' && state.cgSection === 'analysis' && state.analysis
      && typeof refreshAnalysis === 'function') {
    await refreshAnalysis({ silent: true });
  }
  render();
}

/** Restores the caregiver's last choice, or the default. */
function initDateRange() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('smritisaathi_range_v1')); } catch (e) { saved = null; }
  state.dateRange = makeDateRange(saved && saved.key ? saved.key : DEFAULT_RANGE_KEY, saved && saved.custom);
  return state.dateRange;
}

function onRangePresetChange(value) {
  if (value === 'custom') {
    // Seed the custom inputs from the current window so the dates are sane.
    const r = state.dateRange;
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    setDateRange('custom', { from: iso(r.from || Date.now() - 7 * 86400000), to: iso(r.to) });
    return;
  }
  setDateRange(value);
}

function applyCustomRange() {
  const from = document.getElementById('dr-from');
  const to = document.getElementById('dr-to');
  if (!from || !to) return;
  if (!from.value || !to.value) { showToast(t('rangePickBothDates')); return; }
  setDateRange('custom', { from: from.value, to: to.value });
}

/* --------------------------------------------------------------- render */

/** The picker itself — one component, used wherever a range matters. */
function dateRangePicker() {
  const r = state.dateRange || initDateRange();
  const isCustom = r.key === 'custom';

  return `
  <div class="flex items-center gap-2 flex-wrap" role="group" aria-label="${t('dateRange')}">
    <label for="dr-preset" class="text-xs text-inksoft">${t('dateRange')}</label>
    <select id="dr-preset" onchange="onRangePresetChange(this.value)"
      class="text-sm border border-linec rounded-lg px-3 py-2 bg-white min-h-[40px]">
      ${DATE_PRESETS.map((p) => `<option value="${p.key}" ${p.key === r.key ? 'selected' : ''}>${p.label()}</option>`).join('')}
    </select>
    ${isCustom ? `
      <input id="dr-from" type="date" value="${escapeHtml((r.custom && r.custom.from) || '')}"
        aria-label="${t('from')}" class="text-sm border border-linec rounded-lg px-2 py-2 bg-white min-h-[40px]">
      <span class="text-xs text-inksoft">${t('to')}</span>
      <input id="dr-to" type="date" value="${escapeHtml((r.custom && r.custom.to) || '')}"
        aria-label="${t('to')}" class="text-sm border border-linec rounded-lg px-2 py-2 bg-white min-h-[40px]">
      <button onclick="applyCustomRange()" class="text-sm px-3 py-2 rounded-lg bg-maroon text-white font-semibold min-h-[40px]">
        ${t('apply')}
      </button>` : ''}
  </div>`;
}

/** A short "showing X – Y" line, so the numbers on screen are never ambiguous. */
function dateRangeCaption() {
  const r = state.dateRange || initDateRange();
  if (r.from === 0) return t('showingAllActivity');
  return `${t('showing')} ${new Date(r.from).toLocaleDateString()} – ${new Date(r.to).toLocaleDateString()}`;
}
