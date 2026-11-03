/* ============================================================================
 * dashboard-play.js — what the caregiver sees about play, and what they can
 * change about it.
 *
 * Everything here is read from stored sessions. Nothing is estimated, and a
 * figure with no data behind it renders as "—" rather than a zero, because a
 * zero reads as "they did badly" when it means "we do not know".
 * ==========================================================================*/

/** Sessions that carry adaptive data. Older rows simply have none. */
function adaptiveSessions(patient) {
  return sortedSessions(patient).filter((s) => s.adaptiveScore != null);
}

function playSection() {
  const p = state.patient;
  const play = p.play || null;

  return `
  ${sectionTitle(t('playActivity'), escapeHtml(p.name))}

  ${playControlsCard(play)}

  <div class="grid lg:grid-cols-2 gap-5 mb-5">
    ${chartCard('difficultyChart', t('difficultyProgression'))}
    ${chartCard('outcomesChart', t('questionBreakdown'))}
  </div>

  ${adaptiveSummaryCard(p)}
  ${sessionListCard(play)}`;
}

function chartCard(canvasId, title) {
  return `
  <div class="card-textile rounded-2xl p-5">
    <h2 class="font-serif2 text-lg mb-3">${title}</h2>
    <div class="relative" style="height:260px">
      <canvas id="${canvasId}" role="img" aria-label="${escapeHtml(title)}"></canvas>
    </div>
  </div>`;
}

/* ------------------------------------------------------- the controls */

function playControlsCard(play) {
  if (!play) {
    return `<div class="card-textile rounded-2xl p-5 mb-5 text-sm text-inksoft">${t('noPlayToday')}</div>`;
  }
  const mins = Math.round(play.totalMs / 60000);
  return `
  <div class="card-textile rounded-2xl p-5 mb-5">
    <div class="grid gap-4 mb-4" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${kpi(t('sessionsUsedToday'), `${play.used} / ${play.allowed}`)}
      ${kpi(t('remainingSessions'), String(play.remaining))}
      ${kpi(t('totalPlayTime'), mins ? `${mins} min` : '—')}
      ${kpi(t('extraGranted'), play.granted ? `+${play.granted}` : '—')}
    </div>

    <div class="flex flex-wrap gap-3 items-end">
      <button onclick="grantExtraSession()" class="px-5 py-3 rounded-xl bg-maroon text-white font-semibold min-h-[44px]">
        ➕ ${t('grantExtraSession')}
      </button>
      <form onsubmit="return saveSessionLimit(event)" class="flex gap-2 items-end">
        <label class="text-sm text-inksoft">
          ${t('dailySessionLimit')}
          <input id="play-limit" type="number" min="1" max="10" value="${escapeHtml(play.baseAllowance)}"
            class="${inputCls} mt-1" style="width:90px">
        </label>
        <button class="px-4 py-3 rounded-xl border border-linec bg-white font-semibold min-h-[44px]">
          ${t('saveLimit')}
        </button>
      </form>
    </div>
    <p class="text-xs text-inksoft mt-3">
      ${t('sessionMinutesNote').replace('{n}', play.sessionMinutes)}
    </p>
  </div>`;
}

function kpi(label, value) {
  return `
  <div class="bg-[#F9F5EB] border border-linec rounded-xl p-3">
    <div class="text-xs text-inksoft mb-1">${label}</div>
    <div class="text-2xl font-serif2 text-maroonDark">${escapeHtml(value)}</div>
  </div>`;
}

async function grantExtraSession() {
  const res = await api.grantPlaySession(state.patientId);
  if (!res.ok) { showToast(res.error); return; }
  state.patient = { ...state.patient, play: res.data.play };
  showToast(res.data.message);
  render();
}

async function saveSessionLimit(e) {
  e.preventDefault();
  const value = Number(document.getElementById('play-limit').value);
  const res = await api.setPlayLimit(state.patientId, value);
  if (!res.ok) { showToast(res.error); return false; }
  state.patient = { ...state.patient, play: res.data.play };
  showToast(res.data.message);
  render();
  return false;
}

/* ------------------------------------------------- the adaptive summary */

function adaptiveSummaryCard(patient) {
  const sessions = adaptiveSessions(patient);
  if (!sessions.length) {
    return `<div class="card-textile rounded-2xl p-5 mb-5">
      <h2 class="font-serif2 text-lg mb-2">${t('adaptiveStatus')}</h2>
      <p class="text-sm text-inksoft">${t('notEnoughDataYet')}</p>
    </div>`;
  }

  const latest = sessions[sessions.length - 1];
  const scores = sessions.map((s) => s.adaptiveScore).filter((n) => n != null);
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const highest = Math.max(...sessions.map((s) => s.maxLevel || s.level || 1));
  const started = sessions[0].startLevel || sessions[0].level || 1;
  const hints = sessions.reduce((a, s) => a + (s.hintsUsed || 0), 0);
  const skips = sessions.reduce((a, s) => a + (s.skippedCount || 0), 0);
  const timeouts = sessions.reduce((a, s) => a + (s.timeoutCount || 0), 0);

  return `
  <div class="card-textile rounded-2xl p-5 mb-5">
    <h2 class="font-serif2 text-lg mb-3">${t('adaptiveStatus')}</h2>
    <div class="flex flex-wrap gap-2 mb-4">
      ${statusPill(latest.adaptiveStatus)}
      ${latest.adaptiveBand ? bandPill(latest.adaptiveBand) : ''}
    </div>
    <div class="grid gap-4" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
      ${kpi(t('performanceScore'), avgScore === null ? '—' : String(avgScore))}
      ${kpi(t('startingDifficulty'), difficultyLabel(started))}
      ${kpi(t('highestDifficulty'), difficultyLabel(highest))}
      ${kpi(t('recommendedDifficulty'), difficultyLabel(latest.endLevel || latest.level || 1))}
      ${kpi(t('hintsUsed'), String(hints))}
      ${kpi(t('questionsSkipped'), String(skips))}
      ${kpi(t('timedOut'), String(timeouts))}
    </div>
  </div>`;
}

function statusPill(status) {
  if (!status) return '';
  const tone = {
    improving: 'bg-[#EAF3E8] text-leafgreen',
    difficulty_increased: 'bg-[#EAF3E8] text-leafgreen',
    stable: 'bg-[#EDE7D8] text-inksoft',
    difficulty_reduced: 'bg-[#FFF6E5] text-ochre',
    needs_assistance: 'bg-[#FBEAE7] text-alertc',
  }[status] || 'bg-[#EDE7D8] text-inksoft';
  return `<span class="px-3 py-1.5 rounded-full text-sm font-semibold ${tone}">${t('status_' + status)}</span>`;
}

function bandPill(band) {
  const tone = {
    excellent: 'bg-[#EAF3E8] text-leafgreen',
    good: 'bg-[#EAF3E8] text-leafgreen',
    steady: 'bg-[#EDE7D8] text-inksoft',
    needs_support: 'bg-[#FFF6E5] text-ochre',
  }[band] || 'bg-[#EDE7D8] text-inksoft';
  return `<span class="px-3 py-1.5 rounded-full text-sm font-semibold ${tone}">${t('band_' + band)}</span>`;
}

/* ------------------------------------------------------ session history */

function sessionListCard(play) {
  const rows = (play && play.sessions) || [];
  return `
  <div class="card-textile rounded-2xl p-5 mb-5">
    <h2 class="font-serif2 text-lg mb-3">${t('sessionAnalytics')}</h2>
    ${rows.length === 0
    ? `<p class="text-sm text-inksoft">${t('noPlayToday')}</p>`
    : `<div class="overflow-x-auto">
        <table class="w-full min-w-[480px] text-sm">
          <thead>
            <tr class="text-left text-xs text-inksoft border-b border-linec">
              <th class="pb-2 font-medium">${t('sessionN').replace('{n}', '#')}</th>
              <th class="pb-2 font-medium">${t('time')}</th>
              <th class="pb-2 font-medium">${t('duration')}</th>
              <th class="pb-2 font-medium">${t('activities')}</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((r, i) => `
            <tr class="border-b border-linec/60">
              <td class="py-2">${i + 1}</td>
              <td class="py-2">${fmtTime(r.startedAt)}</td>
              <td class="py-2">${r.durationMs ? Math.max(1, Math.round(r.durationMs / 60000)) + ' min' : '—'}</td>
              <td class="py-2">${r.gamesPlayed || 0}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`}
  </div>`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
