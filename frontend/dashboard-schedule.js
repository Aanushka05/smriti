/* dashboard-schedule.js — the caregiver's Schedule and Reminders sections.
 *
 * Schedule = the plan the caregiver sets (add / edit / delete).
 * Reminder = one dated occurrence of a schedule, which the patient (or the
 * caregiver) marks done, missed or snoozed.
 *
 * Every figure in these panels comes from the backend; nothing here is
 * generated for display.
 */

const SCHEDULE_CATEGORIES = ['Medicine', 'Meal', 'Hydration', 'Exercise', 'Appointment', 'Activity', 'Therapy', 'General'];
const SCHEDULE_REPEATS = ['once', 'daily', 'weekly', 'monthly'];
const SCHEDULE_PRIORITIES = ['low', 'normal', 'high'];
const SCHEDULE_REMINDER_TYPES = ['app', 'voice', 'both', 'none'];
const SNOOZE_CHOICES = [10, 15, 30, 60];

/* ----------------------------------------------------------- SCHEDULE */
function sectionSchedule() {
  const schedules = (state.patient.schedules || []).filter((s) => s.status !== 'deleted');
  const form = state.scheduleForm;

  return `
  ${sectionTitle(t('schedule'), escapeHtml(state.patient.name))}

  <div class="flex flex-wrap gap-3 mb-5">
    <button onclick="openScheduleForm()" class="px-5 py-3 rounded-xl bg-maroon text-white font-semibold min-h-[44px]">
      ➕ ${t('addSchedule')}
    </button>
    <button onclick="loadUpcoming()" class="px-5 py-3 rounded-xl border border-linec bg-white font-semibold min-h-[44px]">
      📅 ${t('viewUpcoming')}
    </button>
  </div>

  ${form ? scheduleFormCard(form) : ''}

  <div class="card-textile rounded-2xl p-5 mb-5">
    <h2 class="font-serif2 text-lg mb-3">${t('plannedActivities')}</h2>
    ${schedules.length === 0
    ? `<div class="text-center py-8 text-inksoft text-sm">${t('noSchedulesYet')}</div>`
    : `<div class="overflow-x-auto">
        <table class="w-full min-w-[680px] text-sm">
          <thead>
            <tr class="text-left text-xs text-inksoft border-b border-linec">
              <th class="pb-2 font-medium">${t('activity')}</th>
              <th class="pb-2 font-medium">${t('time')}</th>
              <th class="pb-2 font-medium">${t('repeats')}</th>
              <th class="pb-2 font-medium">${t('category')}</th>
              <th class="pb-2 font-medium">${t('priority')}</th>
              <th class="pb-2 font-medium">${t('reminderType')}</th>
              <th class="pb-2 font-medium text-right">${t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            ${schedules.map(scheduleRow).join('')}
          </tbody>
        </table>
      </div>`}
  </div>

  ${upcomingPanel()}`;
}

function scheduleRow(s) {
  const priorityBadge = {
    high: 'bg-[#FBEAE7] text-alertc',
    normal: 'bg-[#EDE7D8] text-inksoft',
    low: 'bg-[#F1F1EC] text-inksoft',
  }[s.priority] || 'bg-[#EDE7D8] text-inksoft';

  return `
  <tr class="border-b border-linec last:border-0 align-top">
    <td class="py-3 pr-3">
      <div class="font-semibold flex items-center gap-2">
        <span aria-hidden="true">${escapeHtml(s.icon)}</span>${escapeHtml(s.title)}
      </div>
      ${s.description ? `<div class="text-xs text-inksoft mt-0.5">${escapeHtml(s.description)}</div>` : ''}
      ${s.notes ? `<div class="text-xs text-inksoft italic mt-0.5">${escapeHtml(s.notes)}</div>` : ''}
    </td>
    <td class="py-3 pr-3 whitespace-nowrap font-semibold">${escapeHtml(s.time)}</td>
    <td class="py-3 pr-3 whitespace-nowrap">
      ${t('repeat_' + s.repeat)}
      ${s.repeat === 'once' && s.date ? `<div class="text-xs text-inksoft">${escapeHtml(s.date)}</div>` : ''}
    </td>
    <td class="py-3 pr-3 whitespace-nowrap">${t('cat' + s.category) || escapeHtml(s.category)}</td>
    <td class="py-3 pr-3"><span class="text-xs px-2.5 py-1 rounded-full ${priorityBadge}">${t('priority_' + s.priority)}</span></td>
    <td class="py-3 pr-3 whitespace-nowrap text-xs text-inksoft">${t('remType_' + s.reminderType)}</td>
    <td class="py-3 text-right whitespace-nowrap">
      <button onclick="openScheduleForm('${jsAttr(s.id)}')" class="px-3 py-2 rounded-lg border border-linec bg-white text-xs font-semibold min-h-[44px]">
        ${t('edit')}
      </button>
      <button onclick="confirmDeleteSchedule('${jsAttr(s.id)}','${jsAttr(s.title)}')" class="px-3 py-2 rounded-lg border border-alertc text-alertc bg-white text-xs font-semibold min-h-[44px] ml-1">
        ${t('delete')}
      </button>
    </td>
  </tr>`;
}

/* --------------------------------------------------------- ADD / EDIT */
function openScheduleForm(scheduleId) {
  const existing = scheduleId
    ? (state.patient.schedules || []).find((s) => s.id === scheduleId)
    : null;
  state.scheduleForm = existing
    ? { ...existing, mode: 'edit' }
    : {
      mode: 'add', id: null, title: '', description: '', category: 'Medicine',
      date: localDateKey(), time: '08:00', repeat: 'daily', reminderType: 'app',
      priority: 'normal', notes: '',
    };
  state.scheduleError = null;
  render();
  const first = document.getElementById('sf-title');
  if (first) first.focus();
}

function closeScheduleForm() {
  state.scheduleForm = null;
  state.scheduleError = null;
  render();
}

function scheduleFormCard(form) {
  const isEdit = form.mode === 'edit';
  return `
  <div class="card-textile rounded-2xl p-5 mb-5" role="region" aria-label="${isEdit ? t('editSchedule') : t('addSchedule')}">
    <div class="flex items-center justify-between mb-4">
      <h2 class="font-serif2 text-lg">${isEdit ? t('editSchedule') : t('addSchedule')}</h2>
      <button onclick="closeScheduleForm()" aria-label="${t('close')}" class="text-inksoft text-lg px-2">✕</button>
    </div>

    ${state.scheduleError ? `
      <div class="mb-4 rounded-xl border border-alertc bg-[#FBEAE7] text-alertc text-sm px-4 py-3" role="alert">
        ${escapeHtml(state.scheduleError)}
      </div>` : ''}

    <form onsubmit="return submitScheduleForm(event)">
      <div class="grid md:grid-cols-2 gap-x-4">
        ${field(t('patient'), `<input class="${inputCls} bg-[#F5F1E6]" value="${escapeHtml(state.patient.name)}" readonly aria-readonly="true">`)}
        ${field(t('activityName'), `<input required id="sf-title" class="${inputCls}" value="${escapeHtml(form.title)}" placeholder="${t('scheduleTitlePlaceholder')}" maxlength="120">`)}
      </div>

      ${field(t('description'), `<input id="sf-description" class="${inputCls}" value="${escapeHtml(form.description || '')}" placeholder="${t('descriptionPlaceholder')}">`)}

      <div class="grid md:grid-cols-3 gap-x-4">
        ${field(t('date'), `<input id="sf-date" type="date" class="${inputCls}" value="${escapeHtml(form.date || '')}">`, t('dateHint'))}
        ${field(t('time'), `<input required id="sf-time" type="time" class="${inputCls}" value="${escapeHtml(form.time || '')}">`)}
        ${field(t('repeats'), `<select id="sf-repeat" class="${inputCls}">
          ${SCHEDULE_REPEATS.map((r) => `<option value="${r}" ${form.repeat === r ? 'selected' : ''}>${t('repeat_' + r)}</option>`).join('')}
        </select>`)}
      </div>

      <div class="grid md:grid-cols-3 gap-x-4">
        ${field(t('category'), `<select id="sf-category" class="${inputCls}">
          ${SCHEDULE_CATEGORIES.map((c) => `<option value="${c}" ${form.category === c ? 'selected' : ''}>${t('cat' + c) || c}</option>`).join('')}
        </select>`)}
        ${field(t('reminderType'), `<select id="sf-reminder-type" class="${inputCls}">
          ${SCHEDULE_REMINDER_TYPES.map((r) => `<option value="${r}" ${form.reminderType === r ? 'selected' : ''}>${t('remType_' + r)}</option>`).join('')}
        </select>`)}
        ${field(t('priority'), `<select id="sf-priority" class="${inputCls}">
          ${SCHEDULE_PRIORITIES.map((pr) => `<option value="${pr}" ${form.priority === pr ? 'selected' : ''}>${t('priority_' + pr)}</option>`).join('')}
        </select>`)}
      </div>

      ${field(t('notes'), `<textarea id="sf-notes" rows="2" class="${inputCls}" placeholder="${t('optional')}">${escapeHtml(form.notes || '')}</textarea>`)}

      <div class="flex gap-3 flex-wrap">
        <button ${state.scheduleBusy ? 'disabled' : ''} class="px-6 py-3 rounded-xl bg-maroon text-white font-semibold min-h-[44px] disabled:opacity-60">
          ${state.scheduleBusy ? t('pleaseWait') : (isEdit ? t('saveChanges') : t('addSchedule'))}
        </button>
        <button type="button" onclick="closeScheduleForm()" class="px-6 py-3 rounded-xl border border-linec bg-white font-semibold min-h-[44px]">
          ${t('cancel')}
        </button>
      </div>
      <p class="text-xs text-inksoft mt-3">${t('scheduleCreatesReminder')}</p>
    </form>
  </div>`;
}

function readScheduleForm() {
  const value = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  };
  return {
    title: value('sf-title'),
    description: value('sf-description'),
    date: value('sf-date'),
    time: value('sf-time'),
    repeat: value('sf-repeat'),
    category: value('sf-category'),
    reminderType: value('sf-reminder-type'),
    priority: value('sf-priority'),
    notes: value('sf-notes'),
  };
}

async function submitScheduleForm(e) {
  e.preventDefault();
  if (state.scheduleBusy) return false;

  const form = state.scheduleForm;
  const payload = readScheduleForm();

  // Client-side checks first, so the common mistakes never need a round trip.
  if (!payload.title) { state.scheduleError = t('activityNameRequired'); render(); return false; }
  if (!/^\d{2}:\d{2}$/.test(payload.time)) { state.scheduleError = t('timeRequired'); render(); return false; }
  if (payload.repeat === 'once' && !payload.date) { state.scheduleError = t('dateRequiredForOnce'); render(); return false; }

  state.scheduleBusy = true; state.scheduleError = null; render();
  const res = form.mode === 'edit'
    ? await api.updateSchedule(form.id, payload)
    : await api.addSchedule(state.patientId, payload);
  state.scheduleBusy = false;

  if (!res.ok) { state.scheduleError = res.error; render(); return false; }

  state.scheduleForm = null;
  showToast(res.data.message || t('scheduleSaved'));
  await refreshPatientData(state.patientId);
  await loadCaregiverPatients({ silent: true });
  render();
  return false;
}

async function confirmDeleteSchedule(id, title) {
  // Destructive action — always confirm, and name what is being removed.
  if (!window.confirm(`${t('confirmDeleteSchedule')}\n\n${title}`)) return;
  const res = await api.deleteSchedule(id);
  if (!res.ok) { showToast(res.error); return; }
  showToast(res.data.message || t('scheduleRemoved'));
  await refreshPatientData(state.patientId);
  render();
}

/* --------------------------------------------------------- UPCOMING */
async function loadUpcoming() {
  setLoad('upcoming', 'loading');
  render();
  const res = await api.upcoming(state.patientId, 7);
  if (!res.ok) { setLoad('upcoming', 'error', res.error); render(); return; }
  state.upcoming = res.data.upcoming || [];
  setLoad('upcoming', 'ready');
  render();
}

function upcomingPanel() {
  const status = state.loadState.upcoming;
  if (status === 'idle') return '';

  return `
  <div class="card-textile rounded-2xl p-5">
    <div class="flex items-center justify-between mb-3">
      <h2 class="font-serif2 text-lg">${t('upcomingSchedules')}</h2>
      <button onclick="state.loadState.upcoming='idle';render()" class="text-xs text-inksoft" aria-label="${t('close')}">✕</button>
    </div>
    ${status !== 'ready' ? panelState('upcoming', 'loadUpcoming()') : (
    !state.upcoming || !state.upcoming.length
      ? `<div class="text-center py-6 text-inksoft text-sm">${t('nothingScheduledAhead')}</div>`
      : `<div class="flex flex-col gap-4">
          ${state.upcoming.map((day) => `
            <div>
              <div class="text-sm font-semibold text-maroon mb-2">${escapeHtml(formatDayLabel(day.date))}</div>
              <ul class="list-none p-0 m-0 flex flex-col gap-1.5">
                ${day.items.map((it) => `
                  <li class="flex items-center gap-3 text-sm bg-[#F9F5EB] rounded-lg px-3 py-2">
                    <span aria-hidden="true">${escapeHtml(it.icon)}</span>
                    <span class="font-medium">${escapeHtml(it.time)}</span>
                    <span class="flex-1 min-w-0 truncate">${escapeHtml(it.title)}</span>
                    <span class="text-xs text-inksoft">${t(it.status)}</span>
                  </li>`).join('')}
              </ul>
            </div>`).join('')}
        </div>`
  )}
  </div>`;
}

/* ---------------------------------------------------------- REMINDERS */
function sectionReminders() {
  const reminders = state.patient.reminders || [];
  const stats = state.patient.reminderStats;

  return `
  ${sectionTitle(t('reminders'), escapeHtml(state.patient.name))}
  ${reminderStatsRow(stats)}

  <div class="grid lg:grid-cols-3 gap-5">
    <div class="lg:col-span-2 card-textile rounded-2xl p-5">
      <h2 class="font-serif2 text-lg mb-3">${t('todaysReminders')}</h2>
      ${reminders.length === 0
    ? `<div class="text-center py-8 text-inksoft text-sm">${t('noRemindersToday')}</div>`
    : `<ul class="list-none p-0 m-0 flex flex-col gap-2">
          ${reminders.map(caregiverReminderRow).join('')}
        </ul>`}
      <p class="text-xs text-inksoft mt-3">${t('statusesUpdateLive')}</p>
    </div>
    <div class="card-textile rounded-2xl p-5 h-fit">
      <h2 class="font-serif2 text-lg mb-3">${t('adherence')}</h2>
      ${!stats || stats.allTime.total === 0
    ? `<div class="text-center py-6 text-inksoft text-sm">${t('noAdherenceData')}</div>`
    : `<div class="h-56"><canvas id="adherenceChart"></canvas></div>
       <p class="text-sm text-inksoft mt-2 text-center">
         ${stats.allTime.adherence === null ? t('noneDueYet') : `${t('overallAdherence')}: <strong>${stats.allTime.adherence}%</strong>`}
       </p>`}
    </div>
  </div>`;
}

function reminderStatsRow(stats) {
  if (!stats) return '';
  const cell = (label, value, tone) => `
    <div class="card-textile rounded-2xl p-4 text-center">
      <div class="text-2xl font-serif2 ${tone || 'text-ink'}">${value}</div>
      <div class="text-xs text-inksoft mt-0.5">${label}</div>
    </div>`;
  return `
  <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
    ${cell(t('totalReminders'), stats.allTime.total)}
    ${cell(t('completed'), stats.allTime.completed, 'text-leafgreen')}
    ${cell(t('missed'), stats.allTime.missed, 'text-alertc')}
    ${cell(t('snoozed'), stats.allTime.snoozed, 'text-ochre')}
    ${cell(t('adherence'), stats.allTime.adherence === null ? '—' : stats.allTime.adherence + '%')}
  </div>`;
}

function caregiverReminderRow(r) {
  const badge = {
    done: 'bg-leafgreen text-white',
    missed: 'bg-alertc text-white',
    snoozed: 'bg-ochre text-white',
    pending: 'bg-[#EDE7D8] text-inksoft',
  }[r.status] || 'bg-[#EDE7D8] text-inksoft';

  const snoozeInfo = r.status === 'snoozed' && r.snoozedUntil
    ? ` · ${t('until')} ${new Date(r.snoozedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : '';

  return `
  <li class="flex items-center gap-3 p-3 bg-[#F9F5EB] rounded-lg flex-wrap">
    <span class="text-xl" aria-hidden="true">${escapeHtml(r.icon)}</span>
    <div class="flex-1 min-w-[150px]">
      <div class="text-sm font-semibold">${escapeHtml(r.title)} · ${escapeHtml(r.time)}</div>
      <div class="text-xs text-inksoft">${escapeHtml(r.text || '')}</div>
    </div>
    <span class="text-xs px-2.5 py-1 rounded-full ${badge}">${t(r.status)}${snoozeInfo}</span>
    <div class="flex gap-1.5 flex-wrap">
      ${r.status === 'done' ? '' : `
        <button onclick="caregiverCompleteReminder('${jsAttr(r.id)}')" class="text-xs px-3 py-2 rounded-lg border border-linec bg-white min-h-[44px]">✓ ${t('done')}</button>
        <button onclick="caregiverSnoozeReminder('${jsAttr(r.id)}')" class="text-xs px-3 py-2 rounded-lg border border-linec bg-white min-h-[44px]">⏰ ${t('snooze')}</button>`}
      ${r.status === 'missed' ? '' : `
        <button onclick="caregiverMissReminder('${jsAttr(r.id)}')" class="text-xs px-3 py-2 rounded-lg border border-linec bg-white min-h-[44px]">${t('markMissed')}</button>`}
    </div>
  </li>`;
}

async function afterReminderChange(res, message) {
  if (!res.ok) { showToast(res.error); return; }
  if (message) showToast(message);
  await refreshPatientData(state.patientId);
  await loadCaregiverPatients({ silent: true });
  render();
}

async function caregiverCompleteReminder(id) {
  await afterReminderChange(await api.completeReminder(id), t('reminderMarkedDone'));
}

async function caregiverMissReminder(id) {
  await afterReminderChange(await api.missReminder(id), t('reminderMarkedMissed'));
}

async function caregiverSnoozeReminder(id) {
  const answer = window.prompt(`${t('snoozeForMinutes')} (${SNOOZE_CHOICES.join(' / ')})`, '15');
  if (answer === null) return;
  const minutes = Number(answer);
  if (!Number.isFinite(minutes) || minutes < 5 || minutes > 180) {
    showToast(t('snoozeRange'));
    return;
  }
  await afterReminderChange(await api.snoozeReminder(id, minutes), null);
}
