// analysis_engine.js — the deterministic, data-driven analysis behind the
// caregiver dashboard's "AI Insights" panel and the reports.
//
// This is NOT text generation dressed up as analysis. Every sentence it
// produces is derived from stored rows — session accuracy over time, per
// domain averages, measured response times, how often the patient is
// active, and reminder outcomes — and each finding carries the numbers it
// came from so a caregiver can check it.
//
// An LLM write-up can be layered ON TOP of this (routes/analysis.js) when
// ANTHROPIC_API_KEY is set, but the findings themselves never depend on it:
// with no key, no network, or a failed call, the analysis is unchanged.
//
// SAFETY: this engine describes observed in-app activity. It never states
// or implies a diagnosis, never says a condition is present, absent, or
// worsening, and never gives medical advice. Wording is fixed in this file
// precisely so that it cannot drift.

const { db, DOMAIN_LABELS, DOMAINS } = require('./database');

// Thresholds are named so the reasoning is visible rather than buried in
// magic numbers scattered through the code.
const MIN_SESSIONS_FOR_TREND = 3;      // below this, no trend is claimed
const TREND_DELTA = 0.05;              // 5 percentage points counts as a move
const STRONG_ACCURACY = 0.75;          // consistently good
const WATCH_ACCURACY = 0.5;            // worth a closer look
const SLOW_RESPONSE_SECONDS = 8;       // guide used by this app, not a clinical figure
const RESPONSE_SLOWDOWN_RATIO = 1.25;  // 25% slower than the earlier half
const STRONG_ADHERENCE = 80;
const WATCH_ADHERENCE = 60;
const ACTIVE_DAYS_WINDOW = 14;
const LOW_ACTIVITY_SESSIONS = 3;

const TREND = {
  IMPROVING: 'improving',
  DECLINING: 'declining',
  STABLE: 'stable',
  INSUFFICIENT: 'insufficient_data',
};

const TREND_LABELS = {
  improving: 'Improving',
  declining: 'Declining',
  stable: 'Stable',
  insufficient_data: 'Insufficient data',
};

const INSUFFICIENT_MESSAGE =
  'Not enough data is available to generate a reliable trend analysis.';

const DISCLAIMER =
  'This is a summary of activity recorded inside the app. It is an observation of '
  + 'in-app performance, not a medical assessment or diagnosis. Please discuss any '
  + 'concerns with the patient\'s doctor or ASHA worker.';

/* --------------------------------------------------------------- helpers */

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(value) {
  return value == null ? null : Math.round(value * 100);
}

function seconds(ms) {
  return ms == null ? null : +(ms / 1000).toFixed(1);
}

/**
 * Compares the first half of a series with the second half. Halves rather
 * than first-vs-last so one unusually good or bad session cannot flip the
 * verdict on its own.
 */
function halfSplitTrend(values, delta = TREND_DELTA) {
  if (values.length < MIN_SESSIONS_FOR_TREND) return { trend: TREND.INSUFFICIENT, change: null };
  const mid = Math.floor(values.length / 2);
  const earlier = mean(values.slice(0, mid));
  const later = mean(values.slice(values.length - mid));
  const change = later - earlier;
  if (change >= delta) return { trend: TREND.IMPROVING, change, earlier, later };
  if (change <= -delta) return { trend: TREND.DECLINING, change, earlier, later };
  return { trend: TREND.STABLE, change, earlier, later };
}

function label(domain) {
  return DOMAIN_LABELS[domain] || domain;
}

/* ----------------------------------------------------------- data gather */

/**
 * Reads everything the analysis needs in one place, so the reasoning below
 * works on plain numbers and can be unit-tested without a database.
 */
function gatherEvidence(patientId, { from = 0, to = Date.now() } = {}) {
  const patient = db.prepare('SELECT id, username, name, age, gender FROM patients WHERE id=?').get(patientId);
  if (!patient) return null;

  const sessions = db.prepare(
    `SELECT domain, game_type, level, score, total_rounds, accuracy, avg_time_ms, completed_at
     FROM sessions WHERE patient_id=? AND completed_at BETWEEN ? AND ?
     ORDER BY completed_at ASC`
  ).all(patientId, from, to);

  const reminders = db.prepare(
    `SELECT status, due_date, updated_at FROM reminders WHERE patient_id=?`
  ).all(patientId);

  const completed = reminders.filter((r) => r.status === 'done').length;
  const missed = reminders.filter((r) => r.status === 'missed').length;
  const snoozed = reminders.filter((r) => r.status === 'snoozed').length;
  const pending = reminders.filter((r) => r.status === 'pending').length;
  const settled = completed + missed;

  const byDomain = {};
  for (const d of DOMAINS) {
    const rows = sessions.filter((s) => s.domain === d);
    const accuracies = rows.map((s) => s.accuracy);
    byDomain[d] = {
      domain: d,
      label: label(d),
      sessions: rows.length,
      avgAccuracy: mean(accuracies),
      bestAccuracy: rows.length ? Math.max(...accuracies) : null,
      latestAccuracy: rows.length ? accuracies[accuracies.length - 1] : null,
      avgResponseMs: mean(rows.map((s) => s.avg_time_ms)),
      ...halfSplitTrend(accuracies),
    };
  }

  // How spread out the activity is: 5 sessions on one day is not the same
  // as 5 sessions across two weeks.
  const windowStart = Date.now() - ACTIVE_DAYS_WINDOW * 86400000;
  const recent = sessions.filter((s) => s.completed_at >= windowStart);
  const activeDays = new Set(recent.map((s) => new Date(s.completed_at).toDateString())).size;

  const accuracies = sessions.map((s) => s.accuracy);
  const responseTimes = sessions.map((s) => s.avg_time_ms);

  return {
    patient,
    period: { from, to },
    sessions,
    totals: {
      sessions: sessions.length,
      avgAccuracy: mean(accuracies),
      bestAccuracy: sessions.length ? Math.max(...accuracies) : null,
      latestAccuracy: sessions.length ? accuracies[accuracies.length - 1] : null,
      avgResponseMs: mean(responseTimes),
      firstSessionAt: sessions.length ? sessions[0].completed_at : null,
      lastSessionAt: sessions.length ? sessions[sessions.length - 1].completed_at : null,
    },
    accuracyTrend: halfSplitTrend(accuracies),
    // For response time a RISE is the unwelcome direction, so this is read
    // the other way round wherever it is used.
    responseTrend: halfSplitTrend(responseTimes.map((ms) => ms / 1000), 0.8),
    byDomain,
    activity: { activeDays, recentSessions: recent.length, windowDays: ACTIVE_DAYS_WINDOW },
    reminders: {
      total: reminders.length, completed, missed, snoozed, pending,
      adherence: settled ? Math.round((completed / settled) * 100) : null,
    },
  };
}

/* ------------------------------------------------------------- reasoning */

function buildStrengths(e) {
  const out = [];

  Object.values(e.byDomain)
    .filter((d) => d.sessions >= 2)
    .forEach((d) => {
      if (d.avgAccuracy >= STRONG_ACCURACY && d.trend !== TREND.DECLINING) {
        out.push({
          title: `${d.label} performance has remained consistent`,
          detail: `Average ${pct(d.avgAccuracy)}% across ${d.sessions} sessions, best ${pct(d.bestAccuracy)}%.`,
          metric: { domain: d.domain, avgAccuracy: pct(d.avgAccuracy), sessions: d.sessions },
        });
      } else if (d.trend === TREND.IMPROVING) {
        out.push({
          title: `${d.label} has improved over recent sessions`,
          detail: `Up from about ${pct(d.earlier)}% to ${pct(d.later)}% across ${d.sessions} sessions.`,
          metric: { domain: d.domain, from: pct(d.earlier), to: pct(d.later) },
        });
      }
    });

  if (e.reminders.adherence !== null && e.reminders.adherence >= STRONG_ADHERENCE) {
    out.push({
      title: 'Reminder adherence is strong',
      detail: `${e.reminders.completed} of ${e.reminders.completed + e.reminders.missed} reminders that came due were completed (${e.reminders.adherence}%).`,
      metric: { adherence: e.reminders.adherence },
    });
  }

  if (e.activity.activeDays >= 5) {
    out.push({
      title: 'Activities are being used regularly',
      detail: `${e.activity.recentSessions} sessions on ${e.activity.activeDays} different days in the last ${e.activity.windowDays} days.`,
      metric: { activeDays: e.activity.activeDays, recentSessions: e.activity.recentSessions },
    });
  }

  if (e.totals.avgResponseMs != null && seconds(e.totals.avgResponseMs) <= SLOW_RESPONSE_SECONDS
      && e.responseTrend.trend !== TREND.IMPROVING && e.totals.sessions >= MIN_SESSIONS_FOR_TREND) {
    out.push({
      title: 'Response times are steady',
      detail: `Averaging ${seconds(e.totals.avgResponseMs)}s per question.`,
      metric: { avgResponseSeconds: seconds(e.totals.avgResponseMs) },
    });
  }

  return out;
}

function buildAreasToWatch(e) {
  const out = [];

  // A rising response time is the "declining" direction for that series.
  if (e.responseTrend.trend === TREND.IMPROVING && e.totals.sessions >= MIN_SESSIONS_FOR_TREND) {
    const ratio = e.responseTrend.later / e.responseTrend.earlier;
    if (ratio >= RESPONSE_SLOWDOWN_RATIO) {
      out.push({
        title: 'Response time has increased over recent sessions',
        detail: `From about ${e.responseTrend.earlier.toFixed(1)}s to ${e.responseTrend.later.toFixed(1)}s per question.`,
        metric: { fromSeconds: +e.responseTrend.earlier.toFixed(1), toSeconds: +e.responseTrend.later.toFixed(1) },
      });
    }
  }

  Object.values(e.byDomain)
    .filter((d) => d.sessions >= 2)
    .forEach((d) => {
      if (d.trend === TREND.DECLINING) {
        out.push({
          title: `${d.label} scores have decreased recently`,
          detail: `From about ${pct(d.earlier)}% to ${pct(d.later)}% across ${d.sessions} sessions.`,
          metric: { domain: d.domain, from: pct(d.earlier), to: pct(d.later) },
        });
      } else if (d.avgAccuracy != null && d.avgAccuracy < WATCH_ACCURACY) {
        out.push({
          title: `${d.label} scores have been low`,
          detail: `Averaging ${pct(d.avgAccuracy)}% across ${d.sessions} sessions.`,
          metric: { domain: d.domain, avgAccuracy: pct(d.avgAccuracy) },
        });
      }
    });

  if (e.totals.avgResponseMs != null && seconds(e.totals.avgResponseMs) > SLOW_RESPONSE_SECONDS) {
    out.push({
      title: 'Answers are taking longer than the app\'s guide time',
      detail: `Averaging ${seconds(e.totals.avgResponseMs)}s per question, against a ${SLOW_RESPONSE_SECONDS}s guide.`,
      metric: { avgResponseSeconds: seconds(e.totals.avgResponseMs) },
    });
  }

  if (e.reminders.adherence !== null && e.reminders.adherence < WATCH_ADHERENCE) {
    out.push({
      title: 'Several reminders are being missed',
      detail: `${e.reminders.missed} of ${e.reminders.completed + e.reminders.missed} reminders that came due were not completed (${e.reminders.adherence}% adherence).`,
      metric: { adherence: e.reminders.adherence, missed: e.reminders.missed },
    });
  }

  if (e.reminders.snoozed >= 3) {
    out.push({
      title: 'Reminders are often snoozed',
      detail: `${e.reminders.snoozed} reminders are currently snoozed, which can mean the timing does not suit the daily routine.`,
      metric: { snoozed: e.reminders.snoozed },
    });
  }

  if (e.totals.sessions > 0 && e.activity.recentSessions < LOW_ACTIVITY_SESSIONS) {
    out.push({
      title: 'Activity has been infrequent recently',
      detail: `${e.activity.recentSessions} sessions in the last ${e.activity.windowDays} days.`,
      metric: { recentSessions: e.activity.recentSessions },
    });
  }

  const untouched = Object.values(e.byDomain).filter((d) => d.sessions === 0).map((d) => d.label);
  if (untouched.length && e.totals.sessions > 0) {
    out.push({
      title: `No activity recorded for ${untouched.join(', ')}`,
      detail: 'These areas have not been practised, so nothing can be said about them yet.',
      metric: { areas: untouched },
    });
  }

  return out;
}

function buildActions(e, strengths, areas) {
  const out = [];
  const has = (fragment) => areas.some((a) => a.title.toLowerCase().includes(fragment));

  if (has('response time') || has('longer')) {
    out.push('Allow more time to answer, and try sessions at a quieter time of day when the patient is rested.');
  }
  const declining = Object.values(e.byDomain).filter((d) => d.trend === TREND.DECLINING);
  if (declining.length) {
    out.push(`Try ${declining.map((d) => d.label).join(' and ')} at an easier level for a few sessions to rebuild confidence.`);
  }
  if (has('missed')) {
    out.push('Review the missed reminders with the patient and check whether the times match their daily routine.');
  }
  if (has('snoozed')) {
    out.push('Consider moving frequently snoozed reminders to a time that suits the household better.');
  }
  if (has('infrequent')) {
    out.push('Aim for a short session most days — regular short sessions show more than occasional long ones.');
  }
  const untouched = Object.values(e.byDomain).filter((d) => d.sessions === 0);
  if (untouched.length && e.totals.sessions > 0) {
    out.push(`Introduce ${untouched.map((d) => d.label).join(' and ')} so every area has something to compare.`);
  }

  if (!out.length) {
    out.push('Continue the current routine of regular cognitive activities.');
    out.push('Keep daily routines and reminder times consistent.');
  }
  // Always present, and deliberately non-clinical.
  out.push('Share this summary with the doctor or ASHA worker at the next visit.');
  return out;
}

function buildHeadline(e, overallTrend) {
  if (overallTrend === TREND.INSUFFICIENT) return INSUFFICIENT_MESSAGE;
  const acc = pct(e.totals.avgAccuracy);
  if (overallTrend === TREND.IMPROVING) {
    return `Recent in-app performance is improving; the average score across ${e.totals.sessions} sessions is ${acc}%.`;
  }
  if (overallTrend === TREND.DECLINING) {
    return `Recent in-app scores are lower than earlier ones; the average across ${e.totals.sessions} sessions is ${acc}%.`;
  }
  return `Recent in-app performance is stable; the average score across ${e.totals.sessions} sessions is ${acc}%.`;
}

/* ----------------------------------------------------------------- entry */

/**
 * analysePatient — the whole engine. Pure with respect to the database:
 * same stored rows in, same analysis out, every time.
 */
function analysePatient(patientId, period) {
  const e = gatherEvidence(patientId, period);
  if (!e) return null;

  const enoughData = e.totals.sessions >= MIN_SESSIONS_FOR_TREND;
  const overallTrend = enoughData ? e.accuracyTrend.trend : TREND.INSUFFICIENT;

  // With too little activity we say exactly that, and stop — no invented
  // strengths, no speculative concerns.
  if (!enoughData) {
    return {
      generatedAt: Date.now(),
      source: 'engine',
      patient: { id: e.patient.id, name: e.patient.name, username: e.patient.username },
      period: e.period,
      overallTrend,
      overallTrendLabel: TREND_LABELS[overallTrend],
      headline: INSUFFICIENT_MESSAGE,
      summary: e.totals.sessions === 0
        ? 'No cognitive activities have been completed yet.'
        : `Only ${e.totals.sessions} session(s) recorded so far. At least ${MIN_SESSIONS_FOR_TREND} are needed before a trend can be described.`,
      strengths: [],
      areasToWatch: [],
      recommendedActions: [
        'Sit with the patient for one short session of each activity to establish a baseline.',
        'Keep daily routines and reminder times consistent.',
      ],
      evidence: e,
      disclaimer: DISCLAIMER,
    };
  }

  const strengths = buildStrengths(e);
  const areasToWatch = buildAreasToWatch(e);
  const recommendedActions = buildActions(e, strengths, areasToWatch);

  return {
    generatedAt: Date.now(),
    source: 'engine',
    patient: { id: e.patient.id, name: e.patient.name, username: e.patient.username },
    period: e.period,
    overallTrend,
    overallTrendLabel: TREND_LABELS[overallTrend],
    headline: buildHeadline(e, overallTrend),
    summary: `${e.totals.sessions} sessions between `
      + `${new Date(e.totals.firstSessionAt).toLocaleDateString()} and `
      + `${new Date(e.totals.lastSessionAt).toLocaleDateString()}, `
      + `averaging ${pct(e.totals.avgAccuracy)}% at ${seconds(e.totals.avgResponseMs)}s per question.`,
    strengths: strengths.length ? strengths : [{
      title: 'No clear strengths stand out yet',
      detail: 'More sessions will make consistent areas easier to identify.',
      metric: {},
    }],
    areasToWatch: areasToWatch.length ? areasToWatch : [{
      title: 'Nothing needs attention from the recorded activity',
      detail: 'Scores, response times and reminder adherence are all within the ranges this app watches for.',
      metric: {},
    }],
    recommendedActions,
    evidence: e,
    disclaimer: DISCLAIMER,
  };
}

module.exports = {
  analysePatient, gatherEvidence, halfSplitTrend,
  TREND, TREND_LABELS, INSUFFICIENT_MESSAGE, DISCLAIMER,
  MIN_SESSIONS_FOR_TREND,
};
